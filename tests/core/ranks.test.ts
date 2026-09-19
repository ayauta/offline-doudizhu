import { describe, expect, it } from "vitest";

import { STANDARD_RANKS, type Rank } from "../../src/core/cards/index.js";
import {
  MAX_SEQUENCE_RANK_STRENGTH,
  RANK_ORDER,
  SEQUENCE_RANKS,
  rankStrength,
} from "../../src/core/rules/index.js";

describe("rank order", () => {
  it("puts the standard ranks in ascending order below both jokers", () => {
    expect(RANK_ORDER).toEqual([...STANDARD_RANKS, "small-joker", "big-joker"]);
  });

  it("gives every rank a strength equal to its position", () => {
    expect(RANK_ORDER.map((rank) => rankStrength(rank))).toEqual(
      RANK_ORDER.map((_, index) => index),
    );
  });

  it("rejects a rank outside the canonical order", () => {
    expect(() => rankStrength("joker" as Rank)).toThrow(/Unknown rank/);
  });

  it("keeps the ace as the highest rank a sequence may run to", () => {
    expect(RANK_ORDER[MAX_SEQUENCE_RANK_STRENGTH]).toBe("A");
    expect(rankStrength("2")).toBeGreaterThan(MAX_SEQUENCE_RANK_STRENGTH);
  });

  it("excludes the two and the jokers from sequence ranks", () => {
    expect(SEQUENCE_RANKS).toEqual(STANDARD_RANKS.slice(0, -1));
    expect(SEQUENCE_RANKS).not.toContain("2");
  });
});
