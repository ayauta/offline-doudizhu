/**
 * Device probe: time the shipped AI decision path on whatever machine runs it.
 *
 * `scripts/phone-probe.mjs` bundles this file, pushes it into a connected
 * phone's WebView over CDP, and runs it there; the same bundle also runs on the
 * development machine. A millisecond does not transfer between machines, but a
 * ratio measured on the same bytes does.
 *
 * It deals and starts its games through the harness's own `dealDeck` and
 * `startWithLandlord`. That is not tidiness: a local copy of the deal once
 * handed every landlord seat to the human, so the probe silently measured one
 * position mix while its caller believed it varied all three.
 *
 * It reports `__probe` on the global object so a remote debugger can read the
 * result without any device-side tooling. Not shipped, not imported by `src/`.
 */

import {
  createPlayerView,
  type AiDecisionContext,
  type PlayingPlayerView,
} from "../src/core/ai/index.js";
import {
  decideEnhancedAi,
  ENHANCED_AI_BUDGET_MS,
  type AiDecisionRuntime,
} from "../src/app/ai/decision-handler.js";
import type { EnhancedAiType } from "../src/app/ports/ai-decision-service.js";
import { SEAT_ORDER, transition } from "../src/core/game/index.js";
import { generateLegalActions } from "../src/core/rules/index.js";
import { summarizeLatency } from "./ai-stats.js";
import { dealDeck, startWithLandlord } from "./ai-tournament.js";
import { parseTreeModel } from "../src/core/ai/cf-model.js";
import {
  CHEAP_LANDLORD_MODEL_JSON,
  CHEAP_LANDLORD_MODEL_SHA256,
} from "../src/app/ai/cheap-landlord-model.js";
import { cheapLandlordDecision } from "../src/app/ai/cheap-landlord.js";

/** The real product deadline. Never relaxed for a measurement. */
const RESPONSE_WINDOW_MS = 480;

const NEVER: AiDecisionRuntime = Object.freeze({
  deadline: Number.MAX_SAFE_INTEGER,
  now: () => 0,
});

/**
 * `unbounded` gives the handler a runtime that never expires, so it measures the
 * whole designed workload. `shipped` gives it the real per-tier budget, so it
 * measures the path the product actually runs. They answer different questions:
 * the first is how much work master wants, the second is how much it gets.
 */
type Mode = "unbounded" | "shipped";

/**
 * Order matters, exactly as it does for the tiers below: whichever mode runs
 * first pays the engine's cold-start cost, and every later mode's `first` sample
 * is warm. Only the first entry's `first` may be read as a cold start.
 *
 * `shipped` goes first because the cold decision a player actually meets is a
 * shipped one. Its cost is partly hidden by the budget cap, which is the honest
 * trade: the cap is what the product does.
 */
const MODES: readonly Mode[] = Object.freeze(["shipped", "unbounded"]);

function runtimeFor(mode: Mode, aiType: EnhancedAiType, startedAt: number): AiDecisionRuntime {
  if (mode === "unbounded") {
    return NEVER;
  }
  return Object.freeze({
    deadline: startedAt + ENHANCED_AI_BUDGET_MS[aiType],
    now: () => performance.now(),
  });
}

/**
 * Plays whole games with the shipped handler driving every seat, timing each
 * decision. The landlord rotates across seats so the timings cover the whole
 * position mix rather than one seat's. Returns per-decision timings so a slow
 * machine and a fast machine can be compared on like-for-like work.
 */
