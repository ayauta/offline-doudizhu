/**
 * The E1 calibration corpus: a frozen set of `rootUtility` leaves, replayable
 * offline.
 *
 * Why this exists: `rootUtility` evaluates 24 leaves per master decision
 * (3 candidates × 8 worlds), each covering three hands. Comparing a future
 * evaluator against the shipped one should not require re-running 400 deals
 * every time — it should be a few seconds over a fixed corpus. The corpus
 * stores the leaves themselves, so `d_new`, `k`/`b`, the value correlation and
 * the effect gate are all offline computations.
 *
 * A leaf is fully described by its three hands: 斗地主 has no suit-dependent
 * pattern or comparison, so a rank-count vector is lossless for evaluation.
 * Counts are packed base-5 (max 4 of a rank) into one integer per seat, indexed
 * by `rankStrength` — index 13 is the small joker, 14 the big joker.
 *
 * Regenerating the corpus needs the instrumentation patch archived under
 * `docs/research/057-leaf-harvest/`; *reading* it needs nothing but this file.
 * See docs/specs/057-root-utility-leaf-value/spec.md.
 */
import { asCardId, getCard, type CardId } from "../src/core/cards/index.js";
import { SEAT_ORDER, type Seat } from "../src/core/game/index.js";
import { rankStrength } from "../src/core/rules/index.js";

/** Number of distinct ranks in the strength order: 3..2, small joker, big joker. */
export const RANK_COUNT = 15;

export type SeatHands = Readonly<Record<Seat, readonly CardId[]>>;

/** One leaf: the state `rootUtility` scores, plus which candidate/world it came from. */
export type CorpusLeaf = Readonly<{
  world: number;
  candidate: number;
  /** Seat that emptied its hand at this leaf, or null if the game is still live. */
  winner: Seat | null;
  /** Packed base-5 rank counts, in `SEAT_ORDER` order. */
  packed: readonly [number, number, number];
}>;

export type CorpusDecision = Readonly<{
  /** Absolute deal index — the seed is `seedBase + deal`. */
  deal: number;
  /** Arm A: the strong level holds the landlord seat. Arm B: it holds a farmer seat. */
  arm: "A" | "B";
  landlord: Seat;
  /** The seat that made this decision (always the profiled level). */
  seat: Seat;
  /** Seed handed to the decision, as the harness derives it. */
  gameSeed: number;
  legalActions: number;
  completedWorlds: number;
  /** The expert ranking's score per candidate, before the rollout blend. */
  expertScores: readonly number[];
  /** Index into `expertScores` of the candidate the shipped code actually chose. */
  chosen: number;
  leaves: readonly CorpusLeaf[];
}>;

export type CorpusShard = Readonly<{
  shard: Readonly<{ dealStart: number; deals: number; seedBase: number }>;
  decisions: readonly CorpusDecision[];
}>;

/** Packs a hand's rank counts into one integer (base 5, 15 digits). */
export function packHand(cards: readonly CardId[]): number {
  const counts = new Array<number>(RANK_COUNT).fill(0);
  for (const cardId of cards) {
    const index = rankStrength(getCard(cardId).rank);
    counts[index] = (counts[index] ?? 0) + 1;
  }
  let packed = 0;
  for (let index = RANK_COUNT - 1; index >= 0; index -= 1) {
    packed = packed * 5 + (counts[index] ?? 0);
  }
  return packed;
}

/** Unpacks to rank counts, index 0 = rank 3 … 12 = rank 2, 13/14 = jokers. */
export function unpackCounts(packed: number): readonly number[] {
  const counts: number[] = [];
  let value = packed;
  for (let index = 0; index < RANK_COUNT; index += 1) {
    counts.push(value % 5);
    value = Math.floor(value / 5);
  }
  return counts;
}

/**
 * Expands packed counts back into a canonical card list. Suits are arbitrary —
 * they carry no meaning in this game — but the mapping is stable, so an
 * evaluator that takes `CardId[]` sees byte-identical input on every replay.
 */
export function expandHand(packed: number): CardId[] {
  const counts = unpackCounts(packed);
  const cards: CardId[] = [];
  for (let rank = 0; rank < 13; rank += 1) {
    for (let suit = 0; suit < (counts[rank] ?? 0); suit += 1) {
      cards.push(asCardId(rank * 4 + suit));
    }
  }
  if ((counts[13] ?? 0) > 0) {
    cards.push(asCardId(52));
  }
  if ((counts[14] ?? 0) > 0) {
    cards.push(asCardId(53));
  }
  return cards;
}

