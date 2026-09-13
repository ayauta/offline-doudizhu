/**
 * Reference endgame solver — deliberately independent of `exact-solver.ts`.
 *
 * The point of this file is that it **shares no code** with the solver under
 * test, not even the rules. Where the solver calls the engine's
 * `generateLegalActions` and `transition`, this one enumerates candidate plays
 * itself from rank counts and applies the rules of the game by hand. Two
 * implementations written to be different avoid a shared bug; one implementation
 * with two call sites does not.
 *
 * It is meant to be simple and slow. It is used only on very small positions.
 *
 * Research scaffolding. Not shipped, not imported by `src/`.
 */

import { getCard, type CardId } from "../../src/core/cards/index.js";
import type { Seat } from "../../src/core/game/index.js";

export type OracleSeat = Seat;

export type OracleState = Readonly<{
  /** Rank-count per seat: rank index 0..14 (3..2, small joker, big joker). */
  hands: Readonly<Record<Seat, readonly number[]>>;
  turn: Seat;
  landlord: Seat;
  /** Cards on the table, as a shape, or null when the seat leads. */
  lead: Readonly<{ length: number; size: number; rank: number; isBomb: boolean }> | null;
  /** Who put the current lead down, so a pass can return it. */
  leadSeat: Seat | null;
  /** True when the previous action was a pass. */
  trailingPass: boolean;
  winner: Seat | null;
}>;

export const RANK_COUNT = 15;
const SEATS: readonly Seat[] = Object.freeze(["human", "ai-one", "ai-two"]);

/** Rank counts of a hand, in the oracle's own encoding. */
export function countsOf(hand: readonly CardId[]): number[] {
  const counts = new Array<number>(RANK_COUNT).fill(0);
  for (const card of hand) {
    const { rank } = getCard(card);
    const index = rank === "small-joker" ? 13 : rank === "big-joker" ? 14 : rankIndex(rank);
    counts[index] = (counts[index] ?? 0) + 1;
  }
  return counts;
}

function rankIndex(rank: string): number {
  return ["3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A", "2"].indexOf(rank);
}

/** A candidate play: how many distinct ranks, how many of each, main rank. */
type Shape = Readonly<{ length: number; size: number; rank: number; isBomb: boolean }>;

/**
 * Rank index 14 is the big joker, so `rank === 14` means "this is a rocket".
 * Index 12 is the two, which is the highest ordinary card but not a bomb — an
 * earlier version of this file conflated the two and treated every single two
 * as though it beat everything.
 */
const ROCKET_RANK = 14;

function shapeOf(length: number, size: number, rank: number): Shape {
  return Object.freeze({ length, size, rank, isBomb: size === 4 || (size === 2 && rank === ROCKET_RANK) });
}

/**
 * Every legal play this seat can make, written out by hand.
 * Deliberately naive: it enumerates shapes, not plans.
 */
function playsFor(hand: readonly number[], lead: Shape | null): readonly Shape[] {
  const plays: Shape[] = [];
  const rankAt = (index: number): number => hand[index] ?? 0;
  const hasRocket = rankAt(13) > 0 && rankAt(14) > 0;

  const acceptable = (shape: Shape): boolean => {
    if (lead === null) {
      return true;
    }
    if (shape.isBomb && !lead.isBomb) {
      return true;
    }
    if (lead.isBomb) {
      return shape.isBomb && shape.rank > lead.rank;
    }
    return shape.length === lead.length && shape.size === lead.size && shape.rank > lead.rank;
  };

  const push = (length: number, size: number, rank: number): void => {
    const shape = shapeOf(length, size, rank);
    if (acceptable(shape)) {
      plays.push(shape);
    }
  };

  for (let rank = 0; rank < RANK_COUNT; rank += 1) {
    if (rankAt(rank) >= 1) {
      push(1, 1, rank);
    }
    if (rankAt(rank) >= 2) {
      push(1, 2, rank);
    }
    if (rankAt(rank) >= 3) {
      push(1, 3, rank);
    }
    if (rankAt(rank) >= 4) {
      push(1, 4, rank);
    }
  }
  if (hasRocket) {
    plays.push(Object.freeze({ length: 1, size: 2, rank: ROCKET_RANK, isBomb: true }));
  }
  // Sequences: ranks 0..11 are 3..A; a run needs consecutive ranks present.
  for (let start = 0; start < 12; start += 1) {
    for (let length = 5; length <= 12 - start; length += 1) {
      const run = hand.slice(start, start + length);
      if (run.every((count) => count >= 1)) {
        push(length, 1, start + length - 1);
      }
    }
    for (let length = 3; length <= 10 - start; length += 1) {
      const run = hand.slice(start, start + length);
      if (run.every((count) => count >= 2)) {
        push(length, 2, start + length - 1);
      }
    }
  }
  // Deduplicate identical shapes: the oracle cares about outcomes, not move identity.
  const unique = new Map<string, Shape>();
  for (const play of plays) {
    unique.set(`${String(play.length)}/${String(play.size)}/${String(play.rank)}`, play);
  }
  return [...unique.values()];
}

