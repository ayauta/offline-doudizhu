import { describe, expect, it } from "vitest";

import {
  BASELINE_AI_STRATEGY,
  CASUAL_AI_STRATEGY,
  createPlayerView,
  rankCasualPlayActions,
  runAiTurn,
  type AiDecisionContext,
  type AiStrategy,
  type BiddingPlayerView,
  type PlayingPlayerView,
  type RemainingCardCounts,
} from "../../src/core/ai/index.js";
import {
  STANDARD_RANKS,
  asCardId,
  createDeck,
  shuffle,
  type CardId,
  type RandomSource,
  type Rank,
} from "../../src/core/cards/index.js";
import {
  INITIAL_GAME_STATE,
  SEAT_ORDER,
  transition,
  type GameCommand,
  type GameState,
  type Seat,
} from "../../src/core/game/index.js";
import {
  classifyPlay,
  generateLegalActions,
  type ClassifiedPlay,
} from "../../src/core/rules/index.js";

type CardGroup = readonly [rank: Rank, count: number];

function cardIds(...groups: readonly CardGroup[]): CardId[] {
  const result: CardId[] = [];
  for (const [rank, count] of groups) {
    if (rank === "small-joker" || rank === "big-joker") {
      if (count !== 1) {
        throw new Error("A joker test group must contain exactly one card.");
      }
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

function classified(cards: readonly CardId[]): ClassifiedPlay {
  const result = classifyPlay(cards);
  if (!result.ok) {
    throw new Error(`Expected classified test cards, received ${result.error.code}.`);
  }
  return result.play;
}

function countsFor(
  seat: Seat,
  handCount: number,
  overrides: Partial<Record<Seat, number>> = {},
): RemainingCardCounts {
  return Object.freeze({
    human: overrides.human ?? (seat === "human" ? handCount : 17),
    "ai-one": overrides["ai-one"] ?? (seat === "ai-one" ? handCount : 17),
    "ai-two": overrides["ai-two"] ?? (seat === "ai-two" ? handCount : 17),
  });
}

function biddingContext(
  hand: readonly CardId[],
  seat: "ai-one" | "ai-two",
  declinedSeats: readonly Seat[],
): Extract<AiDecisionContext, { readonly kind: "bid" }> {
  const view: BiddingPlayerView = Object.freeze({
    phase: "bidding",
    seat,
    hand: Object.freeze([...hand]),
    currentSeat: seat,
    declinedSeats: Object.freeze([...declinedSeats]),
    remainingCardCounts: countsFor(seat, hand.length),
  });
  return Object.freeze({ kind: "bid", view });
}

function playingContext(options: {
  readonly hand: readonly CardId[];
  readonly seat?: Seat;
  readonly landlord?: Seat;
  readonly currentPlayCards?: readonly CardId[];
  readonly currentPlaySeat?: Seat;
  readonly counts?: Partial<Record<Seat, number>>;
}): Extract<AiDecisionContext, { readonly kind: "play" }> {
  const seat = options.seat ?? "ai-one";
  const landlord = options.landlord ?? "human";
  const currentPlay =
    options.currentPlayCards === undefined
      ? null
      : classified(options.currentPlayCards);
  const history =
    currentPlay === null
      ? Object.freeze([])
      : Object.freeze([
          Object.freeze({
            type: "play" as const,
            seat: options.currentPlaySeat ?? landlord,
            play: currentPlay,
          }),
        ]);
  const view: PlayingPlayerView = Object.freeze({
    phase: currentPlay === null ? "ready-to-play" : "playing",
    seat,
    hand: Object.freeze([...options.hand]),
    currentSeat: seat,
    landlord,
    bottomCards: Object.freeze([]),
    remainingCardCounts: countsFor(seat, options.hand.length, options.counts),
    currentPlay,
    history,
  });
  return Object.freeze({
    kind: "play",
    view,
    legalActions: generateLegalActions({ hand: view.hand, currentPlay }),
  });
}

function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return {
    next(): number {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 2 ** 32;
    },
  };
}

function strategyCommand(state: GameState, strategy: AiStrategy): GameCommand {
  if (state.phase !== "ready-to-play" && state.phase !== "playing") {
    throw new Error(`Expected an active play state, received ${state.phase}.`);
  }
  const view = createPlayerView(state, state.currentSeat);
  if (view === null || view.phase === "bidding") {
    throw new Error("Expected a playing player view.");
  }
  return strategy.chooseCommand(
    Object.freeze({
      kind: "play",
      view,
      legalActions: generateLegalActions({
        hand: view.hand,
        currentPlay: view.currentPlay,
      }),
    }),
  );
}

function startWithLandlord(deck: readonly CardId[], landlord: Seat): GameState {
  const dealt = transition(INITIAL_GAME_STATE, { type: "deal", deck });
  if (!dealt.ok || dealt.state.phase !== "bidding") {
    throw new Error("Expected a deterministic deal.");
  }

  let state = dealt.state;
  for (const seat of SEAT_ORDER) {
    const result = transition(state, {
      type: "bid",
      seat,
      decision: seat === landlord ? "call" : "decline",
    });
    if (!result.ok) {
      throw new Error(`Expected a legal fixed landlord selection: ${result.error.code}.`);
    }
    if (seat === landlord) {
      return result.state;
    }
    if (result.state.phase !== "bidding") {
      throw new Error("Expected bidding to continue before the selected landlord.");
    }
    state = result.state;
  }
  throw new Error("The selected landlord was not reached.");
}

function playToFinish(
  initialState: GameState,
  strategies: Readonly<Record<Seat, AiStrategy>>,
): Extract<GameState, { readonly phase: "finished" }> {
  let state = initialState;
  let commandCount = 0;
  while (state.phase !== "finished" && commandCount < 256) {
    if (state.phase !== "ready-to-play" && state.phase !== "playing") {
      throw new Error(`Unexpected automated-game phase: ${state.phase}.`);
    }
    const result = transition(
      state,
      strategyCommand(state, strategies[state.currentSeat]),
    );
    if (!result.ok) {
      throw new Error(`Strategy produced an illegal command: ${result.error.code}.`);
    }
    state = result.state;
    commandCount += 1;
  }
  if (state.phase !== "finished") {
    throw new Error("Automated casual evaluation exceeded 256 commands.");
  }
  return state;
}

describe("casual AI bidding", () => {
  const strongHand = cardIds(
    ["A", 4],
    ["2", 4],
    ["K", 3],
    ["Q", 2],
    ["J", 2],
    ["small-joker", 1],
    ["big-joker", 1],
  );
  const poorHand = cardIds(
    ["3", 3],
    ["5", 3],
    ["7", 3],
    ["9", 3],
    ["J", 2],
    ["4", 1],
    ["8", 1],
    ["K", 1],
  );
  const mediumHand = cardIds(
    ["3", 2],
    ["5", 2],
    ["7", 2],
    ["9", 2],
    ["J", 2],
    ["Q", 1],
    ["K", 2],
    ["A", 1],
    ["2", 2],
    ["small-joker", 1],
  );

  it("calls a clearly strong hand and declines a clearly poor hand", () => {
    expect(
      CASUAL_AI_STRATEGY.chooseCommand(
        biddingContext(strongHand, "ai-one", ["human"]),
      ),
    ).toMatchObject({ decision: "call" });
    expect(
      CASUAL_AI_STRATEGY.chooseCommand(
        biddingContext(poorHand, "ai-one", ["human"]),
      ),
    ).toMatchObject({ decision: "decline" });
  });

  it("lowers the last bidder threshold without forcing a genuinely poor hand", () => {
    expect(
      CASUAL_AI_STRATEGY.chooseCommand(
        biddingContext(mediumHand, "ai-one", ["human"]),
      ),
    ).toMatchObject({ decision: "decline" });
    expect(
      CASUAL_AI_STRATEGY.chooseCommand(
        biddingContext(mediumHand, "ai-two", ["human", "ai-one"]),
      ),
    ).toMatchObject({ decision: "call" });
    expect(
      CASUAL_AI_STRATEGY.chooseCommand(
        biddingContext(poorHand, "ai-two", ["human", "ai-one"]),
      ),
    ).toMatchObject({ decision: "decline" });
  });

  it("keeps all-pass redeals below the agreed target across fixed shuffled decks", () => {
    const sampleCount = 10_000;
    let redeals = 0;
    let firstAiCalls = 0;
    let secondAiCalls = 0;
    for (let seed = 1; seed <= sampleCount; seed += 1) {
      const dealt = transition(INITIAL_GAME_STATE, {
        type: "deal",
        deck: shuffle(createDeck(), seededRandom(seed)),
      });
      if (!dealt.ok || dealt.state.phase !== "bidding") {
        throw new Error("Expected a sampled deal.");
      }
      const humanDeclined = transition(dealt.state, {
        type: "bid",
        seat: "human",
        decision: "decline",
      });
      if (!humanDeclined.ok) {
        throw new Error("Expected a sampled human decline.");
      }
      const firstAi = runAiTurn(humanDeclined.state, CASUAL_AI_STRATEGY);
      if (!firstAi.ok) {
        throw new Error(`Expected a legal first AI bid: ${firstAi.error.code}.`);
      }
      if (firstAi.state.phase !== "bidding") {
        firstAiCalls += 1;
        continue;
      }
      const secondAi = runAiTurn(firstAi.state, CASUAL_AI_STRATEGY);
      if (!secondAi.ok) {
        throw new Error(`Expected a legal second AI bid: ${secondAi.error.code}.`);
      }
      if (secondAi.state.phase === "awaiting-deal") {
        redeals += 1;
      } else {
        secondAiCalls += 1;
      }
    }

    expect(redeals).toBeGreaterThan(0);
    expect(redeals / sampleCount).toBeLessThanOrEqual(0.02);
    expect(firstAiCalls / sampleCount).toBeGreaterThan(0.25);
    expect(secondAiCalls / sampleCount).toBeGreaterThan(0.25);
  });
});

describe("casual AI play ranking", () => {
  it("ranks an immediate whole-hand finish first", () => {
    const hand = cardIds(["3", 3], ["4", 2]);
    const ranked = rankCasualPlayActions(playingContext({ hand }));

    expect(ranked[0]).toMatchObject({
      type: "play",
      play: { cards: hand, pattern: { kind: "triple-with-pair" } },
    });
  });

  it("sheds a complete multi-card structure before an isolated low single", () => {
    const context = playingContext({
      hand: cardIds(
        ["3", 1],
        ["4", 1],
        ["5", 1],
        ["6", 1],
        ["7", 1],
        ["9", 1],
        ["K", 1],
      ),
    });

    expect(rankCasualPlayActions(context)[0]).toMatchObject({
      type: "play",
      play: { pattern: { kind: "straight" } },
    });
  });

  it("uses an ordinary low response instead of spending a bomb", () => {
    const context = playingContext({
      hand: cardIds(["4", 4], ["5", 1]),
      currentPlayCards: cardIds(["3", 1]),
      currentPlaySeat: "human",
    });

    expect(rankCasualPlayActions(context)[0]).toMatchObject({
      type: "play",
      play: { cards: cardIds(["5", 1]), pattern: { kind: "single" } },
    });
  });

  it("passes rather than spend the only bomb in a non-urgent response", () => {
    const context = playingContext({
      hand: cardIds(["3", 4], ["4", 2]),
      currentPlayCards: cardIds(["2", 1]),
      currentPlaySeat: "human",
    });

    expect(rankCasualPlayActions(context)[0]).toEqual({ type: "pass" });
  });

  it("spends a bomb to stop a landlord who is one card from finishing", () => {
    const context = playingContext({
      hand: cardIds(["3", 4], ["4", 2]),
      currentPlayCards: cardIds(["2", 1]),
      currentPlaySeat: "human",
      counts: { human: 1 },
    });

    expect(rankCasualPlayActions(context)[0]).toMatchObject({
      type: "play",
      play: { pattern: { kind: "bomb" } },
    });
  });

  it("yields to a farmer partner but contests the same landlord play", () => {
    const hand = cardIds(["4", 1], ["6", 2]);
    const partnerContext = playingContext({
      hand,
      seat: "ai-one",
      landlord: "human",
      currentPlayCards: cardIds(["3", 1]),
      currentPlaySeat: "ai-two",
    });
    const opponentContext = playingContext({
      hand,
      seat: "ai-one",
      landlord: "human",
      currentPlayCards: cardIds(["3", 1]),
      currentPlaySeat: "human",
    });
    const humanPartnerContext = playingContext({
      hand,
      seat: "ai-one",
      landlord: "ai-two",
      currentPlayCards: cardIds(["3", 1]),
      currentPlaySeat: "human",
    });

    expect(rankCasualPlayActions(partnerContext)[0]).toEqual({ type: "pass" });
    expect(rankCasualPlayActions(humanPartnerContext)[0]).toEqual({ type: "pass" });
    expect(rankCasualPlayActions(opponentContext)[0]).toMatchObject({
      type: "play",
      play: { cards: cardIds(["4", 1]) },
    });
  });

  it("returns every legal action once in a frozen deterministic order", () => {
    const context = playingContext({
      hand: cardIds(["3", 3], ["4", 2], ["5", 1], ["6", 1]),
    });
    const legalSnapshot = JSON.stringify(context.legalActions);

    const first = rankCasualPlayActions(context);
    const second = rankCasualPlayActions(context);

    expect(first).toEqual(second);
    expect(first).toHaveLength(context.legalActions.length);
    expect(new Set(first)).toEqual(new Set(context.legalActions));
    expect(Object.isFrozen(first)).toBe(true);
    expect(JSON.stringify(context.legalActions)).toBe(legalSnapshot);
  });
});

describe("casual AI integration and evaluation", () => {
  it("submits its ranked command through the existing safety wrapper", () => {
    const dealt = transition(INITIAL_GAME_STATE, {
      type: "deal",
      deck: createDeck().reverse(),
    });
    if (!dealt.ok || dealt.state.phase !== "bidding") {
      throw new Error("Expected a deterministic deal.");
    }
    const humanDeclined = transition(dealt.state, {
      type: "bid",
      seat: "human",
      decision: "decline",
    });
    if (!humanDeclined.ok) {
      throw new Error("Expected the human decline.");
    }

    const first = runAiTurn(humanDeclined.state, CASUAL_AI_STRATEGY);
    const second = runAiTurn(humanDeclined.state, CASUAL_AI_STRATEGY);

    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
  });

  it.each([17, 29, 43])(
    "finishes fixed shuffled game %i with both AI seats participating",
    (seed) => {
      const allCasual: Readonly<Record<Seat, AiStrategy>> = {
        human: CASUAL_AI_STRATEGY,
        "ai-one": CASUAL_AI_STRATEGY,
        "ai-two": CASUAL_AI_STRATEGY,
      };
      const result = playToFinish(
        startWithLandlord(shuffle(createDeck(), seededRandom(seed)), "human"),
        allCasual,
      );
      const actingSeats = new Set(result.history.map((entry) => entry.seat));

      expect(result.history.length).toBeLessThan(256);
      expect(actingSeats.has("ai-one")).toBe(true);
      expect(actingSeats.has("ai-two")).toBe(true);
    },
  );

  it("beats the first-legal baseline from both sides across paired fixed decks", () => {
    let casualLandlordWins = 0;
    let casualFarmerWins = 0;
    let gamesPerRole = 0;

    for (let seed = 101; seed <= 112; seed += 1) {
      const deck = shuffle(createDeck(), seededRandom(seed));
      for (const landlord of SEAT_ORDER) {
        const farmers = SEAT_ORDER.filter((seat) => seat !== landlord);
        const casualLandlordStrategies: Record<Seat, AiStrategy> = {
          human: BASELINE_AI_STRATEGY,
          "ai-one": BASELINE_AI_STRATEGY,
          "ai-two": BASELINE_AI_STRATEGY,
        };
        casualLandlordStrategies[landlord] = CASUAL_AI_STRATEGY;
        const landlordResult = playToFinish(
          startWithLandlord(deck, landlord),
          casualLandlordStrategies,
        );
        if (landlordResult.winner === landlord) {
          casualLandlordWins += 1;
        }

        const casualFarmerStrategies: Record<Seat, AiStrategy> = {
          human: CASUAL_AI_STRATEGY,
          "ai-one": CASUAL_AI_STRATEGY,
          "ai-two": CASUAL_AI_STRATEGY,
        };
        casualFarmerStrategies[landlord] = BASELINE_AI_STRATEGY;
        const farmerResult = playToFinish(
          startWithLandlord(deck, landlord),
          casualFarmerStrategies,
        );
        if (farmers.includes(farmerResult.winner)) {
          casualFarmerWins += 1;
        }
        gamesPerRole += 1;
      }
    }

    expect(casualLandlordWins).toBeGreaterThan(gamesPerRole / 2);
    expect(casualFarmerWins).toBeGreaterThan(gamesPerRole / 2);
  });
});
