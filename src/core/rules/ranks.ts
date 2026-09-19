import {
  STANDARD_RANKS,
  type Rank,
  type StandardRank,
} from "../cards/index.js";

export const RANK_ORDER: readonly Rank[] = Object.freeze([
  ...STANDARD_RANKS,
  "small-joker",
  "big-joker",
]);

// The two and the jokers cannot appear inside a sequence, so every consumer that
// walks runs needs this shorter ladder rather than a slice of its own.
export const SEQUENCE_RANKS: readonly StandardRank[] = Object.freeze(
  STANDARD_RANKS.slice(0, -1),
);

export const MAX_SEQUENCE_RANK_STRENGTH = STANDARD_RANKS.indexOf("A");

export function rankStrength(rank: Rank): number {
  const strength = RANK_ORDER.indexOf(rank);
  if (strength < 0) {
    throw new Error(`Unknown rank: ${rank}.`);
  }
  return strength;
}
