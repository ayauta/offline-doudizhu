/**
 * Minimum number of plays needed to empty a hand, with no interference.
 *
 * This answers exactly one question — "given these cards, how few legal plays
 * can they be partitioned into" — and deliberately answers no other. It has no
 * notion of initiative, of who is about to finish, of whom the cards are
 * against, or of what is worth keeping: those belong to the position
 * evaluation, not to a hand's shape.
 *
 * The value is a *real* partition, so it is an achievable play count and an
 * upper bound on the true number of turns needed to go out. It is not
 * monotone under card removal — breaking `34567` down to `4567` raises the
 * count from 1 to 4 — which is a property of the quantity, not a defect, and
 * is why callers must treat it as "plays this hand can be split into" rather
 * than as a distance that always shrinks.
 *
 * Agreement with the engine's own move generator is enforced by test, not by
 * inspection: `tests/core/hand-turns.test.ts` compares this module's moves
 * against `generateLegalActions` over a large random hand corpus.
 */
import { getCard, type CardId } from "../cards/index.js";
import { RANK_ORDER, rankStrength } from "../rules/index.js";

/** Number of distinct ranks in strength order: 3 … 2, small joker, big joker. */
export const HAND_TURNS_RANK_COUNT = RANK_ORDER.length;
/** Ranks 3 … A are the only ones a sequence may use. */
const SEQUENCE_RANK_COUNT = 12;
const MAX_STRAIGHT = SEQUENCE_RANK_COUNT;
const MAX_CONSECUTIVE_PAIRS = 10;
const MAX_AIRPLANE = 6;
const MAX_AIRPLANE_SINGLE_WINGS = 5;
const MAX_AIRPLANE_PAIR_WINGS = 4;
const SMALL_JOKER = 13;
const BIG_JOKER = 14;

/** A move and a hand are both base-5 digit vectors over the 15 ranks. */
function packCounts(counts: readonly number[]): number {
  let value = 0;
  for (let index = HAND_TURNS_RANK_COUNT - 1; index >= 0; index -= 1) {
    value = value * 5 + (counts[index] ?? 0);
  }
  return value;
}

function unpackCounts(state: number, out: number[]): void {
  let value = state;
  for (let index = 0; index < HAND_TURNS_RANK_COUNT; index += 1) {
    const digit = value % 5;
    out[index] = digit;
    value = (value - digit) / 5;
  }
}

function lowestRank(counts: readonly number[]): number {
  for (let index = 0; index < HAND_TURNS_RANK_COUNT; index += 1) {
    if ((counts[index] ?? 0) > 0) {
      return index;
    }
  }
  return -1;
}

function distinctRankCount(counts: readonly number[]): number {
  let total = 0;
  for (let index = 0; index < HAND_TURNS_RANK_COUNT; index += 1) {
    if ((counts[index] ?? 0) > 0) {
      total += 1;
    }
  }
  return total;
}

/** Rank-count vector of a hand, indexed by `rankStrength`. */
export function handCounts(hand: readonly CardId[]): number[] {
  const counts = new Array<number>(HAND_TURNS_RANK_COUNT).fill(0);
  for (const cardId of hand) {
    const index = rankStrength(getCard(cardId).rank);
    counts[index] = (counts[index] ?? 0) + 1;
  }
  return counts;
}

type Emitter = (move: number) => void;

/**
 * Enumerates every legal play that consumes at least one card of rank `low`,
 * where `low` is the lowest rank present.
 *
 * That restriction is not a heuristic: in any partition, the cards of the
 * lowest present rank belong to some play, so branching on those plays alone
 * still reaches an optimal partition.
 *
 * `low` may be the play's main rank (or a member of its sequence core), or one
 * of its attachments — `4 7 555 666` is one play, with rank 4 as a wing, so
 * both families are required.
 */
