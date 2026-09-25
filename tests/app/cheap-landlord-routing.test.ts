/**
 * The CHEAP landlord policy's routing and refusal rules, on synthetic models.
 *
 * This file runs inside `pnpm check`, so it cannot depend on the 2.0 MB
 * candidate: the model file lives under `.local/` and only exists on a machine
 * that has trained it. The heavy, real-model work is
 * `benchmarks/cheap-integration.test.ts`; what belongs here is everything that
 * is a property of the *code* rather than of the weights.
 *
 * Two of these guards are here precisely because the real-model run could not
 * cover them. Across 1402 real landlord states the candidate never once
 * produced an exact top-two tie, so "a tie goes to the earliest position" was
 * untested by the integration harness — a constant model makes every decision a
 * tie. And no real state exercised a schema mismatch, because the shipped model
 * is on the right schema by construction; an 86-column model does, which is the
 * failure this guard exists for: `scoreTrees` walks whatever width it is handed
 * and would otherwise read the wrong columns and return a confident number.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { SEAT_ORDER, transition, type GameState, type Seat } from "../../src/core/game/index.js";
import { generateLegalActions } from "../../src/core/rules/index.js";
import { parseTreeModel, type TreeModel } from "../../src/core/ai/cf-model.js";
import { createPlayerView, DEFAULT_AI_STRATEGY, type AiDecisionContext } from "../../src/core/ai/index.js";
import { CF_FEATURE_NAMES } from "../../src/core/ai/cf-features.js";
import { SELFPLAY_FEATURE_COUNT, SELFPLAY_FEATURE_NAMES } from "../../src/core/ai/fa-features.js";
import { cheapLandlordDecision, landlordArgmax } from "../../src/app/ai/cheap-landlord.js";
import { decideEnhancedAi } from "../../src/app/ai/decision-handler.js";
import { cfCommandKey } from "../../src/app/ai/cf-selector.js";
import { CHEAP_LANDLORD_MODEL_JSON, CHEAP_LANDLORD_MODEL_SHA256 } from "../../src/app/ai/cheap-landlord-model.js";
import { dealDeck, startWithLandlord } from "../../benchmarks/ai-tournament.js";
import { createPi1Bundle } from "../../benchmarks/selfplay-policy.js";

type PlayDecisionContext = Extract<AiDecisionContext, { kind: "play" }>;

const FROZEN_SHA256 = "070f5b0b728176a8fb11d6a79e585b1315b847e053a23821830e17394faac26b";

/** Every action scores the same, so every decision is a real tie. */
function constantModel(value: number, columns = SELFPLAY_FEATURE_COUNT): TreeModel {
  return parseTreeModel({
    formatVersion: 1,
    lightgbmVersion: "test",
    modelSha256: "test",
    numTrees: 1,
    numFeatures: columns,
    featureNames: columns === SELFPLAY_FEATURE_COUNT ? [...SELFPLAY_FEATURE_NAMES] : [...CF_FEATURE_NAMES],
    trees: [
      { feature: [-1], threshold: [0], defaultLeft: [0], missingZero: [0], left: [0], right: [0], value: [value] },
    ],
  });
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

/** Narrows away the phases that have no seats, the way the sibling test does. */
function playable(state: GameState): Extract<GameState, { readonly phase: "ready-to-play" | "playing" }> {
  if (state.phase !== "playing" && state.phase !== "ready-to-play") {
    throw new Error(`Fixture expected a playable state, saw ${state.phase}.`);
  }
  return state;
}

/** The first context in which `seat` is the landlord and it is their turn. */
function landlordContext(dealSeed: number, seat: Seat): PlayDecisionContext {
  let state = startWithLandlord(dealDeck(dealSeed), seat);
  for (let ply = 0; ply < 200; ply += 1) {
    if (state.phase === "finished") {
      break;
    }
    const mover = playable(state).currentSeat;
    if (mover === seat && seat === playable(state).landlord) {
      const context = playContext(state, seat);
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
  throw new Error(`No landlord decision was reached for seat ${seat}.`);
}

/** A context where `seat` is a farmer. */
function farmerContext(dealSeed: number, landlord: Seat): PlayDecisionContext {
  const farmer = SEAT_ORDER.find((candidate) => candidate !== landlord);
  if (farmer === undefined) {
    throw new Error("Fixture found no farmer seat.");
  }
  let state = startWithLandlord(dealDeck(dealSeed), landlord);
  for (let ply = 0; ply < 200; ply += 1) {
    if (state.phase === "finished") {
      break;
    }
    const mover = playable(state).currentSeat;
    if (mover === farmer) {
      return playContext(state, farmer);
    }
    const result = transition(state, DEFAULT_AI_STRATEGY.chooseCommand(playContext(state, mover)));
    if (!result.ok) {
      throw new Error(`Fixture played an illegal command: ${result.error.code}.`);
    }
    state = result.state;
  }
  throw new Error("No farmer decision was reached.");
}

describe("landlordArgmax", () => {
  it("keeps the earliest index on a tie, which is the frozen tie-break", () => {
    expect(landlordArgmax([1, 1, 1])).toBe(0);
    expect(landlordArgmax([1, 2, 2])).toBe(1);
    expect(landlordArgmax([3, 2, 3, 3])).toBe(0);
    expect(landlordArgmax([0, -1, -2])).toBe(0);
    // `>=` instead of `>` would give 2, and `reduce(Math.max)` would give 0 here
    // for the wrong reason. The rule is "strictly greater", stated as a test.
    expect(landlordArgmax([1, 1, 2, 2, 1])).toBe(2);
  });
});

describe("the release candidate packages the confirmed table", () => {
  it("carries the frozen bytes under the frozen digest", () => {
    // The released tree ships the model: a green build against a stubbed table
    // would say nothing about what leaves the door. `--stub` still exists for a
    // size measurement, so the guard checks the bytes rather than trusting the
    // file's name.
    expect(CHEAP_LANDLORD_MODEL_JSON).not.toBeNull();
    expect(CHEAP_LANDLORD_MODEL_SHA256).toBe(FROZEN_SHA256);
    const table = CHEAP_LANDLORD_MODEL_JSON ?? "";
    expect(
      createHash("sha256").update(Buffer.from(table, "utf8")).digest("hex"),
    ).toBe(FROZEN_SHA256);
    const parsed = JSON.parse(table) as { numTrees: number; numFeatures: number };
    expect(parsed.numFeatures).toBe(403);
    expect(parsed.numTrees).toBe(512);
  });
});

describe("cheapLandlordDecision scope and refusals", () => {
  const model = constantModel(0.5);

  it("declines a farmer seat and a bid without scoring anything", () => {
    const context = farmerContext(5001, "ai-one");
    const decision = cheapLandlordDecision(context, { model, modelSha256: FROZEN_SHA256 });
    expect(decision.kind).toBe("declined");
    if (decision.kind === "declined") {
      expect(decision.reason).toBe("out-of-scope");
      expect(decision.timing.featureMs).toBe(0);
      expect(decision.timing.inferenceMs).toBe(0);
    }
  });

  it("declines an empty legal set rather than returning index 0 of nothing", () => {
    const context = landlordContext(5001, "ai-one");
    const empty = Object.freeze({ ...context, legalActions: Object.freeze([]) });
    const decision = cheapLandlordDecision(empty, { model, modelSha256: FROZEN_SHA256 });
    expect(decision.kind).toBe("declined");
    if (decision.kind === "declined") {
      expect(decision.reason).toBe("empty-legal-set");
    }
  });

  it("declines a model built on the old 86-column schema instead of scoring it", () => {
    // The risk this guards: `scoreTrees` does not know how wide a row should be,
    // so an 86-column model would read the first 86 of 403 columns and return a
    // confident, meaningless number.
    const wrongSchema = constantModel(0.5, CF_FEATURE_NAMES.length);
    const context = landlordContext(5001, "ai-one");
    const decision = cheapLandlordDecision(context, { model: wrongSchema, modelSha256: FROZEN_SHA256 });
    expect(decision.kind).toBe("declined");
    if (decision.kind === "declined") {
      expect(decision.reason).toBe("schema-mismatch");
    }
  });

  it("scores every legal action and ties go to the earliest", () => {
    for (const seed of [5001, 5010, 5020]) {
      const context = landlordContext(seed, "ai-one");
      const decision = cheapLandlordDecision(context, { model, modelSha256: FROZEN_SHA256 });
      expect(decision.kind).toBe("cheap");
      if (decision.kind !== "cheap") {
        continue;
      }
      // The full legal set, never a shortlist. A reintroduced `slice(0, 3)`
      // would keep this test green only while every state had ≤ 3 actions.
      expect(decision.scored).toBe(context.legalActions.length);
      expect(decision.chosenIndex).toBe(0);
      expect(decision.margin).toBe(0);
      const first = context.legalActions[0];
      expect(first).toBeDefined();
      if (first !== undefined) {
        expect(cfCommandKey(decision.command)).toBe(
          cfCommandKey(
            first.type === "pass"
              ? Object.freeze({ type: "pass" as const, seat: context.view.seat })
              : Object.freeze({
                  type: "play" as const,
                  seat: context.view.seat,
                  cards: Object.freeze([...first.play.cards]),
                }),
          ),
        );
      }
    }
  });

  it("reaches a wide legal set, so 'scores everything' is not vacuous", () => {
    const widths = [5001, 5010, 5020, 5030, 5040, 5060].map(
      (seed) => landlordContext(seed, "ai-one").legalActions.length,
    );
    expect(Math.max(...widths)).toBeGreaterThan(3);
  });
});

describe("the Worker routes the landlord branch and leaves everything else alone", () => {
  const model = constantModel(0.25);
  /** The runtime shape the Worker builds; see `decision-handler.ts`. */
  const runtimeFor = (policy: TreeModel) =>
    Object.freeze({
      modelSha256: FROZEN_SHA256,
      decide: (context: PlayDecisionContext) =>
        cheapLandlordDecision(context, { model: policy, modelSha256: FROZEN_SHA256 }),
    });
  const landlord = runtimeFor(model);
  /*
   * `exactOptionalPropertyTypes` is on, so "no landlord policy installed" is an
   * absent key rather than a key set to `undefined` — which is also what the
   * shipped Worker does.
   */
  const plainRuntime = { deadline: Number.MAX_SAFE_INTEGER, now: () => 0 };

  function request(context: PlayDecisionContext, aiType: "master" | "casual", cheapLandlord: boolean) {
    return Object.freeze({ requestId: 1, aiType, context, seed: 1, ...(cheapLandlord ? { cheapLandlord: true } : {}) });
  }

  it("plays the policy's command for a master landlord", () => {
    const context = landlordContext(5001, "ai-one");
    const outcome = decideEnhancedAi(request(context, "master", true), {
      deadline: Number.MAX_SAFE_INTEGER,
      now: () => 0,
      landlord,
    });
    const expected = cheapLandlordDecision(context, { model, modelSha256: FROZEN_SHA256 });
    expect(expected.kind).toBe("cheap");
    expect(outcome.ok).toBe(true);
    if (outcome.ok && expected.kind === "cheap") {
      expect(cfCommandKey(outcome.command)).toBe(cfCommandKey(expected.command));
    }
  });

  it("leaves a master landlord on its own path when the flag is absent", () => {
    const context = landlordContext(5001, "ai-one");
    const runtime = { deadline: Number.MAX_SAFE_INTEGER, now: () => 0, landlord };
    const without = decideEnhancedAi(request(context, "master", false), plainRuntime);
    const withFlag = decideEnhancedAi(request(context, "master", true), runtime);
    // They may coincide on a given state; the point is that the un-flagged
    // request must not have reached the policy, which the diff below shows by
    // the flag changing the answer on at least one sampled state.
    let differed = cfCommandKey(commandOf(without)) !== cfCommandKey(commandOf(withFlag));
    for (const seed of [5010, 5020, 5030]) {
      const other = landlordContext(seed, "ai-one");
      const a = decideEnhancedAi(request(other, "master", false), plainRuntime);
      const b = decideEnhancedAi(request(other, "master", true), runtime);
      if (cfCommandKey(commandOf(a)) !== cfCommandKey(commandOf(b))) {
        differed = true;
      }
    }
    expect(differed).toBe(true);
  });

  it("never runs for casual, even with the flag set", () => {
    const context = landlordContext(5001, "ai-one");
    const runtime = { deadline: Number.MAX_SAFE_INTEGER, now: () => 0, landlord };
    const plain = decideEnhancedAi(request(context, "casual", false), plainRuntime);
    const flagged = decideEnhancedAi(request(context, "casual", true), runtime);
    expect(cfCommandKey(commandOf(flagged))).toBe(cfCommandKey(commandOf(plain)));
  });

  it("never runs for a farmer, even with the flag set", () => {
    const context = farmerContext(5001, "ai-one");
    const runtime = { deadline: Number.MAX_SAFE_INTEGER, now: () => 0, landlord };
    const plain = decideEnhancedAi(request(context, "master", false), plainRuntime);
    const flagged = decideEnhancedAi(request(context, "master", true), runtime);
    expect(cfCommandKey(commandOf(flagged))).toBe(cfCommandKey(commandOf(plain)));
  });

  it("falls through to production when the policy refuses", () => {
    const context = landlordContext(5001, "ai-one");
    const wrongSchema = runtimeFor(constantModel(0.25, CF_FEATURE_NAMES.length));
    const production = decideEnhancedAi(request(context, "master", false), plainRuntime);
    const refused = decideEnhancedAi(request(context, "master", true), { ...plainRuntime, landlord: wrongSchema });
    expect(cfCommandKey(commandOf(refused))).toBe(cfCommandKey(commandOf(production)));
  });
});

/** Keeps the pi1 import meaningful: the farmer baseline is a real bundle. */
void createPi1Bundle;

function commandOf(outcome: ReturnType<typeof decideEnhancedAi>) {
  if (outcome.ok !== true) {
    throw new Error(`Expected an ok outcome, saw ${JSON.stringify(outcome)}.`);
  }
  return outcome.command;
}
