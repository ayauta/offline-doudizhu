import { describe, expect, it } from "vitest";

import {
  STANDARD_RANKS,
  asCardId,
  compareCardIds,
  createDeck,
  type CardId,
  type Rank,
  type StandardRank,
} from "../../src/core/cards/index.js";
import {
  classifyPlay,
  comparePlays,
  type ClassifiedPlay,
  type ClassificationErrorCode,
} from "../../src/core/rules/index.js";

type CardGroup = readonly [rank: Rank, count: number];

function cardIds(...groups: readonly CardGroup[]): CardId[] {
  const result: CardId[] = [];

  for (const [rank, count] of groups) {
    if (rank === "small-joker") {
      if (count !== 1) {
        throw new Error("The small joker can occur only once.");
      }
      result.push(asCardId(52));
      continue;
    }

    if (rank === "big-joker") {
      if (count !== 1) {
        throw new Error("The big joker can occur only once.");
      }
      result.push(asCardId(53));
      continue;
    }

    const rankIndex = STANDARD_RANKS.indexOf(rank);
    if (rankIndex < 0 || count < 1 || count > 4) {
      throw new Error(`Invalid test card group: ${rank} x ${count}.`);
    }

    for (let suitIndex = 0; suitIndex < count; suitIndex += 1) {
      result.push(asCardId(rankIndex * 4 + suitIndex));
    }
  }

  return result;
}

function singles(...ranks: readonly StandardRank[]): CardId[] {
  return cardIds(...ranks.map((rank): CardGroup => [rank, 1]));
}

function pairs(...ranks: readonly StandardRank[]): CardId[] {
  return cardIds(...ranks.map((rank): CardGroup => [rank, 2]));
}

function triples(...ranks: readonly StandardRank[]): CardId[] {
  return cardIds(...ranks.map((rank): CardGroup => [rank, 3]));
}

function classified(cards: readonly CardId[]): ClassifiedPlay {
  const result = classifyPlay(cards);
  if (!result.ok) {
    throw new Error(`Expected a classified play, received ${result.error.code}.`);
  }
  return result.play;
}

