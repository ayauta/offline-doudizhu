import {
  STANDARD_RANKS,
  type Rank,
} from "../cards/index.js";

export const RANK_ORDER: readonly Rank[] = Object.freeze([
  ...STANDARD_RANKS,
  "small-joker",
  "big-joker",
]);

export const MAX_SEQUENCE_RANK_STRENGTH = STANDARD_RANKS.indexOf("A");

export function rankStrength(rank: Rank): number {
  const strength = RANK_ORDER.indexOf(rank);
  if (strength < 0) {
    throw new Error(`Unknown rank: ${rank}.`);
  }
  return strength;
}
