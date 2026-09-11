import { describe, expect, it } from "vitest";

import {
  CASUAL_AI_STRATEGY,
  DEFAULT_AI_STRATEGY,
  EXPERT_AI_STRATEGY,
  SCORING_CASUAL_AI_STRATEGY,
  createHandAnalyzer,
  rankMasterPlayActions,
  rankScoredPlayActions,
  samplePossibleWorld,
  type AiDecisionContext,
  type PlayingPlayerView,
  type RemainingCardCounts,
} from "../../src/core/ai/index.js";
import {
  STANDARD_RANKS,
  asCardId,
  createDeck,
  type CardId,
  type Rank,
} from "../../src/core/cards/index.js";
import type { Seat } from "../../src/core/game/index.js";
import {
  classifyPlay,
  generateLegalActions,
  type ClassifiedPlay,
} from "../../src/core/rules/index.js";

type CardGroup = readonly [rank: Rank, count: number];

function cardIds(...groups: readonly CardGroup[]): CardId[] {
  const cards: CardId[] = [];
  for (const [rank, count] of groups) {
    if (rank === "small-joker" || rank === "big-joker") {
      cards.push(asCardId(rank === "small-joker" ? 52 : 53));
      continue;
    }
    const rankIndex = STANDARD_RANKS.indexOf(rank);
    for (let suit = 0; suit < count; suit += 1) {
      cards.push(asCardId(rankIndex * 4 + suit));
    }
  }
  return cards;
}

function classified(cards: readonly CardId[]): ClassifiedPlay {
  const result = classifyPlay(cards);
  if (!result.ok) {
    throw new Error(`Invalid fixture: ${result.error.code}`);
  }
  return result.play;
}

function context(options: {
  readonly hand: readonly CardId[];
  readonly seat?: Seat;
  readonly landlord?: Seat;
  readonly currentPlay?: readonly CardId[];
  readonly currentPlaySeat?: Seat;
  readonly counts?: Partial<Record<Seat, number>>;
  readonly bottomCards?: readonly CardId[];
}): Extract<AiDecisionContext, { readonly kind: "play" }> {
  const seat = options.seat ?? "ai-one";
  const landlord = options.landlord ?? "human";
  const play = options.currentPlay === undefined ? null : classified(options.currentPlay);
  const remainingCardCounts: RemainingCardCounts = Object.freeze({
    human: options.counts?.human ?? (seat === "human" ? options.hand.length : 17),
    "ai-one": options.counts?.["ai-one"] ?? (seat === "ai-one" ? options.hand.length : 17),
    "ai-two": options.counts?.["ai-two"] ?? (seat === "ai-two" ? options.hand.length : 17),
  });
  const view: PlayingPlayerView = Object.freeze({
    phase: play === null ? "ready-to-play" : "playing",
    seat,
    hand: Object.freeze([...options.hand]),
    currentSeat: seat,
    landlord,
    bottomCards: Object.freeze([...(options.bottomCards ?? [])]),
    remainingCardCounts,
    currentPlay: play,
    history: play === null
      ? Object.freeze([])
      : Object.freeze([Object.freeze({
          type: "play" as const,
          seat: options.currentPlaySeat ?? landlord,
          play,
        })]),
  });
  return Object.freeze({
    kind: "play",
    view,
    legalActions: generateLegalActions({ hand: view.hand, currentPlay: play }),
  });
}

