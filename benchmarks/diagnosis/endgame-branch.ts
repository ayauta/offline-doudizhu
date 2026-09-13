/**
 * Offline prototype of the exact endgame branch (Spec 026 design).
 *
 * Given a decision the shipped master actually faced, and the belief state
 * derived from its own public view, this enumerates **every** opponent hand the
 * seat's information allows, solves each exactly, and proposes an action by one
 * of two aggregates:
 *
 *   maximin    — best worst case; a guarantee against every consistent hand
 *   expected   — most wins across the enumerated hands
 *
 * Both are computed so the two can be compared; neither is shipped.
 *
 * The belief state mirrors `sampleWithRandom` in `master-policy.ts` exactly, so
 * the worlds enumerated here are the same population the sampler draws from —
 * the branch differs in covering all of them rather than sampling 32.
 *
 * Research scaffolding. Not shipped, not imported by `src/`.
 */

import { createDeck, type CardId } from "../../src/core/cards/index.js";
import type { PlayingPlayerView } from "../../src/core/ai/index.js";
import type { GameState, Seat } from "../../src/core/game/index.js";
import { playingOf, solveRootActions } from "./exact-solver.js";

const SEATS: readonly Seat[] = Object.freeze(["human", "ai-one", "ai-two"]);

/** Hands the seat can see: its own, plus the bottom cards when it is a farmer. */
function knownCards(view: PlayingPlayerView): Set<CardId> {
  const known = new Set<CardId>(view.hand);
  if (view.landlord !== view.seat) {
    for (const card of view.bottomCards) {
      known.add(card);
    }
  }
  for (const entry of view.history) {
    if (entry.type === "play") {
      for (const card of entry.play.cards) {
        known.add(card);
      }
    }
  }
  return known;
}

export type BeliefState = Readonly<{
  /** Cards no seat has revealed and the acting seat does not hold. */
  pool: readonly CardId[];
  /** The two opponents and how many pool cards each must hold. */
  opponents: readonly Readonly<{ seat: Seat; count: number }>[];
  /** The opponent whose hand is enumerated; the larger one is derived. */
  smallerSeat: Seat;
  smallerCount: number;
  worlds: number;
}>;

/** The population the shipped sampler draws from, expressed as an enumeration. */
export function beliefOf(view: PlayingPlayerView): BeliefState | null {
  const known = knownCards(view);
  const pool = createDeck().filter((card) => !known.has(card));

  const opponents = SEATS
    .filter((seat) => seat !== view.seat)
    .map((seat) => ({ seat, count: view.remainingCardCounts[seat] }));
  const total = opponents.reduce((sum, entry) => sum + entry.count, 0);
  if (total !== pool.length) {
    // The public counts must account for every unseen card, or the position is
    // not one the sampler could represent either.
    return null;
  }
  const sorted = [...opponents].sort((left, right) => left.count - right.count);
  const smaller = sorted[0];
  if (smaller === undefined) {
    return null;
  }
  const combinations = (n: number, k: number): number => {
    let value = 1;
    for (let index = 1; index <= Math.min(k, n - k); index += 1) {
      value = (value * (n - index + 1)) / index;
      if (value > 1e7) {
        return Number.POSITIVE_INFINITY;
      }
    }
    return Math.round(value);
  };
  return Object.freeze({
    pool: Object.freeze(pool),
    opponents: Object.freeze(opponents),
    smallerSeat: smaller.seat,
    smallerCount: smaller.count,
    worlds: combinations(pool.length, smaller.count),
  });
}

/** Every way to give the smaller opponent `count` cards from the pool. */
export function* worldHands(belief: BeliefState): Generator<readonly CardId[]> {
  const { pool, smallerCount } = belief;
  const chosen: CardId[] = [];
  function* walk(start: number): Generator<readonly CardId[]> {
    if (chosen.length === smallerCount) {
      yield Object.freeze([...chosen]);
      return;
    }
    for (let index = start; index < pool.length; index += 1) {
      const card = pool[index];
      if (card === undefined) {
        continue;
      }
      chosen.push(card);
      yield* walk(index + 1);
      chosen.pop();
    }
  }
  yield* walk(0);
}