function forEachMoveConsumingLow(counts: readonly number[], low: number, emit: Emitter): void {
  const move = new Array<number>(HAND_TURNS_RANK_COUNT).fill(0);
  const clear = () => {
    for (let index = 0; index < HAND_TURNS_RANK_COUNT; index += 1) {
      move[index] = 0;
    }
  };
  /** For the families with no nested recursion: set, emit, clear. */
  const emitAndClear = () => {
    emit(packCounts(move));
    clear();
  };

  const at = (rank: number) => counts[rank] ?? 0;
  const core = at(low);

  /* ---- low leads: single, pair, triple, bomb ---------------------------- */
  for (let size = 1; size <= 4; size += 1) {
    if (core >= size) {
      move[low] = size;
      emitAndClear();
    }
  }

  /* ---- low leads a triple, with one attachment -------------------------- */
  if (core >= 3) {
    for (let other = 0; other < HAND_TURNS_RANK_COUNT; other += 1) {
      if (other === low) {
        continue;
      }
      for (const taken of [1, 2]) {
        if (at(other) >= taken) {
          move[low] = 3;
          move[other] = taken;
          emitAndClear();
        }
      }
    }
  }

  /* ---- low leads a quad, with two single cards or two pairs ------------- */
  if (core >= 4) {
    forEachAttachment(counts, [[low, 4]], -1, 2, emit, move, "singles");
    forEachAttachment(counts, [[low, 4]], -1, 4, emit, move, "pairs");
  }

  /* ---- sequences whose core starts at low ------------------------------- */
  for (let length = 5; length <= MAX_STRAIGHT; length += 1) {
    if (low + length > SEQUENCE_RANK_COUNT) {
      break;
    }
    if (runOf(counts, low, length, 1)) {
      for (let offset = 0; offset < length; offset += 1) {
        move[low + offset] = 1;
      }
      emitAndClear();
    }
  }

  for (let length = 3; length <= MAX_CONSECUTIVE_PAIRS; length += 1) {
    if (low + length > SEQUENCE_RANK_COUNT) {
      break;
    }
    if (runOf(counts, low, length, 2)) {
      for (let offset = 0; offset < length; offset += 1) {
        move[low + offset] = 2;
      }
      emitAndClear();
    }
  }

  for (let length = 2; length <= MAX_AIRPLANE; length += 1) {
    if (low + length > SEQUENCE_RANK_COUNT) {
      break;
    }
    if (runOf(counts, low, length, 3)) {
      for (let offset = 0; offset < length; offset += 1) {
        move[low + offset] = 3;
      }
      emitAndClear();
    }
  }

  /* ---- airplanes whose core starts at low, carrying wings --------------- */
  for (let length = 2; length <= MAX_AIRPLANE_SINGLE_WINGS; length += 1) {
    if (low + length > SEQUENCE_RANK_COUNT) {
      break;
    }
    if (!runOf(counts, low, length, 3)) {
      continue;
    }
    const core2 = tripleRun(low, length);
    forEachAttachment(counts, core2, -1, length, emit, move, "singles");
  }

  for (let length = 2; length <= MAX_AIRPLANE_PAIR_WINGS; length += 1) {
    if (low + length > SEQUENCE_RANK_COUNT) {
      break;
    }
    if (!runOf(counts, low, length, 3)) {
      continue;
    }
    const core2 = tripleRun(low, length);
    forEachAttachment(counts, core2, -1, length * 2, emit, move, "pairs");
  }

  /* ---- low is an attachment to a higher core ---------------------------- */
  for (let rank = low + 1; rank < HAND_TURNS_RANK_COUNT; rank += 1) {
    if (at(rank) >= 3) {
      // The lowest rank can be the triple's single wing or its pair wing.
      move[rank] = 3;
      move[low] = 1;
      emitAndClear();
      if (at(low) >= 2) {
        move[rank] = 3;
        move[low] = 2;
        emitAndClear();
      }
    }
    if (at(rank) >= 4) {
      forEachAttachment(counts, [[rank, 4]], low, 2, emit, move, "singles");
      forEachAttachment(counts, [[rank, 4]], low, 4, emit, move, "pairs");
    }
  }

  for (let length = 2; length <= MAX_AIRPLANE_SINGLE_WINGS; length += 1) {
    for (let start = low + 1; start + length <= SEQUENCE_RANK_COUNT; start += 1) {
      if (!runOf(counts, start, length, 3)) {
        continue;
      }
      forEachAttachment(counts, tripleRun(start, length), low, length, emit, move, "singles");
    }
  }

  for (let length = 2; length <= MAX_AIRPLANE_PAIR_WINGS; length += 1) {
    for (let start = low + 1; start + length <= SEQUENCE_RANK_COUNT; start += 1) {
      if (!runOf(counts, start, length, 3)) {
        continue;
      }
      forEachAttachment(counts, tripleRun(start, length), low, length * 2, emit, move, "pairs");
    }
  }

  /* ---- the rocket, when the lowest present card is a joker -------------- */
  if (low === SMALL_JOKER && at(BIG_JOKER) >= 1) {
    move[SMALL_JOKER] = 1;
    move[BIG_JOKER] = 1;
    emitAndClear();
  }
}

