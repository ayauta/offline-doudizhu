/**
 * The CHEAP landlord product integration prototype: equivalence, latency and
 * deadline retention.
 *
 *     CHEAP_LANDLORD_BUILD=1 AI_CHEAP_INTEGRATION=1 \
 *       npx vitest run --config vitest.benchmark.config.ts \
 *         benchmarks/cheap-integration.test.ts
 *
 * The protocol is `research/full-action-selfplay-v1/cheap-integration-protocol.md`.
 * Everything below applies it; nothing below changes it.
 *
 * Two properties of this harness are worth stating because they are the
 * difference between a real integration test and a flattering one:
 *
 *   1. **The product path is the product module.** `src/platform/web/ai-worker.ts`
 *      is imported and driven through a `globalThis` shim, so the request goes
 *      through the same message handler the browser calls: the same lazy model
 *      parse, the same `decideEnhancedAi`, the same deadline arithmetic, the
 *      same response shape. Nothing here re-implements the routing to test it.
 *   2. **The comparison is on the executed action, never on a score.** Two
 *      policies that agree to 12 decimal places and disagree on the argmax are
 *      different policies, and only the command says which one a player sees.
 *
 * These deals are development and retired pools. They are **not** strength
 * evidence and cannot be reported as any: see §7 of the protocol.
 */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseTreeModel, type TreeModel } from "../src/core/ai/cf-model.js";
import { generateLegalActions, type ValidatedPlayAction } from "../src/core/rules/index.js";
import type { PlayingPlayerView } from "../src/core/ai/index.js";
import { cfActionCommand, cfCommandKey } from "../src/app/ai/cf-selector.js";
import {
  decideEnhancedAi,
  type CheapLandlordRuntime,
  type EnhancedAiWorkerRequest,
  type EnhancedAiWorkerResponse,
} from "../src/app/ai/decision-handler.js";
import { cheapLandlordDecision, type CheapLandlordDecision } from "../src/app/ai/cheap-landlord.js";
import { CHEAP_LANDLORD_MODEL_JSON, CHEAP_LANDLORD_MODEL_SHA256 } from "../src/app/ai/cheap-landlord-model.js";
import {
  createPi1Bundle,
  roleOfSeat,
  scoreLegalActions,
  type MixtureSpec,
  type PolicyBundle,
} from "./selfplay-policy.js";
import { collectEpisode, type CollectorConfig } from "./selfplay-collector.js";

const ENABLED = process.env.AI_CHEAP_INTEGRATION === "1";
const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** §7: development and retired pools only. No fresh pool is allocated. */
const START = Number(process.env.AI_CHEAP_INTEGRATION_START ?? 915_001);
const DEALS = Number(process.env.AI_CHEAP_INTEGRATION_DEALS ?? 300);
/** Farmer sample for the regression arm; independent of the deal count. */
const FARMER_SAMPLE = Number(process.env.AI_CHEAP_INTEGRATION_FARMERS ?? 1000);

/** §1: the confirmed candidate. */
const CHEAP_SHA256 = "070f5b0b728176a8fb11d6a79e585b1315b847e053a23821830e17394faac26b";
/** §4: the real product deadline, not relaxed. */
const RESPONSE_WINDOW_MS = 480;
/** §9: frozen before measurement. */
const RETENTION_FLOOR = 0.99;
/** A top-two gap at or below this is a near tie. */
const NEAR_TIE = 1e-3;

const OUT = join(ROOT, ".local", "cheap-integration");
const MODEL_PATH = join(ROOT, ".local/selfplay-reh/CHEAP/train-input/landlord.model.json");

interface DecisionState {
  readonly label: string;
  readonly dealIndex: number;
  readonly view: PlayingPlayerView;
  readonly legal: readonly ValidatedPlayAction[];
  readonly seatRole: "landlord" | "farmer";
}