/** Builds a concrete state from a decision plus one enumerated opponent hand. */
export function stateForWorld(
  state: GameState,
  belief: BeliefState,
  smallerHand: readonly CardId[],
): GameState {
  const hands = (state as Extract<GameState, { readonly hands: unknown }>).hands;
  const smaller = new Set(smallerHand);
  const largerSeat = belief.opponents.find((entry) => entry.seat !== belief.smallerSeat);
  const largerHand = belief.pool.filter((card) => !smaller.has(card));
  return Object.freeze({
    ...(state as object),
    hands: Object.freeze({
      ...hands,
      [belief.smallerSeat]: Object.freeze([...smallerHand]),
      ...(largerSeat === undefined ? {} : { [largerSeat.seat]: Object.freeze([...largerHand]) }),
    }),
  }) as GameState;
}

export type BranchProposal = Readonly<{
  /** The action the branch proposes, as a sorted card key or "pass". */
  choice: string;
  /**
   * The action the expected-value aggregate would have led with. Returned so a
   * caller can compare the two aggregates by their choices: `maximin` is 0/1
   * under the "wins in every world" reading, so comparing it against the
   * expected *rate* answers a different question and reports a difference for
   * every position where the two agree.
   */
  expectedChoice: string;
  maximin: number;
  expected: number;
  worlds: number;
  nodes: number;
  completed: boolean;
}>;

/**
 * Enumerates worlds, solves each, and scores every root action the shipped
 * shortlist would consider (all legal actions here) under both aggregates.
 */
export function proposeExact(
  state: GameState,
  options: Readonly<{ nodeCapPerWorld?: number; maxWorlds?: number }> = {},
): BranchProposal | null {
  const playing = playingOf(state);
  if (playing === null) {
    return null;
  }
  const belief = beliefOf(playing.view);
  if (belief === null) {
    return null;
  }
  const nodeCapPerWorld = options.nodeCapPerWorld ?? 200_000;
  const maxWorlds = options.maxWorlds ?? 20_000;

  const wins = new Map<string, number>();
  const totals = new Map<string, number>();
  let nodes = 0;
  let worlds = 0;
  let completed = true;

  // One table for the whole enumeration. Neighbouring worlds differ by a single
  // card, so their subtrees largely coincide; a per-world table would rebuild
  // what the previous world already settled.
  const sharedTable = new Map<string, boolean>();

  for (const smallerHand of worldHands(belief)) {
    if (worlds >= maxWorlds) {
      completed = false;
      break;
    }
    worlds += 1;
    const world = stateForWorld(state, belief, smallerHand);
    // One search per world serves every root action: the root's options share
    // almost all of their subtree, so solving them separately would rebuild it
    // once per action. An earlier prototype did exactly that and paid for it.
    const solved = solveRootActions(world, { nodeCap: nodeCapPerWorld, table: sharedTable });
    nodes += solved.nodes;
    if (!solved.completed) {
      completed = false;
      continue;
    }
    for (const value of solved.values) {
      totals.set(value.key, (totals.get(value.key) ?? 0) + 1);
      if (value.sideWins) {
        wins.set(value.key, (wins.get(value.key) ?? 0) + 1);
      }
    }
  }

  // Each action is scored by its worst world (maximin) and by its win rate over
  // all worlds (expected). Both are computed over the same enumeration, so the
  // two differ only in the aggregate, which is the comparison being made.
  const perAction = new Map<string, { worst: number; rate: number }>();
  for (const [key, total] of totals) {
    const wins_ = wins.get(key) ?? 0;
    perAction.set(key, { worst: wins_ === total ? 1 : 0, rate: wins_ / Math.max(1, total) });
  }

  let bestMaximin: { key: string; value: number } | null = null;
  let bestExpected: { key: string; value: number } | null = null;
  for (const [key, score] of perAction) {
    if (bestMaximin === null || score.worst > bestMaximin.value) {
      bestMaximin = { key, value: score.worst };
    }
    if (bestExpected === null || score.rate > bestExpected.value) {
      bestExpected = { key, value: score.rate };
    }
  }

  if (bestMaximin === null || bestExpected === null) {
    return null;
  }
  return Object.freeze({
    choice: bestMaximin.key,
    expectedChoice: bestExpected.key,
    maximin: bestMaximin.value,
    expected: bestExpected.value,
    worlds,
    nodes,
    completed,
  });
}