/** True when `length` consecutive ranks from `start` each hold at least `perRank`. */
function runOf(
  counts: readonly number[],
  start: number,
  length: number,
  perRank: number,
): boolean {
  for (let offset = 0; offset < length; offset += 1) {
    if ((counts[start + offset] ?? 0) < perRank) {
      return false;
    }
  }
  return true;
}

function tripleRun(start: number, length: number): readonly (readonly [number, number])[] {
  return Array.from({ length }, (_unused, offset) => [start + offset, 3] as const);
}

/**
 * Adds every legal attachment set of `need` cards onto `move` (which already
 * holds the core), calling `emit` for each.
 *
 * `requiredRank` (when set) must contribute at least one card — that is how
 * "the lowest rank has to be consumed by this move" is honoured for moves
 * where it is an attachment rather than the core. `take` bounds how many cards
 * a single rank may contribute: 2 for single-card wings, exactly 2 for pairs.
 * The two jokers may not both appear among single-card wings, matching the
 * engine's own generator.
 */
function forEachAttachment(
  counts: readonly number[],
  core: readonly (readonly [number, number])[],
  requiredRank: number,
  needCards: number,
  emit: Emitter,
  move: number[],
  kind: "singles" | "pairs",
): void {
  const coreRanks = new Set(core.map(([rank]) => rank));
  const candidates: number[] = [];
  for (let rank = 0; rank < HAND_TURNS_RANK_COUNT; rank += 1) {
    if (coreRanks.has(rank)) {
      continue;
    }
    const available = counts[rank] ?? 0;
    if (kind === "pairs" ? available >= 2 : available >= 1) {
      candidates.push(rank);
    }
  }

  const requiredIsCore = requiredRank >= 0 && coreRanks.has(requiredRank);
  const emitFull = () => {
    for (const [rank, count] of core) {
      move[rank] = count;
    }
    const satisfied = requiredIsCore || requiredRank < 0 || (move[requiredRank] ?? 0) > 0;
    const bothJokers =
      (move[SMALL_JOKER] ?? 0) > 0 && (move[BIG_JOKER] ?? 0) > 0;
    if (satisfied && !(kind === "singles" && bothJokers)) {
      emit(packCounts(move));
    }
    for (const [rank] of core) {
      move[rank] = 0;
    }
  };

  const step = kind === "pairs" ? 2 : 1;
  const choose = (index: number, remaining: number): void => {
    if (remaining === 0) {
      emitFull();
      return;
    }
    if (index >= candidates.length) {
      return;
    }
    const rank = candidates[index]!;
    const maximum = kind === "pairs" ? 1 : Math.min(2, counts[rank] ?? 0);
    for (let used = 0; used <= maximum; used += 1) {
      const cards = used * step;
      if (cards > remaining) {
        break;
      }
      move[rank] = cards;
      choose(index + 1, remaining - cards);
      move[rank] = 0;
    }
  };

  choose(0, needCards);
}