describe("hand-pattern classification", () => {
  const validCases = [
    {
      name: "single joker",
      cards: cardIds(["small-joker", 1]),
      pattern: { kind: "single", mainRank: "small-joker" },
    },
    {
      name: "pair of twos",
      cards: cardIds(["2", 2]),
      pattern: { kind: "pair", mainRank: "2" },
    },
    {
      name: "triple aces",
      cards: cardIds(["A", 3]),
      pattern: { kind: "triple", mainRank: "A" },
    },
    {
      name: "triple with an individual joker",
      cards: cardIds(["3", 3], ["big-joker", 1]),
      pattern: { kind: "triple-with-single", mainRank: "3" },
    },
    {
      name: "triple with a pair of twos",
      cards: cardIds(["3", 3], ["2", 2]),
      pattern: { kind: "triple-with-pair", mainRank: "3" },
    },
    {
      name: "minimum straight",
      cards: singles("3", "4", "5", "6", "7"),
      pattern: { kind: "straight", mainRank: "7", sequenceLength: 5 },
    },
    {
      name: "maximum rank-range straight through ace",
      cards: singles(...STANDARD_RANKS.slice(0, 12)),
      pattern: { kind: "straight", mainRank: "A", sequenceLength: 12 },
    },
    {
      name: "minimum consecutive pairs",
      cards: pairs("3", "4", "5"),
      pattern: { kind: "consecutive-pairs", mainRank: "5", sequenceLength: 3 },
    },
    {
      name: "effective twenty-card maximum consecutive pairs",
      cards: pairs(...STANDARD_RANKS.slice(0, 10)),
      pattern: { kind: "consecutive-pairs", mainRank: "Q", sequenceLength: 10 },
    },
    {
      name: "consecutive pairs ending at ace",
      cards: pairs("Q", "K", "A"),
      pattern: { kind: "consecutive-pairs", mainRank: "A", sequenceLength: 3 },
    },
    {
      name: "minimum airplane",
      cards: triples("3", "4"),
      pattern: { kind: "airplane", mainRank: "4", sequenceLength: 2 },
    },
    {
      name: "airplane core ending at ace",
      cards: triples("K", "A"),
      pattern: { kind: "airplane", mainRank: "A", sequenceLength: 2 },
    },
    {
      name: "effective eighteen-card maximum airplane",
      cards: triples("3", "4", "5", "6", "7", "8"),
      pattern: { kind: "airplane", mainRank: "8", sequenceLength: 6 },
    },
    {
      name: "airplane single wings supplied by a pair",
      cards: cardIds(["3", 3], ["4", 3], ["5", 2]),
      pattern: { kind: "airplane-with-singles", mainRank: "4", sequenceLength: 2 },
    },
    {
      name: "effective twenty-card maximum airplane with single wings",
      cards: cardIds(
        ["3", 3],
        ["4", 3],
        ["5", 3],
        ["6", 3],
        ["7", 3],
        ["8", 2],
        ["9", 2],
        ["10", 1],
      ),
      pattern: { kind: "airplane-with-singles", mainRank: "7", sequenceLength: 5 },
    },
    {
      name: "minimum airplane with distinct pair wings",
      cards: cardIds(["3", 3], ["4", 3], ["5", 2], ["6", 2]),
      pattern: { kind: "airplane-with-pairs", mainRank: "4", sequenceLength: 2 },
    },
    {
      name: "effective twenty-card maximum airplane with pair wings",
      cards: cardIds(
        ["3", 3],
        ["4", 3],
        ["5", 3],
        ["6", 3],
        ["7", 2],
        ["8", 2],
        ["9", 2],
        ["10", 2],
      ),
      pattern: { kind: "airplane-with-pairs", mainRank: "6", sequenceLength: 4 },
    },
    {
      name: "four with a pair counted as two cards",
      cards: cardIds(["5", 4], ["7", 2]),
      pattern: { kind: "four-with-two-cards", mainRank: "5" },
    },
    {
      name: "four with two distinct pairs",
      cards: cardIds(["5", 4], ["7", 2], ["8", 2]),
      pattern: { kind: "four-with-two-pairs", mainRank: "5" },
    },
    {
      name: "bomb",
      cards: cardIds(["Q", 4]),
      pattern: { kind: "bomb", mainRank: "Q" },
    },
    {
      name: "rocket",
      cards: cardIds(["small-joker", 1], ["big-joker", 1]),
      pattern: { kind: "rocket" },
    },
  ] as const;

  it.each(validCases)("classifies $name", ({ cards, pattern }) => {
    expect(classifyPlay(cards)).toEqual({
      ok: true,
      play: {
        cards: [...cards].sort(compareCardIds),
        pattern,
      },
    });
  });

  it.each([
    {
      name: "pair of twos as airplane single wings",
      cards: cardIds(["3", 3], ["4", 3], ["2", 2]),
      kind: "airplane-with-singles",
    },
    {
      name: "ace and two pairs as airplane pair wings",
      cards: cardIds(["3", 3], ["4", 3], ["A", 2], ["2", 2]),
      kind: "airplane-with-pairs",
    },
    {
      name: "one ordinary card and one joker as airplane single wings",
      cards: cardIds(["3", 3], ["4", 3], ["5", 1], ["small-joker", 1]),
      kind: "airplane-with-singles",
    },
    {
      name: "a two and one joker as four-with-two attachments",
      cards: cardIds(["5", 4], ["2", 1], ["small-joker", 1]),
      kind: "four-with-two-cards",
    },
  ])("allows $name", ({ cards, kind }) => {
    const result = classifyPlay(cards);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.play.pattern.kind).toBe(kind);
    }
  });

  it("normalizes unordered input without mutation and returns frozen serializable values", () => {
    const input = cardIds(["8", 1], ["5", 1], ["7", 1], ["6", 1], ["4", 1]).reverse();
    const original = [...input];
    const result = classifyPlay(input);

    expect(input).toEqual(original);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.play.cards).toEqual([...original].sort(compareCardIds));
      expect(result.play.pattern).toEqual({ kind: "straight", mainRank: "8", sequenceLength: 5 });
      expect(Object.isFrozen(result.play.cards)).toBe(true);
      expect(Object.isFrozen(result.play.pattern)).toBe(true);
      expect(Object.isFrozen(result.play)).toBe(true);
      expect(JSON.parse(JSON.stringify(result.play))).toEqual(result.play);
    }
  });

  it("ignores suits while preserving distinct physical cards", () => {
    const lowSuits = [asCardId(16), asCardId(17)];
    const highSuits = [asCardId(18), asCardId(19)];

    expect(classified(lowSuits).pattern).toEqual({ kind: "pair", mainRank: "7" });
    expect(classified(highSuits).pattern).toEqual({ kind: "pair", mainRank: "7" });
  });
});

