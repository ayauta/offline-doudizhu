/**
 * Device probe for the primitive an exact endgame solver would lean on.
 *
 * The solver's cost was measured in *nodes* so it would transfer between
 * machines. To turn nodes into device milliseconds, what is missing is the cost
 * of one node on the device — and a node is, above all, one call to the engine's
 * legal-action generator plus one game transition. This measures exactly those
 * two, on the same workload in both places.
 *
 * Research scaffolding. Not shipped, not imported by `src/`.
 */

import { createPlayerView } from "../../src/core/ai/index.js";
import { transition } from "../../src/core/game/index.js";
import type { GameState, Seat } from "../../src/core/game/index.js";
import { INITIAL_GAME_STATE } from "../../src/core/game/index.js";
import { generateLegalActions } from "../../src/core/rules/index.js";

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

/** Walks a real game and returns the positions a solver would actually visit. */
function collectPositions(deals: number): readonly GameState[] {
  const positions: GameState[] = [];
  for (let dealIndex = 0; dealIndex < deals; dealIndex += 1) {
    const deck = seededDeck(701 + dealIndex);
    let state: GameState = transition(INITIAL_GAME_STATE, { type: "deal", deck: deck as never }).state;
    for (const seat of ["human", "ai-one", "ai-two"] as const) {
      if (state.phase !== "bidding") {
        break;
      }
      state = transition(state, { type: "bid", seat, decision: seat === "human" ? "call" : "decline" }).state;
    }
    for (let commandCount = 0; commandCount < 256; commandCount += 1) {
      if (state.phase !== "ready-to-play" && state.phase !== "playing") {
        break;
      }
      const seat: Seat = state.currentSeat;
      const view = createPlayerView(state, seat);
      if (view === null || view.phase === "bidding") {
        break;
      }
      positions.push(state);
      const actions = generateLegalActions({ hand: view.hand, currentPlay: view.currentPlay });
      // Follow the largest legal play, so the walk covers real play rather than
      // only passes, which would keep the hands large and unrepresentative.
      const play = actions.find((action) => action.type === "play");
      const command = play === undefined || play.type !== "play"
        ? Object.freeze({ type: "pass" as const, seat })
        : Object.freeze({ type: "play" as const, seat, cards: play.play.cards });
      const next = transition(state, command);
      if (!next.ok) {
        break;
      }
      state = next.state;
    }
  }
  return Object.freeze(positions);
}

export type PrimitiveResult = Readonly<{
  positions: number;
  legalActionsCalls: number;
  transitions: number;
  legalActionsMs: number;
  transitionsMs: number;
  usPerLegalActions: number;
  usPerTransition: number;
}>;

export function runPrimitiveProbe(deals = 3): PrimitiveResult {
  const positions = collectPositions(deals);
  let legalActionsMs = 0;
  let transitionsMs = 0;
  let legalActionsCalls = 0;
  let transitions = 0;

  for (const state of positions) {
    if (state.phase !== "ready-to-play" && state.phase !== "playing") {
      continue;
    }
    const seat = state.currentSeat;
    const view = createPlayerView(state, seat);
    if (view === null || view.phase === "bidding") {
      continue;
    }
    const startedLegal = performance.now();
    const actions = generateLegalActions({ hand: view.hand, currentPlay: view.currentPlay });
    legalActionsMs += performance.now() - startedLegal;
    legalActionsCalls += 1;

    const play = actions.find((action) => action.type === "play");
    const command = play === undefined || play.type !== "play"
      ? Object.freeze({ type: "pass" as const, seat })
      : Object.freeze({ type: "play" as const, seat, cards: play.play.cards });
    const startedTransition = performance.now();
    const next = transition(state, command);
    transitionsMs += performance.now() - startedTransition;
    if (next.ok) {
      transitions += 1;
    }
  }

  return Object.freeze({
    positions: positions.length,
    legalActionsCalls,
    transitions,
    legalActionsMs,
    transitionsMs,
    usPerLegalActions: (legalActionsMs * 1000) / Math.max(1, legalActionsCalls),
    usPerTransition: (transitionsMs * 1000) / Math.max(1, transitions),
  });
}

(globalThis as unknown as Record<string, unknown>).__primitive = {
  run: (deals = 3) => runPrimitiveProbe(deals),
};
