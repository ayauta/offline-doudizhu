import { expect } from "vitest";

import {
  STANDARD_RANKS,
  asCardId,
  type CardId,
  type RandomSource,
  type Rank,
} from "../../src/core/cards/index.js";

/**
 * Asserts that a value and everything reachable from it is frozen, so a test can
 * catch a transition leaking mutable state instead of only checking the shape.
 */
export function expectDeepFrozen(value: unknown): void {
  if (typeof value !== "object" || value === null) {
    return;
  }
  expect(Object.isFrozen(value)).toBe(true);
  for (const nested of Object.values(value)) {
    expectDeepFrozen(nested);
  }
}

export type CardGroup = readonly [rank: Rank, count: number];

/**
 * Builds canonical card IDs from rank groups. Four copies of this once drifted
 * apart, and the laxest of them turned `["3", 5]` into a silent four and a four,
 * so the checks live here where every test gets them.
 */
export function cardIds(...groups: readonly CardGroup[]): CardId[] {
  const result: CardId[] = [];
  for (const [rank, count] of groups) {
    if (rank === "small-joker" || rank === "big-joker") {
      if (count !== 1) {
        throw new Error(`A joker group must contain exactly one card: ${rank} x ${count}.`);
      }
      result.push(asCardId(rank === "small-joker" ? 52 : 53));
      continue;
    }
    const rankIndex = STANDARD_RANKS.indexOf(rank);
    if (rankIndex < 0 || !Number.isInteger(count) || count < 1 || count > 4) {
      throw new Error(`Invalid test card group: ${rank} x ${count}.`);
    }
    for (let suitIndex = 0; suitIndex < count; suitIndex += 1) {
      result.push(asCardId(rankIndex * 4 + suitIndex));
    }
  }
  return result;
}

/**
 * The same linear congruential generator the enhanced AI seeds its sampling with,
 * exposed so a test can pin a deal or a search without touching global randomness.
 */
export function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return {
    next(): number {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    },
  };
}