describe("classification failures", () => {
  const invalidCases: readonly {
    readonly name: string;
    readonly cards: readonly CardId[];
    readonly code: ClassificationErrorCode;
  }[] = [
    { name: "empty selection", cards: [], code: "empty-selection" },
    {
      name: "more than the twenty-card hand maximum",
      cards: createDeck().slice(0, 21),
      code: "too-many-cards",
    },
    { name: "negative runtime CardId", cards: [-1 as CardId], code: "invalid-card-id" },
    { name: "out-of-range runtime CardId", cards: [54 as CardId], code: "invalid-card-id" },
    { name: "fractional runtime CardId", cards: [1.5 as CardId], code: "invalid-card-id" },
    {
      name: "duplicate physical card",
      cards: [asCardId(0), asCardId(0)],
      code: "duplicate-card-id",
    },
    { name: "two unrelated cards", cards: singles("3", "4"), code: "unsupported-pattern" },
    { name: "short straight", cards: singles("3", "4", "5", "6"), code: "unsupported-pattern" },
    {
      name: "disconnected straight",
      cards: singles("3", "4", "5", "6", "8"),
      code: "unsupported-pattern",
    },
    {
      name: "straight core containing two",
      cards: singles("10", "J", "Q", "K", "A", "2"),
      code: "unsupported-pattern",
    },
    {
      name: "consecutive-pair core containing two",
      cards: pairs("Q", "K", "A", "2"),
      code: "unsupported-pattern",
    },
    {
      name: "airplane core containing two",
      cards: triples("A", "2"),
      code: "unsupported-pattern",
    },
    {
      name: "airplane with the wrong number of single wings",
      cards: cardIds(["3", 3], ["4", 3], ["5", 1]),
      code: "unsupported-pattern",
    },
    {
      name: "core rank reused as an extra airplane card",
      cards: cardIds(["3", 4], ["4", 3]),
      code: "unsupported-pattern",
    },
    {
      name: "triples split into airplane single wings",
      cards: cardIds(["3", 3], ["4", 3], ["5", 3], ["7", 3]),
      code: "unsupported-pattern",
    },
    {
      name: "four cards of one rank split into airplane single wings",
      cards: cardIds(["3", 3], ["4", 3], ["5", 4]),
      code: "unsupported-pattern",
    },
    {
      name: "wrong airplane pair-wing count",
      cards: cardIds(["3", 3], ["4", 3], ["5", 2], ["6", 1]),
      code: "unsupported-pattern",
    },
    {
      name: "second bomb split into four-with-two pairs",
      cards: cardIds(["5", 4], ["7", 4]),
      code: "unsupported-pattern",
    },
    {
      name: "rocket split into airplane attachments",
      cards: cardIds(["3", 3], ["4", 3], ["small-joker", 1], ["big-joker", 1]),
      code: "unsupported-pattern",
    },
    {
      name: "rocket split into four-with-two attachments",
      cards: cardIds(["5", 4], ["small-joker", 1], ["big-joker", 1]),
      code: "unsupported-pattern",
    },
  ];

  it.each(invalidCases)("returns $code for $name", ({ cards, code }) => {
    expect(classifyPlay(cards)).toMatchObject({ ok: false, error: { code } });
  });
});

describe("classified-play comparison", () => {
  const comparisonCases = [
    {
      name: "higher same-kind main rank",
      challenger: cardIds(["4", 1]),
      incumbent: cardIds(["3", 1]),
      expected: { outcome: "higher" },
    },
    {
      name: "equal rank with different suits",
      challenger: [asCardId(1)],
      incumbent: [asCardId(3)],
      expected: { outcome: "equal" },
    },
    {
      name: "lower same-kind main rank",
      challenger: cardIds(["3", 2]),
      incumbent: cardIds(["4", 2]),
      expected: { outcome: "lower" },
    },
    {
      name: "higher straight of the same length",
      challenger: singles("4", "5", "6", "7", "8"),
      incumbent: singles("3", "4", "5", "6", "7"),
      expected: { outcome: "higher" },
    },
    {
      name: "same sequence kind but different length",
      challenger: singles("3", "4", "5", "6", "7", "8"),
      incumbent: singles("4", "5", "6", "7", "8"),
      expected: { outcome: "incomparable", reason: "different-length" },
    },
    {
      name: "same airplane-wing kind but different core length",
      challenger: cardIds(["3", 3], ["4", 3], ["5", 3], ["6", 1], ["7", 1], ["8", 1]),
      incumbent: cardIds(["4", 3], ["5", 3], ["6", 2]),
      expected: { outcome: "incomparable", reason: "different-length" },
    },
    {
      name: "different ordinary patterns",
      challenger: cardIds(["4", 2]),
      incumbent: cardIds(["3", 1]),
      expected: { outcome: "incomparable", reason: "different-pattern" },
    },
    {
      name: "bomb over ordinary play",
      challenger: cardIds(["3", 4]),
      incumbent: singles("3", "4", "5", "6", "7"),
      expected: { outcome: "higher" },
    },
    {
      name: "ordinary play below bomb",
      challenger: cardIds(["A", 4], ["K", 2]),
      incumbent: cardIds(["3", 4]),
      expected: { outcome: "lower" },
    },
    {
      name: "higher bomb",
      challenger: cardIds(["4", 4]),
      incumbent: cardIds(["3", 4]),
      expected: { outcome: "higher" },
    },
    {
      name: "equal bomb rank",
      challenger: cardIds(["7", 4]),
      incumbent: cardIds(["7", 4]),
      expected: { outcome: "equal" },
    },
    {
      name: "rocket over bomb",
      challenger: cardIds(["small-joker", 1], ["big-joker", 1]),
      incumbent: cardIds(["2", 4]),
      expected: { outcome: "higher" },
    },
    {
      name: "bomb below rocket",
      challenger: cardIds(["2", 4]),
      incumbent: cardIds(["small-joker", 1], ["big-joker", 1]),
      expected: { outcome: "lower" },
    },
    {
      name: "rocket equals rocket",
      challenger: cardIds(["small-joker", 1], ["big-joker", 1]),
      incumbent: cardIds(["small-joker", 1], ["big-joker", 1]),
      expected: { outcome: "equal" },
    },
  ] as const;

  it.each(comparisonCases)("returns $expected.outcome for $name", ({ challenger, incumbent, expected }) => {
    expect(comparePlays(classified(challenger), classified(incumbent))).toEqual(expected);
  });
});
