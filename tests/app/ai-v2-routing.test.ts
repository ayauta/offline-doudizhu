/**
 * The production routing contract for AI-v2, at the Worker.
 *
 * AI-v2 is the CHEAP full-action landlord policy plus the π1 farmer selector,
 * and both are installed by `src/platform/web/ai-worker.ts` from the request
 * the session sends. This file is the permanent guard for that routing: it
 * drives the **real Worker module** through the same `globalThis` message
 * handler the browser calls, so a change that leaves either policy as dead
 * code — the exact failure this promotion fixed — fails here rather than in a
 * player's match.
 *
 * It is deliberately separate from the handler-level guards in
 * `cheap-landlord-routing.test.ts`. Those prove `decideEnhancedAi` gates on
 * seat and tier; they cannot prove the Worker installs the policy at all,
 * because they hand it the runtime themselves.
 *
 * Three things are asserted, and the third is the one that is easy to lose:
 *
 *   1. a master landlord with the flag plays exactly the research reference;
 *   2. `casual` gets the same answer with and without the flag — the weaker
 *      product tiers are not this promotion's business;
 *   3. the flag is what installs the policy, not the tier alone, so a request
 *      that omits it keeps the pre-promotion behaviour.
 */
import { describe, expect, it } from "vitest";

import { SEAT_ORDER, transition, type GameState, type Seat } from "../../src/core/game/index.js";
import { generateLegalActions } from "../../src/core/rules/index.js";
import { createPlayerView, DEFAULT_AI_STRATEGY, type AiDecisionContext } from "../../src/core/ai/index.js";
import { cfActionCommand, cfCommandKey } from "../../src/app/ai/cf-selector.js";
import { parseTreeModel } from "../../src/core/ai/cf-model.js";
import { CHEAP_LANDLORD_MODEL_JSON, CHEAP_LANDLORD_MODEL_SHA256 } from "../../src/app/ai/cheap-landlord-model.js";
import type { EnhancedAiWorkerRequest, EnhancedAiWorkerResponse } from "../../src/app/ai/decision-handler.js";
import { dealDeck, startWithLandlord } from "../../benchmarks/ai-tournament.js";
import { scoreLegalActions } from "../../benchmarks/selfplay-policy.js";

type PlayDecisionContext = Extract<AiDecisionContext, { readonly kind: "play" }>;

const DEAL_SEED = 5001;
const LANDLORD: Seat = "ai-one";

function playable(state: GameState): Extract<GameState, { readonly phase: "ready-to-play" | "playing" }> {
  if (state.phase !== "playing" && state.phase !== "ready-to-play") {
    throw new Error(`Fixture expected a playable state, saw ${state.phase}.`);
  }
  return state;
}

function playContext(state: GameState, seat: Seat): PlayDecisionContext {
  const view = createPlayerView(state, seat);
  if (view === null || view.phase === "bidding") {
    throw new Error("Fixture expected a playing view.");
  }
  return Object.freeze({
    kind: "play",
    view,
    legalActions: generateLegalActions({ hand: view.hand, currentPlay: view.currentPlay }),
  });
}

/** A real landlord decision with more than one legal action to choose between. */
function landlordContext(dealSeed: number = DEAL_SEED): PlayDecisionContext {
  let state = startWithLandlord(dealDeck(dealSeed), LANDLORD);
  for (let ply = 0; ply < 200; ply += 1) {
    if (state.phase === "finished") {
      break;
    }
    const mover = playable(state).currentSeat;
    if (mover === LANDLORD && playable(state).landlord === LANDLORD) {
      const context = playContext(state, LANDLORD);
      if (context.legalActions.length >= 2) {
        return context;
      }
    }
    const result = transition(state, DEFAULT_AI_STRATEGY.chooseCommand(playContext(state, mover)));
    if (!result.ok) {
      throw new Error(`Fixture played an illegal command: ${result.error.code}.`);
    }
    state = result.state;
  }
  throw new Error("No landlord decision was reached.");
}

type WorkerScope = {
  postMessage: (response: EnhancedAiWorkerResponse) => void;
  onmessage: ((event: { data: EnhancedAiWorkerRequest }) => void) | null;
};

/**
 * The shipped Worker, driven the way the browser drives it.
 *
 * The module is imported exactly once and its handler captured, because
 * `ai-worker.ts` assigns `globalThis.onmessage` as an import side effect. A
 * helper that re-imported per call would get the cached module, run no side
 * effect, and then find no handler — which looks like broken routing rather
 * than a test that reset the seam out from under itself.
 */
let workerHandler: ((event: { data: EnhancedAiWorkerRequest }) => void) | null = null;

async function driveWorker(
  requests: readonly EnhancedAiWorkerRequest[],
): Promise<readonly EnhancedAiWorkerResponse[]> {
  const posted: EnhancedAiWorkerResponse[] = [];
  const scope = globalThis as unknown as WorkerScope;
  const previous = scope.postMessage;
  scope.postMessage = (response) => {
    posted.push(response);
  };
  try {
    if (workerHandler === null) {
      await import("../../src/platform/web/ai-worker.js");
      workerHandler = scope.onmessage;
      if (workerHandler === null) {
        throw new Error("ai-worker.ts did not install a message handler on globalThis.");
      }
    }
    for (const request of requests) {
      workerHandler({ data: request });
    }
  } finally {
    scope.postMessage = previous;
  }
  return posted;
}