function measure(deals: number, aiType: EnhancedAiType, mode: Mode): readonly number[] {
  const samples: number[] = [];
  for (let dealIndex = 0; dealIndex < deals; dealIndex += 1) {
    const landlord = SEAT_ORDER[dealIndex % SEAT_ORDER.length] ?? "human";
    let state = startWithLandlord(dealDeck(301 + dealIndex), landlord);
    for (let commandCount = 0; commandCount < 256; commandCount += 1) {
      if (state.phase === "finished") {
        break;
      }
      if (state.phase !== "ready-to-play" && state.phase !== "playing") {
        break;
      }
      const seat = state.currentSeat;
      const view = createPlayerView(state, seat);
      if (view === null || view.phase === "bidding") {
        break;
      }
      const context: AiDecisionContext = Object.freeze({
        kind: "play",
        view: view as PlayingPlayerView,
        legalActions: generateLegalActions({ hand: view.hand, currentPlay: view.currentPlay }),
      });
      const started = performance.now();
      const outcome = decideEnhancedAi(
        { requestId: commandCount, aiType, context, seed: 1234 + commandCount },
        runtimeFor(mode, aiType, started),
      );
      samples.push(performance.now() - started);
      if (!outcome.ok) {
        break;
      }
      const next = transition(state, outcome.command);
      if (!next.ok) {
        break;
      }
      state = next.state;
    }
  }
  return Object.freeze(samples);
}

/**
 * The CHEAP landlord arm, on whatever device runs this.
 *
 * **Caliber, stated plainly**: this drives `decideEnhancedAi` in the WebView's
 * *main thread* with the same runtime object the shipped Worker builds. It does
 * not measure a real Worker thread — the probe has no way to attach to one —
 * so Worker scheduling, message passing and structured cloning are absent from
 * these numbers. What it does measure is the device's CPU on the exact policy
 * bytes, which is the question a phone is being asked. The desktop numbers in
 * `cheap-integration-report.md` are the ones that include a real Worker.
 *
 * The model is parsed here rather than imported pre-parsed, so "model load and
 * init" is a measured stage and not an assumption. The first decision is kept
 * separate from the quantiles for the same reason the tier probe keeps it
 * separate: on a cold engine it is the only sample nothing has warmed.
 */
export function runLandlordArm(deals: number): unknown {
  const result: Record<string, unknown> = {
    modelSha256: CHEAP_LANDLORD_MODEL_SHA256,
    responseWindowMs: RESPONSE_WINDOW_MS,
  };

  const parseStart = performance.now();
  const text = CHEAP_LANDLORD_MODEL_JSON;
  const raw = text === null ? null : (JSON.parse(text) as unknown);
  const parseEnd = performance.now();
  if (raw === null) {
    return { ...result, available: false, note: "no model table in this build" };
  }
  const model = parseTreeModel(raw);
  const initEnd = performance.now();
  result.modelBytes = text === null ? 0 : text.length;
  result.numTrees = model.numTrees;
  result.numFeatures = model.numFeatures;
  result.parseMs = parseEnd - parseStart;
  result.initMs = initEnd - parseEnd;
  result.available = true;

  const landlordRuntime = Object.freeze({
    modelSha256: CHEAP_LANDLORD_MODEL_SHA256,
    decide: (context: Parameters<typeof cheapLandlordDecision>[0]) =>
      cheapLandlordDecision(context, { model, modelSha256: CHEAP_LANDLORD_MODEL_SHA256 }),
  });

  const samples: number[] = [];
  const landlordSamples: number[] = [];
  const legalCounts: number[] = [];
  let firstLandlordMs = 0;
  let deadlineFallbacks = 0;
  let declines = 0;
  let landlordDecisions = 0;

  for (let dealIndex = 0; dealIndex < deals; dealIndex += 1) {
    const landlord = SEAT_ORDER[dealIndex % SEAT_ORDER.length] ?? "human";
    let state = startWithLandlord(dealDeck(701 + dealIndex), landlord);
    for (let commandCount = 0; commandCount < 256; commandCount += 1) {
      if (state.phase !== "ready-to-play" && state.phase !== "playing") {
        break;
      }
      const seat = state.currentSeat;
      const view = createPlayerView(state, seat);
      if (view === null || view.phase === "bidding") {
        break;
      }
      const isLandlord = view.seat === view.landlord;
      const context: AiDecisionContext = Object.freeze({
        kind: "play",
        view: view as PlayingPlayerView,
        legalActions: generateLegalActions({ hand: view.hand, currentPlay: view.currentPlay }),
      });
      if (isLandlord) {
        legalCounts.push(context.legalActions.length);
      }
      const started = performance.now();
      const outcome = decideEnhancedAi(
        { requestId: commandCount, aiType: "master", context, seed: 4321 + commandCount },
        isLandlord
          ? { deadline: started + RESPONSE_WINDOW_MS, now: () => performance.now(), landlord: landlordRuntime }
          : NEVER,
      );
      const elapsed = performance.now() - started;
      samples.push(elapsed);
      if (isLandlord) {
        landlordDecisions += 1;
        landlordSamples.push(elapsed);
        if (firstLandlordMs === 0) {
          firstLandlordMs = elapsed;
        }
        if (elapsed > RESPONSE_WINDOW_MS) {
          deadlineFallbacks += 1;
        }
      }
      if (!outcome.ok) {
        declines += 1;
        break;
      }
      const next = transition(state, outcome.command);
      if (!next.ok) {
        break;
      }
      state = next.state;
    }
  }

  const sortedLegal = [...legalCounts].sort((left, right) => left - right);
  result.decisions = samples.length;
  result.landlordDecisions = landlordDecisions;
  result.firstLandlordMs = firstLandlordMs;
  result.deadlineFallbacks = deadlineFallbacks;
  result.declines = declines;
  result.retention = landlordDecisions === 0 ? null : 1 - deadlineFallbacks / landlordDecisions;
  result.all = summarizeLatency(samples);
  result.landlord = summarizeLatency(landlordSamples);
  result.legalActions = {
    min: sortedLegal[0] ?? 0,
    median: sortedLegal[Math.floor(sortedLegal.length / 2)] ?? 0,
    max: sortedLegal[sortedLegal.length - 1] ?? 0,
  };
  return result;
}

