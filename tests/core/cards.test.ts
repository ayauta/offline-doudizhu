import { describe, expect, it } from "vitest";

import {
  CARD_COUNT,
  STANDARD_RANKS,
  SUITS,
  asCardId,
  compareCardIds,
  createDeck,
  getCard,
  shuffle,
  type RandomSource,
  type StandardCard,
} from "../../src/core/cards/index.js";

function sequenceRandom(samples: readonly number[]): RandomSource {
  let index = 0;

  return {
    next() {
      const sample = samples[index];
      if (sample === undefined) {
        throw new Error("Test random sequence exhausted.");
      }
      index += 1;
      return sample;
    },
  };
}

describe("canonical Dou Dizhu deck", () => {
  it("contains exactly 54 unique physical cards", () => {
    const deck = createDeck();
    const cards = deck.map(getCard);

    expect(deck).toHaveLength(CARD_COUNT);
    expect(new Set(deck).size).toBe(CARD_COUNT);
    expect(cards.filter((card) => card.kind === "standard")).toHaveLength(52);
    expect(cards.filter((card) => card.kind === "joker")).toEqual([
      { id: asCardId(52), kind: "joker", rank: "small-joker" },
      { id: asCardId(53), kind: "joker", rank: "big-joker" },
    ]);
  });

  it("maps every standard rank to all four suits in stable order", () => {
    const cards = createDeck().map(getCard);

    for (const rank of STANDARD_RANKS) {
      const rankCards = cards.filter(
        (card): card is StandardCard => card.kind === "standard" && card.rank === rank,
      );
      expect(rankCards.map((card) => card.suit)).toEqual(SUITS);
    }

    expect(getCard(asCardId(0))).toEqual({
      id: asCardId(0),
      kind: "standard",
      rank: "3",
      suit: "clubs",
    });
    expect(getCard(asCardId(51))).toEqual({
      id: asCardId(51),
      kind: "standard",
      rank: "2",
      suit: "spades",
    });
  });

  it("rejects values outside the canonical card ID range", () => {
    expect(() => asCardId(-1)).toThrow(RangeError);
    expect(() => asCardId(54)).toThrow(RangeError);
    expect(() => asCardId(1.5)).toThrow(RangeError);
  });

  it("sorts IDs in canonical rank-major order", () => {
    const ids = [asCardId(53), asCardId(4), asCardId(0), asCardId(52)];
    expect([...ids].sort(compareCardIds)).toEqual([
      asCardId(0),
      asCardId(4),
      asCardId(52),
      asCardId(53),
    ]);
  });
});

describe("injectable deterministic shuffle", () => {
  it("is reproducible, non-mutating, and preserves every item", () => {
    const input = ["a", "b", "c", "d"] as const;
    const first = shuffle(input, sequenceRandom([0, 0.5, 0.999]));
    const second = shuffle(input, sequenceRandom([0, 0.5, 0.999]));

    expect(first).toEqual(["d", "c", "b", "a"]);
    expect(second).toEqual(first);
    expect(input).toEqual(["a", "b", "c", "d"]);
    expect([...first].sort()).toEqual([...input].sort());
  });

  it.each([-0.01, 1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects the invalid random sample %s",
    (sample) => {
      expect(() => shuffle([1, 2], sequenceRandom([sample]))).toThrow(RangeError);
    },
  );
});