/**
 * Every legal play of `counts` that consumes the lowest present rank, as
 * count vectors. Exposed because it is the module's contract with the engine:
 * the test compares this set against `generateLegalActions` rather than
 * trusting the branch analysis above.
 */
export function movesConsumingLowest(counts: readonly number[]): readonly (readonly number[])[] {
  const low = lowestRank(counts);
  if (low < 0) {
    return Object.freeze([]);
  }
  const moves: number[][] = [];
  forEachMoveConsumingLow(counts, low, (packed) => {
    const move = new Array<number>(HAND_TURNS_RANK_COUNT).fill(0);
    unpackCounts(packed, move);
    moves.push(move);
  });
  return Object.freeze(moves.map((move) => Object.freeze(move)));
}

export type HandTurnSolverStats = Readonly<{
  /** Calls to `minimumHands`. */
  calls: number;
  /** Calls answered from the memo table. */
  cacheHits: number;
  /** Search nodes expanded. */
  nodes: number;
  /** True when a search hit its node budget and returned a bound, not an optimum. */
  exhausted: boolean;
}>;

export interface HandTurnSolver {
  readonly minimumHands: (hand: readonly CardId[]) => number;
  readonly stats: () => HandTurnSolverStats;
}

/**
 * A solver with its own memo table. The table is the reason this is a factory
 * rather than a plain function: the memo has to have a bounded lifetime, and
 * the natural one is a single decision — 24 leaves × 3 hands share it, and it
 * dies with the decision instead of growing for the length of a match.
 */
export function createHandTurnSolver(
  options: Readonly<{ maxNodes?: number }> = {},
): HandTurnSolver {
  const maxNodes = Math.max(1, options.maxNodes ?? 20_000);
  const memo = new Map<number, number>();
  // Scratch, refilled on entry to every `search` call. `moves` must be local to
  // each call: the recursion below fills its own, and a shared array would be
  // truncated mid-iteration by the callee.
  const counts = new Array<number>(HAND_TURNS_RANK_COUNT).fill(0);
  const state = { calls: 0, cacheHits: 0, nodes: 0, exhausted: false, cutOffs: 0 };

  function search(hand: number, budget: { remaining: number }): number {
    if (hand === 0) {
      return 0;
    }
    const cached = memo.get(hand);
    if (cached !== undefined) {
      state.cacheHits += 1;
      return cached;
    }
    if (budget.remaining <= 0) {
      state.exhausted = true;
      state.cutOffs += 1;
      unpackCounts(hand, counts);
      return distinctRankCount(counts);
    }
    budget.remaining -= 1;
    state.nodes += 1;

    unpackCounts(hand, counts);
    // Playing each rank on its own is always legal, so this is a real
    // partition and therefore a valid upper bound to improve on.
    let best = distinctRankCount(counts);
    let exact = true;
    if (best > 1) {
      const moves: number[] = [];
      forEachMoveConsumingLow(counts, lowestRank(counts), (move) => {
        moves.push(move);
      });
      for (const move of moves) {
        const cutsBefore = state.cutOffs;
        const value = 1 + search(hand - move, budget);
        if (state.cutOffs !== cutsBefore) {
          exact = false;
        }
        if (value < best) {
          best = value;
          if (best <= 1) {
            break;
          }
        }
      }
    }

    // Only an exhaustive result may be cached. A value produced with the node
    // budget exhausted is still a valid upper bound, so caching it would not
    // break the contract — but it would make the answer depend on visit order,
    // because a later visit with budget to spare would be served the weaker
    // bound instead of computing a better one.
    if (exact) {
      memo.set(hand, best);
    }
    return best;
  }

  return Object.freeze({
    minimumHands(hand: readonly CardId[]): number {
      state.calls += 1;
      return search(packCounts(handCounts(hand)), { remaining: maxNodes });
    },
    stats() {
      return Object.freeze({ ...state });
    },
  });
}