function applyPlay(state: OracleState, seat: Seat, shape: Shape | null): OracleState {
  const hands = { ...state.hands };
  if (shape !== null) {
    const next = [...(hands[seat] ?? [])];
    if (shape.length === 1 && shape.size === 2 && shape.rank === ROCKET_RANK) {
      next[13] = 0;
      next[14] = 0;
    } else {
      next[shape.rank] = (next[shape.rank] ?? 0) - shape.size;
    }
    hands[seat] = Object.freeze(next);
  }
  const emptied = (hands[seat] ?? []).every((count) => count === 0);
  const total = SEATS.reduce(
    (sum, current) => sum + (hands[current] ?? []).reduce((a, b) => a + b, 0),
    0,
  );
  const nextTurn = SEATS[(SEATS.indexOf(seat) + 1) % 3] ?? "human";

  if (emptied) {
    return { ...state, hands, winner: seat, turn: nextTurn };
  }
  if (shape === null) {
    // A pass: if the previous action was also a pass, the lead returns.
    if (state.trailingPass && state.leadSeat !== null) {
      return {
        ...state,
        hands,
        turn: state.leadSeat,
        lead: null,
        leadSeat: null,
        trailingPass: false,
      };
    }
    return { ...state, hands, turn: nextTurn, trailingPass: true };
  }
  void total;
  return { ...state, hands, turn: nextTurn, lead: shape, leadSeat: seat, trailingPass: false };
}

/**
 * Does the landlord's side win under optimal play? Plain minimax, no cache, no
 * pruning, no ordering — the slowest and most obvious formulation available.
 */
export function oracleLandlordWins(state: OracleState, cap = 2_000_000): boolean {
  let nodes = 0;
  const search = (current: OracleState): boolean => {
    if (current.winner !== null) {
      return current.winner === current.landlord;
    }
    nodes += 1;
    if (nodes > cap) {
      throw new Error("oracle cap reached");
    }
    const mover = current.turn;
    const moverIsLandlord = mover === current.landlord;
    const options: readonly (Shape | null)[] = current.lead === null
      ? playsFor(current.hands[mover] ?? [], null)
      : [...playsFor(current.hands[mover] ?? [], current.lead), null];

    let result = !moverIsLandlord;
    for (const option of options) {
      const child = search(applyPlay(current, mover, option));
      if (moverIsLandlord && child) {
        result = true;
        break;
      }
      if (!moverIsLandlord && !child) {
        result = false;
        break;
      }
    }
    return result;
  };
  return search(state);
}

/** States derived from a real dealt position, so the oracle can be fed one. */
export function oracleStateFrom(
  hands: Readonly<Record<Seat, readonly CardId[]>>,
  turn: Seat,
  landlord: Seat,
  lead: Shape | null,
  leadSeat: Seat | null,
  trailingPass: boolean,
): OracleState {
  return Object.freeze({
    hands: Object.freeze({
      human: Object.freeze(countsOf(hands.human)),
      "ai-one": Object.freeze(countsOf(hands["ai-one"])),
      "ai-two": Object.freeze(countsOf(hands["ai-two"])),
    }),
    turn,
    landlord,
    lead,
    leadSeat,
    trailingPass,
    winner: null,
  });
}

export type { Shape as OracleShape };
export { playsFor as oraclePlaysFor };