describe("enhanced AI profiles", () => {
  it("keeps the exact existing production strategy as the default", () => {
    expect(DEFAULT_AI_STRATEGY).toBe(CASUAL_AI_STRATEGY);
    expect(SCORING_CASUAL_AI_STRATEGY).not.toBe(CASUAL_AI_STRATEGY);
  });

  it("memoizes whole-hand decomposition and recognizes a one-turn straight", () => {
    const analyzer = createHandAnalyzer({ maxNodes: 300 });
    const straight = cardIds(["3", 1], ["4", 1], ["5", 1], ["6", 1], ["7", 1]);

    const first = analyzer.analyze(straight);
    const before = analyzer.stats();
    const second = analyzer.analyze([...straight].reverse());
    const after = analyzer.stats();

    expect(first.minimumTurns).toBe(1);
    expect(second).toBe(first);
    expect(after.cacheHits).toBeGreaterThan(before.cacheHits);
    expect(first.straights).toBeGreaterThan(0);
  });

  it("uses simpler and fuller profiles through one stable action scorer", () => {
    const decision = context({
      hand: cardIds(["3", 2], ["4", 1], ["K", 1]),
      counts: { human: 1 },
    });
    const snapshot = JSON.stringify(decision);

    const casual = rankScoredPlayActions(decision, "casual");
    const expert = rankScoredPlayActions(decision, "expert");

    expect(casual[0]?.action).toMatchObject({
      type: "play",
      play: { pattern: { kind: "pair" } },
    });
    expect(expert[0]?.action).toMatchObject({
      type: "play",
      play: { pattern: { kind: "pair" } },
    });
    expect(new Set(casual.map(({ action }) => action))).toEqual(new Set(decision.legalActions));
    expect(new Set(expert.map(({ action }) => action))).toEqual(new Set(decision.legalActions));
    expect(JSON.stringify(decision)).toBe(snapshot);
  });

  it("lets a farmer lead the small single its one-card partner can receive", () => {
    const decision = context({
      hand: cardIds(["3", 1], ["4", 2], ["A", 1]),
      seat: "ai-one",
      landlord: "human",
      counts: { human: 8, "ai-two": 1 },
    });

    expect(rankScoredPlayActions(decision, "expert")[0]?.action).toMatchObject({
      type: "play",
      play: { cards: cardIds(["3", 1]), pattern: { kind: "single" } },
    });
  });

  it("returns legal top commands for both deterministic scoring policies", () => {
    const decision = context({ hand: cardIds(["3", 3], ["4", 2], ["8", 1]) });
    for (const strategy of [SCORING_CASUAL_AI_STRATEGY, EXPERT_AI_STRATEGY]) {
      const command = strategy.chooseCommand(decision);
      expect(command.type).toBe("play");
      expect(decision.legalActions.some((action) =>
        action.type === "play" && command.type === "play" &&
        action.play.cards.join(",") === command.cards.join(","),
      )).toBe(true);
    }
  });
});

describe("master public-information search", () => {
  it("samples complete possible hands while pinning revealed bottom cards to the landlord", () => {
    const hand = createDeck().slice(0, 17);
    const bottomCards = createDeck().slice(51);
    const decision = context({
      hand,
      seat: "ai-one",
      landlord: "human",
      counts: { human: 20, "ai-one": 17, "ai-two": 17 },
      bottomCards,
    });

    const world = samplePossibleWorld(decision.view, 123);
    const allCards = [
      ...world.hands.human,
      ...world.hands["ai-one"],
      ...world.hands["ai-two"],
    ];

    expect(world.hands["ai-one"]).toEqual(hand);
    expect(world.hands.human).toHaveLength(20);
    expect(world.hands["ai-two"]).toHaveLength(17);
    expect(bottomCards.every((card) => world.hands.human.includes(card))).toBe(true);
    expect(new Set(allCards).size).toBe(54);
  });

  it("is repeatable with a fixed seed and returns only expert-shortlisted legal actions", () => {
    const decision = context({
      hand: cardIds(["3", 3], ["4", 2], ["5", 1], ["6", 1]),
      counts: { human: 15, "ai-one": 7, "ai-two": 15 },
    });
    const expertKeys = new Set(
      rankScoredPlayActions(decision, "expert")
        .slice(0, 5)
        .map(({ action }) => JSON.stringify(action)),
    );

    const first = rankMasterPlayActions(decision, {
      maxWorlds: 2,
      rolloutDepth: 2,
      seed: 77,
    });
    const second = rankMasterPlayActions(decision, {
      maxWorlds: 2,
      rolloutDepth: 2,
      seed: 77,
    });

    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(0);
    expect(first.every(({ action }) => expertKeys.has(JSON.stringify(action)))).toBe(true);
  });
});