/** Coarse memory reading; the API is quantized and may be absent in a WebView. */
function readMemory(): unknown {
  const memory = (performance as unknown as {
    memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
  }).memory;
  return memory === undefined
    ? null
    : {
        usedJSHeapSize: memory.usedJSHeapSize,
        totalJSHeapSize: memory.totalJSHeapSize,
        jsHeapSizeLimit: memory.jsHeapSizeLimit,
      };
}

export function runPhoneProbe(deals = 3): unknown {
  const result: Record<string, unknown> = {};
  // Spec 055 merged the expert tier into master, so the shipped enhanced tier is
  // a single one. Casual stays as the cheap reference point for the ratio.
  // Master runs first on purpose. Whichever tier goes first pays the cold-engine
  // cost, and the shipped first decision of a match is a cold one; running casual
  // first would quietly warm V8 and report a hot number as if it were cold-start.
  for (const aiType of ["master", "casual"] as const) {
    const perMode: Record<string, unknown> = {};
    for (const mode of MODES) {
      const samples = measure(deals, aiType, mode);
      perMode[mode] = {
        // The first decision of the run, kept separate from the quantiles: on a
        // cold engine it is the only sample that has not been warmed by the ones
        // before it, and the shipped first decision of a match is exactly that.
        first: samples[0] ?? 0,
        totalMs: samples.reduce((sum, value) => sum + value, 0),
        ...summarizeLatency(samples),
      };
    }
    result[aiType] = perMode;
  }
  // The landlord arm runs last: it is the only one whose cold-start number is
  // reported, and the tiers above would otherwise have warmed the engine for it.
  result.cheapLandlord = runLandlordArm(deals);
  return result;
}

if (typeof globalThis !== "undefined") {
  const scope = globalThis as unknown as Record<string, unknown>;
  scope.__probe = {
    run: (deals = 3) => runPhoneProbe(deals),
    /**
     * A dedicated landlord-only entry point, so a memory reading can be taken
     * *before* the tier arms have allocated anything, and again after. Reading
     * it inside `run` would attribute the tier measurements to the model.
     */
    memory: () => readMemory(),
    landlord: (deals = 3) => {
      const before = readMemory();
      const arm = runLandlordArm(deals);
      const after = readMemory();
      return { before, after, arm };
    },
  };
}