function pi1Environment(): CollectorConfig {
  const bundles = new Map<string, PolicyBundle>([["PI1", createPi1Bundle("master")]]);
  const mixture: MixtureSpec = Object.freeze({
    version: "fas-mixture-v1",
    current: "PI1",
    history: Object.freeze([]),
    weights: Object.freeze({ current: 1, sharedHistory: 0, independentHistory: 0 }),
  });
  return Object.freeze({
    bundles,
    learningBundleId: "PI1",
    mixture,
    epsilon: 0,
    explorationSalt: 0,
    mixtureSalt: 0,
    auditProposal: false,
  });
}

function loadCheap(): { model: TreeModel; rawBytes: number; gzipBytes: number } {
  const bytes = readFileSync(MODEL_PATH);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== CHEAP_SHA256) {
    throw new Error(`${MODEL_PATH} hashes to ${digest}, not the confirmed ${CHEAP_SHA256}.`);
  }
  return {
    model: parseTreeModel(JSON.parse(bytes.toString("utf8"))),
    rawBytes: bytes.length,
    gzipBytes: gzipSync(bytes, { level: 9 }).length,
  };
}

/**
 * Real decision states from the retired development pool, both roles.
 *
 * Landlord states drive the equivalence and latency work; farmer states are
 * what the regression check needs, and it needs *real farmer seats* — feeding
 * it landlord states would "prove" that installing a landlord policy changed
 * the landlord's decision, which is the whole point of the policy.
 */
function decisionStates(): readonly DecisionState[] {
  const config = pi1Environment();
  const states: DecisionState[] = [];
  for (let offset = 0; offset < DEALS; offset += 1) {
    const dealIndex = START + offset;
    for (const scenario of ["L", "F-next", "F-prev"] as const) {
      const episode = collectEpisode(config, dealIndex, scenario);
      for (const record of episode.records) {
        const view = record.view;
        states.push({
          label: `${dealIndex}/${scenario}/${record.seatDecisionIndex}`,
          dealIndex,
          view,
          legal: generateLegalActions({ hand: view.hand, currentPlay: view.currentPlay }),
          seatRole: roleOfSeat(view.seat, view.landlord) === "landlord" ? "landlord" : "farmer",
        });
      }
    }
  }
  return states;
}

function isAttachment(kind: string): boolean {
  return (
    kind === "triple-with-single" ||
    kind === "triple-with-pair" ||
    kind === "airplane-with-singles" ||
    kind === "airplane-with-pairs" ||
    kind === "four-with-two-cards" ||
    kind === "four-with-two-pairs"
  );
}

function isSequence(kind: string): boolean {
  return kind === "straight" || kind === "consecutive-pairs" || kind.startsWith("airplane");
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? Number.NaN;
}

interface Stats {
  readonly n: number;
  readonly p50: number;
  readonly p90: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

function stats(values: readonly number[]): Stats {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    n: sorted.length,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? Number.NaN,
  };
}

/**
 * The real Worker module, driven the way the browser drives it.
 *
 * `ai-worker.ts` assigns `globalThis.onmessage` at import time, so the shim has
 * to exist first. Once imported it is the shipped message handler — this is a
 * transport substitute, not a re-implementation.
 */
async function driveWorker(requests: readonly EnhancedAiWorkerRequest[]): Promise<readonly EnhancedAiWorkerResponse[]> {
  const posted: EnhancedAiWorkerResponse[] = [];
  const scope = globalThis as unknown as {
    postMessage: (response: EnhancedAiWorkerResponse) => void;
    onmessage: ((event: { data: EnhancedAiWorkerRequest }) => void) | null;
  };
  const previous = { postMessage: scope.postMessage, onmessage: scope.onmessage };
  scope.postMessage = (response) => {
    posted.push(response);
  };
  try {
    await import("../src/platform/web/ai-worker.js");
    const handler = scope.onmessage;
    if (handler === null || handler === undefined) {
      throw new Error("ai-worker.ts did not install a message handler on globalThis.");
    }
    for (const request of requests) {
      handler({ data: request });
    }
  } finally {
    scope.postMessage = previous.postMessage;
    scope.onmessage = previous.onmessage;
  }
  return posted;
}

