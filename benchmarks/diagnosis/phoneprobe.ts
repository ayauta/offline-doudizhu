/**
 * Device probe: time the shipped AI decision path on whatever machine runs it.
 *
 * This file is bundled and then run in two places — the target phone's WebView
 * and this development machine — and the *ratio* between them is the point. A
 * node count transfers between machines; a millisecond does not, but a ratio
 * measured on the same code does.
 *
 * It reports `__probe` on the global object so a remote debugger can read the
 * result without any device-side tooling.
 *
 * Research scaffolding. Not shipped, not imported by `src/`.
 */

import { createPlayerView } from "../../src/core/ai/index.js";
import type { AiDecisionContext, PlayingPlayerView } from "../../src/core/ai/index.js";
import { decideEnhancedAi } from "../../src/app/ai/decision-handler.js";
import type { AiDecisionRuntime } from "../../src/app/ai/decision-handler.js";
import { transition } from "../../src/core/game/index.js";
import type { GameState, Seat } from "../../src/core/game/index.js";
import { generateLegalActions } from "../../src/core/rules/index.js";

const NEVER: AiDecisionRuntime = Object.freeze({
  deadline: Number.MAX_SAFE_INTEGER,
  now: () => 0,
});

/** Deterministic shuffle, identical on every machine. */
function seededDeck(seed: number): number[] {
  const deck = Array.from({ length: 54 }, (_, index) => index);
  let state = seed >>> 0;
  for (let index = deck.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const target = state % (index + 1);
    const swap = deck[index] ?? 0;
    deck[index] = deck[target] ?? 0;
    deck[target] = swap;
  }
  return deck;
}

function startGame(deck: readonly number[], landlord: Seat): GameState {
  let state = transition(
    transition(INITIAL_STATE, { type: "deal", deck: deck as never }).state,
    { type: "bid", seat: "human", decision: "call" },
  ).state;
  for (const seat of ["human", "ai-one", "ai-two"] as const) {
    if (state.phase !== "bidding") {
      break;
    }
    if (seat === landlord) {
      continue;
    }
    state = transition(state, { type: "bid", seat, decision: "decline" }).state;
  }
  return state;
}

import { INITIAL_GAME_STATE as INITIAL_STATE } from "../../src/core/game/index.js";

type Sample = Readonly<{ aiType: "expert" | "master"; handSize: number; cards: number; ms: number }>;

/**
 * Plays whole games with the shipped handler driving every seat, timing each
 * decision. Returns per-decision timings so a slow machine and a fast machine
 * can be compared on like-for-like work.
 */
function measure(deals: number, aiType: "expert" | "master"): readonly Sample[] {
  const samples: Sample[] = [];
  for (let dealIndex = 0; dealIndex < deals; dealIndex += 1) {
    const deck = seededDeck(301 + dealIndex);
    const landlord: Seat = (["human", "ai-one", "ai-two"] as const)[dealIndex % 3] ?? "human";
    let state = startGame(deck, landlord);
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
        NEVER,
      );
      const ms = performance.now() - started;
      samples.push(Object.freeze({ aiType, handSize: view.hand.length, cards: context.legalActions.length, ms }));
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

export function runPhoneProbe(deals = 3): unknown {
  const result: Record<string, unknown> = {};
  for (const aiType of ["expert", "master"] as const) {
    const samples = measure(deals, aiType);
    const times = samples.map((sample) => sample.ms).sort((left, right) => left - right);
    const at = (fraction: number): number =>
      times.length === 0 ? 0 : (times[Math.min(times.length - 1, Math.floor(times.length * fraction))] ?? 0);
    result[aiType] = {
      decisions: samples.length,
      p50: at(0.5),
      p95: at(0.95),
      p99: at(0.99),
      max: times.at(-1) ?? 0,
      total: times.reduce((sum, value) => sum + value, 0),
    };
  }
  return result;
}

if (typeof globalThis !== "undefined") {
  (globalThis as unknown as Record<string, unknown>).__probe = {
    run: (deals = 3) => runPhoneProbe(deals),
  };
}
