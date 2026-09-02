import { describe, expect, it } from "vitest";

import {
  STANDARD_RANKS,
  asCardId,
  getCard,
  type CardId,
  type Rank,
} from "../../src/core/cards/index.js";
import {
  generateLegalActions,
  validatePlay,
  type PlayContext,
  type PlayPatternKind,
  type ValidatedPlayAction,
} from "../../src/core/rules/index.js";

type CardGroup = readonly [rank: Rank, count: number];

function cardIds(...groups: readonly CardGroup[]): CardId[] {
  const result: CardId[] = [];
  for (const [rank, count] of groups) {
    if (rank === "small-joker" || rank === "big-joker") {
      result.push(asCardId(rank === "small-joker" ? 52 : 53));
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

function semanticKey(action: ValidatedPlayAction): string {
  if (action.type === "pass") {
    return "pass";
  }

  const counts = new Map<Rank, number>();
  for (const cardId of action.play.cards) {
    const rank = getCard(cardId).rank;
    counts.set(rank, (counts.get(rank) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([rank, count]) => `${rank}:${count}`)
    .join("|");
}

function compareCardLists(left: readonly CardId[], right: readonly CardId[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
}

function normalizedActionSet(
  actions: readonly ValidatedPlayAction[],
): readonly (readonly [key: string, action: ValidatedPlayAction])[] {
  return actions
    .map((action) => [semanticKey(action), action] as const)
    .sort(([left], [right]) => left.localeCompare(right));
}

function bruteForceLegalActions(context: PlayContext): readonly ValidatedPlayAction[] {
  if (context.hand.length > 12) {
    throw new Error("The test oracle is intentionally bounded to twelve cards.");
  }

  const canonicalByShape = new Map<string, ValidatedPlayAction>();
  for (let mask = 1; mask < 2 ** context.hand.length; mask += 1) {
    const cards = context.hand.filter((_, index) => (mask & (1 << index)) !== 0);
    const result = validatePlay(context, { type: "play", cards });
    if (!result.ok || result.action.type !== "play") {
      continue;
    }

    const key = semanticKey(result.action);
    const incumbent = canonicalByShape.get(key);
    if (
      incumbent === undefined ||
      (incumbent.type === "play" &&
        compareCardLists(result.action.play.cards, incumbent.play.cards) < 0)
    ) {
      canonicalByShape.set(key, result.action);
    }
  }

  const passResult = validatePlay(context, { type: "pass" });
  if (passResult.ok) {
    canonicalByShape.set("pass", passResult.action);
  }
  return [...canonicalByShape.values()];
}

describe("legal action generation", () => {
  it.each([
    { kind: "single", hand: cardIds(["3", 1]) },
    { kind: "pair", hand: cardIds(["3", 2]) },
    { kind: "triple", hand: cardIds(["3", 3]) },
    { kind: "triple-with-single", hand: cardIds(["3", 3], ["4", 1]) },
    { kind: "triple-with-pair", hand: cardIds(["3", 3], ["4", 2]) },
    { kind: "straight", hand: cardIds(["3", 1], ["4", 1], ["5", 1], ["6", 1], ["7", 1]) },
    { kind: "consecutive-pairs", hand: cardIds(["3", 2], ["4", 2], ["5", 2]) },
    { kind: "airplane", hand: cardIds(["3", 3], ["4", 3]) },
    { kind: "airplane-with-singles", hand: cardIds(["3", 3], ["4", 3], ["5", 2]) },
    { kind: "airplane-with-pairs", hand: cardIds(["3", 3], ["4", 3], ["5", 2], ["6", 2]) },
    { kind: "four-with-two-cards", hand: cardIds(["3", 4], ["4", 2]) },
    { kind: "four-with-two-pairs", hand: cardIds(["3", 4], ["4", 2], ["5", 2]) },
    { kind: "bomb", hand: cardIds(["3", 4]) },
    { kind: "rocket", hand: cardIds(["small-joker", 1], ["big-joker", 1]) },
  ] satisfies readonly {
    readonly kind: PlayPatternKind;
    readonly hand: readonly CardId[];
  }[])("generates the $kind pattern kind", ({ kind, hand }) => {
    expect(
      generateLegalActions({ hand, currentPlay: null }).some(
        (action) => action.type === "play" && action.play.pattern.kind === kind,
      ),
    ).toBe(true);
  });

  it.each([
    {
      name: "maximum straight through ace",
      hand: cardIds(
        ...STANDARD_RANKS.slice(0, 12).map((rank): CardGroup => [rank, 1]),
      ),
      pattern: { kind: "straight" as const, mainRank: "A" as const, sequenceLength: 12 },
    },
    {
      name: "maximum consecutive pairs",
      hand: cardIds(
        ...STANDARD_RANKS.slice(0, 10).map((rank): CardGroup => [rank, 2]),
      ),
      pattern: {
        kind: "consecutive-pairs" as const,
        mainRank: "Q" as const,
        sequenceLength: 10,
      },
    },
    {
      name: "consecutive pairs ending at ace",
      hand: cardIds(["Q", 2], ["K", 2], ["A", 2]),
      pattern: {
        kind: "consecutive-pairs" as const,
        mainRank: "A" as const,
        sequenceLength: 3,
      },
    },
    {
      name: "maximum bare airplane",
      hand: cardIds(
        ...STANDARD_RANKS.slice(0, 6).map((rank): CardGroup => [rank, 3]),
      ),
      pattern: { kind: "airplane" as const, mainRank: "8" as const, sequenceLength: 6 },
    },
    {
      name: "airplane ending at ace",
      hand: cardIds(["K", 3], ["A", 3]),
      pattern: { kind: "airplane" as const, mainRank: "A" as const, sequenceLength: 2 },
    },
    {
      name: "maximum airplane with single wings",
      hand: cardIds(
        ["3", 3],
        ["4", 3],
        ["5", 3],
        ["6", 3],
        ["7", 3],
        ["8", 2],
        ["9", 2],
        ["10", 1],
      ),
      pattern: {
        kind: "airplane-with-singles" as const,
        mainRank: "7" as const,
        sequenceLength: 5,
      },
    },
    {
      name: "maximum airplane with pair wings",
      hand: cardIds(
        ["3", 3],
        ["4", 3],
        ["5", 3],
        ["6", 3],
        ["7", 2],
        ["8", 2],
        ["9", 2],
        ["10", 2],
      ),
      pattern: {
        kind: "airplane-with-pairs" as const,
        mainRank: "6" as const,
        sequenceLength: 4,
      },
    },
  ])("generates the complete $name", ({ hand, pattern }) => {
    expect(generateLegalActions({ hand, currentPlay: null })).toContainEqual({
      type: "play",
      play: { cards: hand, pattern },
    });
  });

  it("generates one canonical basic action per rank-count shape for a lead", () => {
    const threes = [asCardId(0), asCardId(1), asCardId(2), asCardId(3)];

    expect(generateLegalActions({ hand: threes, currentPlay: null })).toEqual([
      {
        type: "play",
        play: { cards: [asCardId(0)], pattern: { kind: "single", mainRank: "3" } },
      },
      {
        type: "play",
        play: {
          cards: [asCardId(0), asCardId(1)],
          pattern: { kind: "pair", mainRank: "3" },
        },
      },
      {
        type: "play",
        play: {
          cards: [asCardId(0), asCardId(1), asCardId(2)],
          pattern: { kind: "triple", mainRank: "3" },
        },
      },
      {
        type: "play",
        play: {
          cards: threes,
          pattern: { kind: "bomb", mainRank: "3" },
        },
      },
    ]);
  });

  it("generates every canonical triple attachment", () => {
    const hand = [
      asCardId(0),
      asCardId(1),
      asCardId(2),
      asCardId(4),
      asCardId(8),
      asCardId(9),
    ];

    const attachments = generateLegalActions({ hand, currentPlay: null }).filter(
      (action) =>
        action.type === "play" &&
        (action.play.pattern.kind === "triple-with-single" ||
          action.play.pattern.kind === "triple-with-pair"),
    );

    expect(attachments).toEqual([
      {
        type: "play",
        play: {
          cards: [asCardId(0), asCardId(1), asCardId(2), asCardId(4)],
          pattern: { kind: "triple-with-single", mainRank: "3" },
        },
      },
      {
        type: "play",
        play: {
          cards: [asCardId(0), asCardId(1), asCardId(2), asCardId(8)],
          pattern: { kind: "triple-with-single", mainRank: "3" },
        },
      },
      {
        type: "play",
        play: {
          cards: [asCardId(0), asCardId(1), asCardId(2), asCardId(8), asCardId(9)],
          pattern: { kind: "triple-with-pair", mainRank: "3" },
        },
      },
    ]);
  });

  it("generates every consecutive window for straights, pairs, and airplanes", () => {
    const cases = [
      {
        name: "straight",
        kind: "straight",
        hand: [asCardId(0), asCardId(4), asCardId(8), asCardId(12), asCardId(16), asCardId(20)],
        expected: [
          {
            cards: [asCardId(0), asCardId(4), asCardId(8), asCardId(12), asCardId(16)],
            pattern: { kind: "straight", mainRank: "7", sequenceLength: 5 },
          },
          {
            cards: [asCardId(4), asCardId(8), asCardId(12), asCardId(16), asCardId(20)],
            pattern: { kind: "straight", mainRank: "8", sequenceLength: 5 },
          },
          {
            cards: [
              asCardId(0),
              asCardId(4),
              asCardId(8),
              asCardId(12),
              asCardId(16),
              asCardId(20),
            ],
            pattern: { kind: "straight", mainRank: "8", sequenceLength: 6 },
          },
        ],
      },
      {
        name: "consecutive pairs",
        kind: "consecutive-pairs",
        hand: [
          asCardId(0),
          asCardId(1),
          asCardId(4),
          asCardId(5),
          asCardId(8),
          asCardId(9),
          asCardId(12),
          asCardId(13),
        ],
        expected: [
          {
            cards: [
              asCardId(0),
              asCardId(1),
              asCardId(4),
              asCardId(5),
              asCardId(8),
              asCardId(9),
            ],
            pattern: { kind: "consecutive-pairs", mainRank: "5", sequenceLength: 3 },
          },
          {
            cards: [
              asCardId(4),
              asCardId(5),
              asCardId(8),
              asCardId(9),
              asCardId(12),
              asCardId(13),
            ],
            pattern: { kind: "consecutive-pairs", mainRank: "6", sequenceLength: 3 },
          },
          {
            cards: [
              asCardId(0),
              asCardId(1),
              asCardId(4),
              asCardId(5),
              asCardId(8),
              asCardId(9),
              asCardId(12),
              asCardId(13),
            ],
            pattern: { kind: "consecutive-pairs", mainRank: "6", sequenceLength: 4 },
          },
        ],
      },
      {
        name: "airplane",
        kind: "airplane",
        hand: [
          asCardId(0),
          asCardId(1),
          asCardId(2),
          asCardId(4),
          asCardId(5),
          asCardId(6),
          asCardId(8),
          asCardId(9),
          asCardId(10),
        ],
        expected: [
          {
            cards: [
              asCardId(0),
              asCardId(1),
              asCardId(2),
              asCardId(4),
              asCardId(5),
              asCardId(6),
            ],
            pattern: { kind: "airplane", mainRank: "4", sequenceLength: 2 },
          },
          {
            cards: [
              asCardId(4),
              asCardId(5),
              asCardId(6),
              asCardId(8),
              asCardId(9),
              asCardId(10),
            ],
            pattern: { kind: "airplane", mainRank: "5", sequenceLength: 2 },
          },
          {
            cards: [
              asCardId(0),
              asCardId(1),
              asCardId(2),
              asCardId(4),
              asCardId(5),
              asCardId(6),
              asCardId(8),
              asCardId(9),
              asCardId(10),
            ],
            pattern: { kind: "airplane", mainRank: "5", sequenceLength: 3 },
          },
        ],
      },
    ] as const;

    for (const { name, kind, hand, expected } of cases) {
      const plays = generateLegalActions({ hand, currentPlay: null })
        .filter((action) => action.type === "play" && action.play.pattern.kind === kind)
        .map((action) => action.type === "play" ? action.play : undefined);

      expect(plays, name).toEqual(expected);
    }
  });

  it("generates every airplane single-wing choice without splitting the rocket", () => {
    const core = [
      asCardId(0),
      asCardId(1),
      asCardId(2),
      asCardId(4),
      asCardId(5),
      asCardId(6),
    ];
    const hand = [
      ...core,
      asCardId(8),
      asCardId(9),
      asCardId(12),
      asCardId(16),
      asCardId(52),
      asCardId(53),
    ];

    const wings = generateLegalActions({ hand, currentPlay: null })
      .filter(
        (action) =>
          action.type === "play" &&
          action.play.pattern.kind === "airplane-with-singles",
      )
      .map((action) => action.type === "play" ? action.play.cards.slice(core.length) : []);

    expect(wings).toEqual([
      [asCardId(8), asCardId(9)],
      [asCardId(8), asCardId(12)],
      [asCardId(8), asCardId(16)],
      [asCardId(8), asCardId(52)],
      [asCardId(8), asCardId(53)],
      [asCardId(12), asCardId(16)],
      [asCardId(12), asCardId(52)],
      [asCardId(12), asCardId(53)],
      [asCardId(16), asCardId(52)],
      [asCardId(16), asCardId(53)],
    ]);
  });

  it("generates every airplane pair-wing choice from distinct ranks", () => {
    const core = [
      asCardId(0),
      asCardId(1),
      asCardId(2),
      asCardId(4),
      asCardId(5),
      asCardId(6),
    ];
    const hand = [
      ...core,
      asCardId(8),
      asCardId(9),
      asCardId(12),
      asCardId(13),
      asCardId(16),
      asCardId(17),
    ];

    const wings = generateLegalActions({ hand, currentPlay: null })
      .filter(
        (action) =>
          action.type === "play" && action.play.pattern.kind === "airplane-with-pairs",
      )
      .map((action) => action.type === "play" ? action.play.cards.slice(core.length) : []);

    expect(wings).toEqual([
      [asCardId(8), asCardId(9), asCardId(12), asCardId(13)],
      [asCardId(8), asCardId(9), asCardId(16), asCardId(17)],
      [asCardId(12), asCardId(13), asCardId(16), asCardId(17)],
    ]);
  });

  it("does not reuse an airplane core rank as a single wing", () => {
    const hand = cardIds(["3", 4], ["4", 3], ["5", 1]);

    expect(
      generateLegalActions({ hand, currentPlay: null }).filter(
        (action) =>
          action.type === "play" &&
          action.play.pattern.kind === "airplane-with-singles",
      ),
    ).toEqual([]);
  });

  it("generates four-with-two cards and every distinct pair combination", () => {
    const core = [asCardId(0), asCardId(1), asCardId(2), asCardId(3)];
    const pairFour = [asCardId(4), asCardId(5)];

    expect(
      generateLegalActions({ hand: [...core, ...pairFour], currentPlay: null }).filter(
        (action) =>
          action.type === "play" && action.play.pattern.kind === "four-with-two-cards",
      ),
    ).toEqual([
      {
        type: "play",
        play: {
          cards: [...core, ...pairFour],
          pattern: { kind: "four-with-two-cards", mainRank: "3" },
        },
      },
    ]);

    const hand = [
      ...core,
      ...pairFour,
      asCardId(8),
      asCardId(9),
      asCardId(12),
      asCardId(13),
    ];
    const pairAttachments = generateLegalActions({ hand, currentPlay: null })
      .filter(
        (action) =>
          action.type === "play" && action.play.pattern.kind === "four-with-two-pairs",
      )
      .map((action) => action.type === "play" ? action.play.cards.slice(core.length) : []);

    expect(pairAttachments).toEqual([
      [asCardId(4), asCardId(5), asCardId(8), asCardId(9)],
      [asCardId(4), asCardId(5), asCardId(12), asCardId(13)],
      [asCardId(8), asCardId(9), asCardId(12), asCardId(13)],
    ]);
  });

  it("filters a response to beating plays, bombs, rocket, and one trailing pass", () => {
    const currentPlay = {
      cards: [asCardId(8), asCardId(9)],
      pattern: { kind: "pair" as const, mainRank: "5" as const },
    };
    const hand = [
      asCardId(0),
      asCardId(1),
      asCardId(2),
      asCardId(3),
      asCardId(4),
      asCardId(5),
      asCardId(12),
      asCardId(13),
      asCardId(52),
      asCardId(53),
    ];

    expect(generateLegalActions({ hand, currentPlay })).toEqual([
      {
        type: "play",
        play: {
          cards: [asCardId(12), asCardId(13)],
          pattern: { kind: "pair", mainRank: "6" },
        },
      },
      {
        type: "play",
        play: {
          cards: [asCardId(0), asCardId(1), asCardId(2), asCardId(3)],
          pattern: { kind: "bomb", mainRank: "3" },
        },
      },
      {
        type: "play",
        play: {
          cards: [asCardId(52), asCardId(53)],
          pattern: { kind: "rocket" },
        },
      },
      { type: "pass" },
    ]);
  });

  it("returns only pass when no play can beat the current play", () => {
    const currentPlay = {
      cards: [asCardId(52), asCardId(53)],
      pattern: { kind: "rocket" as const },
    };

    expect(
      generateLegalActions({ hand: [asCardId(0), asCardId(1)], currentPlay }),
    ).toEqual([{ type: "pass" }]);
  });

  it("returns no actions for an empty leading hand", () => {
    expect(generateLegalActions({ hand: [], currentPlay: null })).toEqual([]);
  });

  it.each([
    {
      name: "bomb, attachments, and rocket",
      context: {
        hand: cardIds(
          ["3", 4],
          ["4", 2],
          ["5", 1],
          ["6", 1],
          ["small-joker", 1],
          ["big-joker", 1],
        ),
        currentPlay: null,
      },
    },
    {
      name: "airplane and wing choices",
      context: {
        hand: cardIds(["3", 3], ["4", 3], ["5", 2], ["6", 1], ["7", 1]),
        currentPlay: null,
      },
    },
    {
      name: "twelve-rank straight windows",
      context: {
        hand: cardIds(
          ...STANDARD_RANKS.slice(0, 12).map((rank): CardGroup => [rank, 1]),
        ),
        currentPlay: null,
      },
    },
    {
      name: "response filtering",
      context: {
        hand: cardIds(
          ["3", 4],
          ["4", 2],
          ["6", 2],
          ["small-joker", 1],
          ["big-joker", 1],
        ),
        currentPlay: {
          cards: cardIds(["5", 2]),
          pattern: { kind: "pair" as const, mainRank: "5" as const },
        },
      },
    },
  ] satisfies readonly { readonly name: string; readonly context: PlayContext }[])(
    "matches the independent brute-force oracle for $name",
    ({ context }) => {
      expect(normalizedActionSet(generateLegalActions(context))).toEqual(
        normalizedActionSet(bruteForceLegalActions(context)),
      );
    },
  );

  it("returns deterministic, unique, deeply frozen serializable values without mutation", () => {
    const hand = [
      asCardId(53),
      asCardId(6),
      asCardId(1),
      asCardId(52),
      asCardId(4),
      asCardId(2),
      asCardId(5),
      asCardId(0),
    ];
    const context: PlayContext = {
      hand,
      currentPlay: {
        cards: [asCardId(8)],
        pattern: { kind: "single", mainRank: "5" },
      },
    };
    const originalContext = JSON.parse(JSON.stringify(context)) as unknown;

    const actions = generateLegalActions(context);

    expect(context).toEqual(originalContext);
    expect(generateLegalActions(context)).toEqual(actions);
    expect(new Set(actions.map(semanticKey)).size).toBe(actions.length);
    expect(Object.isFrozen(actions)).toBe(true);
    for (const action of actions) {
      expect(Object.isFrozen(action)).toBe(true);
      if (action.type === "play") {
        expect(Object.isFrozen(action.play)).toBe(true);
        expect(Object.isFrozen(action.play.cards)).toBe(true);
        expect(Object.isFrozen(action.play.pattern)).toBe(true);
      }
    }
    expect(JSON.parse(JSON.stringify(actions))).toEqual(actions);
  });
});
