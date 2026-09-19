import { describe, expect, it } from "vitest";

import { asCardId, getCard } from "../../src/core/cards/index.js";
import { cardIds, seededRandom } from "../support/harness.js";

describe("shared test harness", () => {
  it("builds a run of suits in canonical order", () => {
    expect(cardIds(["3", 4])).toEqual([0, 1, 2, 3].map((id) => asCardId(id)));
    expect(cardIds(["K", 2], ["A", 1]).map((cardId) => getCard(cardId).rank))
      .toEqual(["K", "K", "A"]);
  });

  it("places each joker once", () => {
    expect(cardIds(["small-joker", 1], ["big-joker", 1]))
      .toEqual([asCardId(52), asCardId(53)]);
  });

  it("rejects a group that would silently spill into the next rank", () => {
    expect(() => cardIds(["3", 5])).toThrow(/Invalid test card group/);
    expect(() => cardIds(["3", 0])).toThrow(/Invalid test card group/);
    expect(() => cardIds(["3", 1.5])).toThrow(/Invalid test card group/);
  });

  it("rejects a rank that is not a card and a doubled joker", () => {
    expect(() => cardIds(["joker" as never, 1])).toThrow(/Invalid test card group/);
    expect(() => cardIds(["big-joker", 2])).toThrow(/exactly one card/);
  });

  it("produces a repeatable sequence that stays inside [0, 1)", () => {
    const first = seededRandom(77);
    const second = seededRandom(77);
    const draws = Array.from({ length: 20 }, () => first.next());

    expect(draws).toEqual(Array.from({ length: 20 }, () => second.next()));
    expect(draws.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(new Set(draws).size).toBeGreaterThan(1);
  });
});