/**
 * The runtime the Worker builds, spelled the same way so the harness exercises
 * the same shape the product does. The `decide` indirection is why the policy
 * lives in the Worker's closure and not in `decision-handler.ts`'s, which is
 * what keeps the frozen `master` identity hash intact.
 */
function landlordRuntime(model: TreeModel, observe?: CheapLandlordRuntime["observe"]): CheapLandlordRuntime {
  return Object.freeze({
    modelSha256: CHEAP_SHA256,
    decide: (context) => cheapLandlordDecision(context, { model, modelSha256: CHEAP_SHA256 }),
    ...(observe === undefined ? {} : { observe }),
  });
}

function workerRequest(
  context: Parameters<typeof decideEnhancedAi>[0]["context"],
  index: number,
): EnhancedAiWorkerRequest {
  return Object.freeze({
    requestId: index + 1,
    aiType: "master" as const,
    context,
    seed: 1,
    cheapLandlord: true,
  });
}

describe.skipIf(!ENABLED)("CHEAP landlord integration prototype", () => {
  let model: TreeModel;
  let rawBytes = 0;
  let gzipBytes = 0;
  let all: readonly DecisionState[] = [];
  let states: readonly DecisionState[] = [];

  const artifact: Record<string, unknown> = {};

  it("resolves the shipped table and the confirmed digest", () => {
    const loaded = loadCheap();
    model = loaded.model;
    rawBytes = loaded.rawBytes;
    gzipBytes = loaded.gzipBytes;
    if (model.numFeatures !== 403) {
      throw new Error(`The candidate declares ${model.numFeatures} features, not 403.`);
    }
    // The Worker reads the same module the harness just read. If the prototype
    // alias did not resolve, the Worker would carry `null` and every landlord
    // request below would decline into master — which would look like a
    // routing bug rather than a harness that forgot an environment variable.
    if (CHEAP_LANDLORD_MODEL_JSON === null) {
      throw new Error(
        "The prototype alias did not resolve: run with CHEAP_LANDLORD_BUILD=1 so the Worker " +
          "packages the same table this harness measures.",
      );
    }
    const embedded = createHash("sha256")
      .update(Buffer.from(CHEAP_LANDLORD_MODEL_JSON, "utf8"))
      .digest("hex");
    expect(CHEAP_LANDLORD_MODEL_SHA256).toBe(CHEAP_SHA256);
    expect(embedded).toBe(CHEAP_SHA256);
    artifact.model = {
      sha256: CHEAP_SHA256,
      rawBytes,
      gzipBytes,
      numTrees: model.numTrees,
      numFeatures: model.numFeatures,
    };
    console.log(
      `[lci] candidate ${CHEAP_SHA256.slice(0, 16)}… raw ${rawBytes} gzip ${gzipBytes} ` +
        `(${model.numTrees} trees, ${model.numFeatures} columns)`,
    );
  });

  it("collects real decision states from the retired development pool", () => {
    const started = Date.now();
    all = decisionStates();
    states = all.filter((state) => state.seatRole === "landlord");
    console.log(
      `[lci] ${states.length} landlord states and ` +
        `${all.length - states.length} farmer states from ${DEALS} deals ` +
        `(${START}-${START + DEALS - 1}) in ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
    expect(states.length).toBeGreaterThan(0);
    // The session builds `context.legalActions` with its own call. If that ever
    // became a shortlist, every equivalence number below would still pass while
    // measuring a different policy, so the full set is asserted here.
    for (const state of states.slice(0, 50)) {
      const fresh = generateLegalActions({ hand: state.view.hand, currentPlay: state.view.currentPlay });
      expect(fresh.length).toBe(state.legal.length);
    }
    // Playing 300 deals takes about 1300 s, and the config's 900 s backstop is
    // sized for the tuning harness, not for this. Without an explicit timeout
    // the collection is marked failed *after* it has already produced every
    // number the run reports -- a red tick that says nothing about the data.
  }, 3_600_000);

  it("matches the research evaluator on the executed action, on every state", async () => {
    expect(states.length).toBeGreaterThan(0);
    const contexts = states.map((state) => ({
      kind: "play" as const,
      view: state.view,
      legalActions: state.legal,
    }));
    const responses = await driveWorker(contexts.map((context, index) => workerRequest(context, index)));
    expect(responses.length).toBe(contexts.length);

    const mismatches: Record<string, unknown>[] = [];
    const declines: Record<string, number> = {};
    const margins: number[] = [];
    const coverage = new Map<string, number>();
    const bump = (key: string): void => {
      coverage.set(key, (coverage.get(key) ?? 0) + 1);
    };
    const legalCounts: number[] = [];

    for (let index = 0; index < states.length; index += 1) {
      const state = states[index];
      const response = responses[index];
      if (state === undefined || response === undefined) {
        throw new Error("Harness lost a state or a response.");
      }
      if (response.outcome.ok !== true) {
        throw new Error(`The Worker refused a landlord request at ${state.label}.`);
      }
      const workerKey = cfCommandKey(response.outcome.command);

      // The reference is the research evaluator, from the research module.
      const reference = scoreLegalActions(state.view, model, state.legal);
      const referenceAction = reference.actions[reference.chosenIndex];
      if (referenceAction === undefined) {
        throw new Error(`The reference had no action at ${state.label}.`);
      }
      const referenceKey = cfCommandKey(cfActionCommand(state.view.seat, referenceAction));

      // Diagnostics through the same function the Worker calls, so a mismatch
      // can be attributed to a decline reason instead of guessed at.
      const direct = cheapDecision(state, model);
      if (direct.kind === "declined") {
        declines[direct.reason] = (declines[direct.reason] ?? 0) + 1;
      } else {
        margins.push(direct.margin);
      }

      if (workerKey !== referenceKey) {
        mismatches.push({ label: state.label, workerKey, referenceKey, direct: direct.kind });
      }

      const legal = state.legal;
      legalCounts.push(legal.length);
      const kinds = legal.filter((action) => action.type === "play").map((action) => action.play.pattern.kind);
      const chosenKind = referenceAction.type === "play" ? referenceAction.play.pattern.kind : "pass";
      if (state.view.currentPlay === null) bump("leading"); else bump("responding");
      if (legal.some((action) => action.type === "pass")) bump("passLegal");
      if (kinds.includes("bomb")) bump("bomb");
      if (kinds.includes("rocket")) bump("rocket");
      if (kinds.some(isAttachment)) bump("attachment");
      if (kinds.some(isSequence)) bump("sequence");
      if (legal.length === 1) bump("singleAction");
      if (legal.length >= 20) bump("wideSet");
      if (
        legal.some(
          (action) => action.type === "play" && action.play.cards.length === state.view.hand.length,
        )
      ) {
        bump("canEmptyHand");
      }
      if (state.view.history.length === 0) bump("opening");
      if (Math.min(...Object.values(state.view.remainingCardCounts)) <= 5) bump("lateGame");
      const sortedScores = [...reference.scores].sort((left, right) => right - left);
      const best = sortedScores[0];
      const second = sortedScores[1];
      if (best !== undefined && second !== undefined) {
        if (best === second) bump("exactTie");
        else if (best - second <= NEAR_TIE) bump("nearTie");
      }
      void chosenKind;
    }

    const sortedLegal = [...legalCounts].sort((left, right) => left - right);
    const summary = {
      states: states.length,
      mismatches: mismatches.length,
      declines,
      coverage: Object.fromEntries(coverage),
      legalActions: {
        min: sortedLegal[0] ?? 0,
        p50: percentile(sortedLegal, 0.5),
        p95: percentile(sortedLegal, 0.95),
        p99: percentile(sortedLegal, 0.99),
        max: sortedLegal[sortedLegal.length - 1] ?? 0,
      },
      marginMin: margins.length === 0 ? null : Math.min(...margins),
    };
    artifact.equivalence = summary;
    console.log(
      `[lci] E1 equivalence: ${states.length} states, ${mismatches.length} mismatches, ` +
        `declines ${JSON.stringify(declines)}`,
    );
    console.log(`[lci] coverage ${JSON.stringify(Object.fromEntries(coverage))}`);
    console.log(
      `[lci] legal actions min ${summary.legalActions.min} p50 ${summary.legalActions.p50} ` +
        `p95 ${summary.legalActions.p95} p99 ${summary.legalActions.p99} max ${summary.legalActions.max}`,
    );
    if (mismatches.length > 0) {
      console.error(`[lci] first mismatches ${JSON.stringify(mismatches.slice(0, 10))}`);
    }
    expect(mismatches).toEqual([]);
    expect(declines).toEqual({});
  });

  it("does not change a farmer decision, and never runs for casual", () => {
    const farmerStates = all.filter((state) => state.seatRole === "farmer").slice(0, FARMER_SAMPLE);
    expect(farmerStates.length).toBeGreaterThan(0);
    let divergences = 0;
    let casualTouched = 0;
    const examples: Record<string, unknown>[] = [];

    for (let index = 0; index < farmerStates.length; index += 1) {
      const state = farmerStates[index];
      if (state === undefined) continue;
      const context = Object.freeze({
        kind: "play" as const,
        view: state.view,
        legalActions: state.legal,
      });
      // A frozen clock: the master rollout's truncation must not be able to
      // make the two runs differ, or the comparison measures scheduling rather
      // than the integration. `(1)` binds the request to the seat under test
      // only through the context, which is what the Worker routes on.
      const runtime = { deadline: Number.MAX_SAFE_INTEGER, now: () => 0 };
      const without = decideEnhancedAi(workerRequest(context, index), runtime);
      const withLandlord = decideEnhancedAi(workerRequest(context, index), {
        ...runtime,
        landlord: landlordRuntime(model),
      });
      if (cfCommandKey(commandOf(without)) !== cfCommandKey(commandOf(withLandlord))) {
        divergences += 1;
        if (examples.length < 5) examples.push({ label: state.label });
      }
      // The landlord branch is master-only. A farmer seat under `casual` must
      // not reach it either: the confirmation's baseline was the master tier,
      // and `casual` is a deliberately weaker product tier.
      const casualOnly = decideEnhancedAi(
        Object.freeze({ ...workerRequest(context, index), aiType: "casual" as const }),
        runtime,
      );
      const casualWithLandlord = decideEnhancedAi(
        Object.freeze({ ...workerRequest(context, index), aiType: "casual" as const }),
        { ...runtime, landlord: landlordRuntime(model) },
      );
      if (cfCommandKey(commandOf(casualOnly)) !== cfCommandKey(commandOf(casualWithLandlord))) {
        casualTouched += 1;
      }
    }

    artifact.farmerRegression = { sampled: farmerStates.length, divergences, casualTouched };
    console.log(
      `[lci] E2 farmer regression: ${farmerStates.length} farmer states, ${divergences} divergences, ` +
        `${casualTouched} casual-seat divergences`,
    );
    if (divergences > 0) {
      console.error(`[lci] first farmer divergences ${JSON.stringify(examples)}`);
    }
    expect(divergences).toBe(0);
    expect(casualTouched).toBe(0);
  });

  it("measures the decision path and the deadline retention at the real budget", () => {
    expect(states.length).toBeGreaterThan(0);
    const totals: number[] = [];
    const featureMs: number[] = [];
    const inferenceMs: number[] = [];
    const selectMs: number[] = [];
    const byLegalCount = new Map<number, number[]>();
    const leadingTotals: number[] = [];
    const respondingTotals: number[] = [];
    let deadlineFallbacks = 0;

    for (const state of states) {
      const started = performance.now();
      const decision = cheapDecision(state, model);
      const total = performance.now() - started;
      if (decision.kind === "declined") {
        throw new Error(`Unexpected decline at ${state.label}: ${decision.reason}`);
      }
      totals.push(total);
      featureMs.push(decision.timing.featureMs);
      inferenceMs.push(decision.timing.inferenceMs);
      selectMs.push(decision.timing.selectMs);
      const bucket = byLegalCount.get(state.legal.length) ?? [];
      bucket.push(total);
      byLegalCount.set(state.legal.length, bucket);
      if (state.view.currentPlay === null) leadingTotals.push(total);
      else respondingTotals.push(total);
      if (total > RESPONSE_WINDOW_MS) deadlineFallbacks += 1;
    }

    const retention = 1 - deadlineFallbacks / totals.length;
    const wideTotals = [...byLegalCount.entries()]
      .filter(([count]) => count >= 20)
      .flatMap(([, values]) => values);
    const widest = [...byLegalCount.entries()].sort((left, right) => right[0] - left[0])[0];

    const report = {
      total: stats(totals),
      feature: stats(featureMs),
      inference: stats(inferenceMs),
      select: stats(selectMs),
      leading: stats(leadingTotals),
      responding: stats(respondingTotals),
      wideSet: stats(wideTotals),
      widestLegalCount: widest?.[0] ?? 0,
      responseWindowMs: RESPONSE_WINDOW_MS,
      deadlineFallbacks,
      retention,
      retentionFloor: RETENTION_FLOOR,
    };
    artifact.latency = report;

    const line = (label: string, value: Stats): string =>
      `[lci] ${label.padEnd(11)} n ${value.n} p50 ${value.p50.toFixed(2)} p90 ${value.p90.toFixed(2)} ` +
      `p95 ${value.p95.toFixed(2)} p99 ${value.p99.toFixed(2)} max ${value.max.toFixed(2)} ms`;
    console.log(line("total", report.total));
    console.log(line("feature", report.feature));
    console.log(line("inference", report.inference));
    console.log(line("select", report.select));
    console.log(line("leading", report.leading));
    console.log(line("responding", report.responding));
    console.log(
      `[lci] wide sets (>=20 legal actions): n ${report.wideSet.n} ` +
        `p50 ${report.wideSet.p50.toFixed(2)} p99 ${report.wideSet.p99.toFixed(2)} ` +
        `max ${report.wideSet.max.toFixed(2)} ms; widest legal set ${report.widestLegalCount}`,
    );
    console.log(
      `[lci] G retention: ${totals.length} decisions, ${deadlineFallbacks} over ${RESPONSE_WINDOW_MS} ms, ` +
        `retention ${(100 * retention).toFixed(3)}% (floor ${(100 * RETENTION_FLOOR).toFixed(2)}%)`,
    );

    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, "integration.json"), JSON.stringify(artifact, null, 2));
    expect(retention).toBeGreaterThanOrEqual(RETENTION_FLOOR);
  });
});

/** The policy function the Worker calls, with the timing it reports. */
function cheapDecision(state: DecisionState, model: TreeModel): CheapLandlordDecision {
  const context = Object.freeze({
    kind: "play" as const,
    view: state.view,
    legalActions: state.legal,
  });
  let captured: CheapLandlordDecision | null = null;
  const outcome = decideEnhancedAi(workerRequest(context, 0), {
    deadline: Number.MAX_SAFE_INTEGER,
    now: () => 0,
    landlord: landlordRuntime(model, (_context, decision) => {
      captured = decision;
    }),
  });
  if (captured === null) {
    throw new Error(`The landlord branch did not run for ${state.label} (outcome ${JSON.stringify(outcome)}).`);
  }
  return captured;
}

function commandOf(outcome: ReturnType<typeof decideEnhancedAi>) {
  if (outcome.ok !== true) {
    throw new Error(`Expected an ok outcome, saw ${JSON.stringify(outcome)}.`);
  }
  return outcome.command;
}