export function handSizes(leaf: CorpusLeaf): readonly [number, number, number] {
  return [
    unpackCounts(leaf.packed[0]).reduce((sum, count) => sum + count, 0),
    unpackCounts(leaf.packed[1]).reduce((sum, count) => sum + count, 0),
    unpackCounts(leaf.packed[2]).reduce((sum, count) => sum + count, 0),
  ] as const;
}

/** A hand-turn estimator: same signature as `estimateBasicHandTurns`. */
export type TurnEvaluator = (hand: readonly CardId[]) => number;

/**
 * The turns difference `rootUtility` multiplies by 220 — recomputed from the
 * leaf, exactly as the shipped code computes it. Friend/enemy is decided by the
 * acting seat's side, so the value is only meaningful together with `decision`.
 */
export function turnsDifference(
  decision: CorpusDecision,
  leaf: CorpusLeaf,
  evaluate: TurnEvaluator,
): Readonly<{ friendly: number; enemy: number; difference: number }> {
  let friendly = 0;
  let enemy = 0;
  SEAT_ORDER.forEach((seat, index) => {
    const packed = leaf.packed[index];
    if (packed === undefined) {
      return;
    }
    const turns = evaluate(expandHand(packed));
    const sameSide = decision.seat === decision.landlord
      ? seat === decision.landlord
      : seat !== decision.landlord;
    if (sameSide) {
      friendly += turns;
    } else {
      enemy += turns;
    }
  });
  return Object.freeze({ friendly, enemy, difference: enemy - friendly });
}

/** Card-count difference over the same side split as `turnsDifference`. */
export function cardsDifference(
  decision: CorpusDecision,
  leaf: CorpusLeaf,
): Readonly<{ friendly: number; enemy: number; difference: number }> {
  const sizes = handSizes(leaf);
  let friendly = 0;
  let enemy = 0;
  SEAT_ORDER.forEach((seat, index) => {
    const sameSide = decision.seat === decision.landlord
      ? seat === decision.landlord
      : seat !== decision.landlord;
    if (sameSide) {
      friendly += sizes[index] ?? 0;
    } else {
      enemy += sizes[index] ?? 0;
    }
  });
  return Object.freeze({ friendly, enemy, difference: enemy - friendly });
}

/** The shipped `rootUtility`, replayed from the corpus. */
export const ROOT_UTILITY_TURNS_WEIGHT = 220;
export const ROOT_UTILITY_CARDS_WEIGHT = 24;
export const ROOT_UTILITY_TERMINAL = 10_000;

export function shippedUtility(
  decision: CorpusDecision,
  leaf: CorpusLeaf,
  evaluate: TurnEvaluator,
): number {
  if (leaf.winner !== null) {
    const sameSide = decision.seat === decision.landlord
      ? leaf.winner === decision.landlord
      : leaf.winner !== decision.landlord;
    return sameSide ? ROOT_UTILITY_TERMINAL : -ROOT_UTILITY_TERMINAL;
  }
  const turns = turnsDifference(decision, leaf, evaluate).difference;
  const cards = cardsDifference(decision, leaf).difference;
  return turns * ROOT_UTILITY_TURNS_WEIGHT + cards * ROOT_UTILITY_CARDS_WEIGHT;
}

/** Mean and sample standard deviation of a vector. */
export function moments(values: readonly number[]): Readonly<{ mean: number; sd: number }> {
  if (values.length === 0) {
    return Object.freeze({ mean: 0, sd: 0 });
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (values.length < 2) {
    return Object.freeze({ mean, sd: 0 });
  }
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Object.freeze({ mean, sd: Math.sqrt(variance) });
}

/** Pearson correlation, for checking that a new evaluator tracks the old one. */
export function correlation(left: readonly number[], right: readonly number[]): number {
  const n = Math.min(left.length, right.length);
  if (n < 2) {
    return 0;
  }
  const a = moments(left.slice(0, n));
  const b = moments(right.slice(0, n));
  if (a.sd === 0 || b.sd === 0) {
    return 0;
  }
  let covariance = 0;
  for (let index = 0; index < n; index += 1) {
    covariance += ((left[index] ?? 0) - a.mean) * ((right[index] ?? 0) - b.mean);
  }
  covariance /= n - 1;
  return covariance / (a.sd * b.sd);
}