function commandOf(response: EnhancedAiWorkerResponse | undefined): string {
  if (response === undefined || response.outcome.ok !== true) {
    throw new Error(`Expected an ok outcome, saw ${JSON.stringify(response)}`);
  }
  return cfCommandKey(response.outcome.command);
}

const context = landlordContext();

describe("AI-v2 production routing", () => {
  it("gives a master landlord exactly the confirmed policy's action", async () => {
    // The strongest statement this file can make: the shipped Worker's answer
    // is the research reference's answer, computed here from the same model.
    const table = CHEAP_LANDLORD_MODEL_JSON;
    expect(table).not.toBeNull();
    const model = parseTreeModel(JSON.parse(table as string));
    const reference = scoreLegalActions(context.view, model, context.legalActions);
    const expected = reference.actions[reference.chosenIndex];
    expect(expected).toBeDefined();

    const [response] = await driveWorker([
      { requestId: 1, aiType: "master", context, seed: 1, cheapLandlord: true },
    ]);
    expect(commandOf(response)).toBe(
      cfCommandKey(cfActionCommand(context.view.seat, reference.actions[reference.chosenIndex]!)),
    );
    expect(CHEAP_LANDLORD_MODEL_SHA256).toBe(
      "070f5b0b728176a8fb11d6a79e585b1315b847e053a23821830e17394faac26b",
    );
  });

  it("leaves the casual tier exactly as it was, flag or no flag", async () => {
    const [plain, flagged] = await driveWorker([
      { requestId: 1, aiType: "casual", context, seed: 1 },
      { requestId: 2, aiType: "casual", context, seed: 1, cheapLandlord: true },
    ]);
    expect(commandOf(flagged)).toBe(commandOf(plain));
  });

  it("installs the policy only when the request asks for it", async () => {
    /*
     * The failure this guards is the one the promotion fixed: a policy that is
     * built, packaged and reachable in tests, but never installed because
     * nothing sends the flag. Tier alone must not be enough.
     *
     * Sampled over several deals rather than one, because the two policies
     * genuinely agree on some states -- master's rollout picks the same action
     * the full-action policy does -- so a single state proves nothing either
     * way. What is asserted is the shape: flagged matches the reference every
     * time, unflagged misses it at least once.
     */
    const table = CHEAP_LANDLORD_MODEL_JSON as string;
    const model = parseTreeModel(JSON.parse(table));
    const seeds = [5001, 5010, 5020, 5030, 5040, 5060];
    const contexts = seeds.map((seed) => landlordContext(seed));
    const requests: EnhancedAiWorkerRequest[] = contexts.flatMap((each, index) => [
      { requestId: index * 2 + 1, aiType: "master" as const, context: each, seed: 1, cheapLandlord: true },
      { requestId: index * 2 + 2, aiType: "master" as const, context: each, seed: 1 },
    ]);
    const responses = await driveWorker(requests);
    expect(responses).toHaveLength(requests.length);

    let flaggedMatched = 0;
    let unflaggedMissed = 0;
    for (let index = 0; index < contexts.length; index += 1) {
      const each = contexts[index]!;
      const reference = scoreLegalActions(each.view, model, each.legalActions);
      const expected = cfCommandKey(
        cfActionCommand(each.view.seat, reference.actions[reference.chosenIndex]!),
      );
      if (commandOf(responses[index * 2]) === expected) flaggedMatched += 1;
      if (commandOf(responses[index * 2 + 1]) !== expected) unflaggedMissed += 1;
    }
    expect(flaggedMatched).toBe(contexts.length);
    expect(unflaggedMissed).toBeGreaterThan(0);
  });

  it("still decides a farmer seat without the landlord branch", async () => {
    const farmerSeat = SEAT_ORDER.find((seat) => seat !== LANDLORD);
    expect(farmerSeat).toBeDefined();
    // A farmer context must come back ok as well: the landlord branch declines
    // for a non-landlord seat and the production path answers.
    let state = startWithLandlord(dealDeck(DEAL_SEED), LANDLORD);
    let farmerContext: PlayDecisionContext | null = null;
    for (let ply = 0; ply < 200 && farmerContext === null; ply += 1) {
      if (state.phase === "finished") {
        break;
      }
      const mover = playable(state).currentSeat;
      if (mover === farmerSeat) {
        farmerContext = playContext(state, farmerSeat!);
        break;
      }
      const result = transition(state, DEFAULT_AI_STRATEGY.chooseCommand(playContext(state, mover)));
      if (!result.ok) {
        throw new Error(`Fixture played an illegal command: ${result.error.code}.`);
      }
      state = result.state;
    }
    expect(farmerContext).not.toBeNull();
    const [response] = await driveWorker([
      { requestId: 1, aiType: "master", context: farmerContext!, seed: 1, cheapLandlord: true },
    ]);
    expect(response?.outcome.ok).toBe(true);
  });
});
