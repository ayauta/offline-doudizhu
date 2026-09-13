/**
 * Research scaffolding — Spec 054 divergence categories.
 *
 * Two families, kept apart on purpose:
 *
 *  - **position** features answer "where do the arms disagree" and are computed
 *    from the board alone;
 *  - **action** features answer "what do they disagree about" and compare the
 *    two actions.
 *
 * No category is defined by *which arm* chose an action. Defining a group by the
 * outcome and then testing it for an outcome is how this kind of analysis fools
 * itself, so every predicate below takes a board and an action -- never an arm.
 *
 * Thresholds are frozen here, before any outcome was inspected. Delete with the
 * rest of `benchmarks/diagnosis/`.
 */

import { asCardId, getCard, type CardId } from "../../src/core/cards/index.js";
import type { Seat } from "../../src/core/game/index.js";
import type { ProbeRecord } from "./harvest.js";

/** A seat is nearly out at or below this many cards. */
export const LOW_CARD_THRESHOLD = 2;

/** Hands at or below this size are the endgame the owner described. */
export const ENDGAME_HAND_SIZE = 7;

export type DivergenceCategory =
  | "endgame-low-cards"
  | "farmer-partner-nearly-out"
  | "breaks-control"
  | "opening-twenty-cards"
  | "midgame-other";

/** Fixed priority order; the last entry is the residual, never hidden. */
export const CATEGORY_ORDER: readonly DivergenceCategory[] = Object.freeze([
  "endgame-low-cards",
  "farmer-partner-nearly-out",
  "breaks-control",
  "opening-twenty-cards",
  "midgame-other",
]);

function rankCounts(cards: readonly CardId[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const cardId of cards) {
    const { rank } = getCard(cardId);
    counts.set(rank, (counts.get(rank) ?? 0) + 1);
  }
  return counts;
}

function choiceToCards(choice: string): readonly CardId[] | "pass" {
  if (choice === "pass") {
    return "pass";
  }
  return choice.split(",").map((value) => asCardId(Number(value)));
}

/** True when the action spends part of a four-of-a-kind, a rocket, or a triple. */
export function breaksControl(actionCards: readonly CardId[], hand: readonly CardId[]): boolean {
  const held = rankCounts(hand);
  const used = rankCounts(actionCards);
  for (const [rank, count] of used) {
    const available = held.get(rank) ?? 0;
    if (available === 4 && count < 4) {
      return true;
    }
    if (available === 3 && count < 3) {
      return true;
    }
  }
  return false;
}

/** True when the hand still holds a four-of-a-kind or a rocket after the action. */
export function retainsControl(actionCards: readonly CardId[], hand: readonly CardId[]): boolean {
  const spent = new Set(actionCards);
  return holdsControl(hand.filter((card) => !spent.has(card)));
}

/** True when the hand holds a four-of-a-kind or a rocket. */
export function holdsControl(hand: readonly CardId[]): boolean {
  const counts = rankCounts(hand);
  for (const count of counts.values()) {
    if (count === 4) {
      return true;
    }
  }
  return (counts.get("small-joker") ?? 0) > 0 && (counts.get("big-joker") ?? 0) > 0;
}

/** The farmer seat sharing a side with `seat`, if any. */
export function partnerSeat(seat: Seat, landlord: Seat): Seat | null {
  if (seat === landlord) {
    return null;
  }
  return (
    (["human", "ai-one", "ai-two"] as const).find(
      (candidate) => candidate !== seat && candidate !== landlord,
    ) ?? null
  );
}

/** True when the acting seat is a farmer whose partner is nearly out. */
export function partnerNearlyOut(record: ProbeRecord): boolean {
  const partner = partnerSeat(record.seat, record.landlord);
  if (partner === null) {
    return false;
  }
  return record.snapshot.remainingCardCounts[partner] <= LOW_CARD_THRESHOLD;
}

/**
 * Exactly one category per decision, in a fixed priority order. The first two
 * are the owner's stated concerns; the residual is reported so a category can
 * never quietly absorb everything.
 */
export function categorise(record: ProbeRecord): DivergenceCategory {
  if (record.handSize <= ENDGAME_HAND_SIZE) {
    return "endgame-low-cards";
  }
  if (partnerNearlyOut(record)) {
    return "farmer-partner-nearly-out";
  }
  const shipped = choiceToCards(record.shippedChoice);
  const candidate = choiceToCards(record.candidateChoice);
  const breaks = (choice: readonly CardId[] | "pass"): boolean =>
    choice !== "pass" && breaksControl(choice, record.snapshot.hand);
  if (breaks(shipped) || breaks(candidate)) {
    return "breaks-control";
  }
  return record.handSize >= 20 ? "opening-twenty-cards" : "midgame-other";
}

export type CategoryTally = Readonly<{
  category: DivergenceCategory;
  decisions: number;
  divergences: number;
}>;

/** Tallies every decision, so a category with zero divergences is still visible. */
export function tally(records: readonly ProbeRecord[]): readonly CategoryTally[] {
  const buckets = new Map<DivergenceCategory, { decisions: number; divergences: number }>();
  for (const category of CATEGORY_ORDER) {
    buckets.set(category, { decisions: 0, divergences: 0 });
  }
  for (const record of records) {
    const bucket = buckets.get(categorise(record));
    if (bucket === undefined) {
      continue;
    }
    bucket.decisions += 1;
    if (record.diverges) {
      bucket.divergences += 1;
    }
  }
  return Object.freeze(
    CATEGORY_ORDER.map((category) =>
      Object.freeze({ category, ...(buckets.get(category) ?? { decisions: 0, divergences: 0 }) }),
    ),
  );
}
