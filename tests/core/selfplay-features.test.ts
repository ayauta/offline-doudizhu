import { describe, expect, it } from "vitest";

import { cardIds, seededRandom, type CardGroup } from "../support/harness.js";
import { redealHidden } from "../support/cf-fixtures.js";

import { asCardId, compareCardIds, type CardId, type RandomSource } from "../../src/core/cards/index.js";
import { SEAT_ORDER, transition, type GameState, type PlayingState, type Seat } from "../../src/core/game/index.js";
import {
  RANK_ORDER,
  generateLegalActions,
  type ValidatedPlayAction,
} from "../../src/core/rules/index.js";
import {
  DEFAULT_AI_STRATEGY,
  createPlayerView,
  type AiDecisionContext,
  type PlayingPlayerView,
} from "../../src/core/ai/index.js";
import { estimateBasicHandTurns } from "../../src/core/ai/hand-analyzer.js";
import { currentPlaySeat } from "../../src/core/ai/state-evaluator.js";
import { dealDeck, startWithLandlord } from "../../benchmarks/ai-tournament.js";
import {
  EMPTY_HISTORY_EVENT,
  HAND_SHAPE_NAMES,
  NO_ACTION_PATTERN_INDEX,
  SELFPLAY_FEATURE_COUNT,
  SELFPLAY_FEATURE_NAMES,
  SELFPLAY_FEATURE_SCHEMA_VERSION,
  SELFPLAY_HISTORY_LENGTH,
  SELFPLAY_PATTERN_KINDS,
  handShapeOf,
  minimumTurnsFromCounts,
  countsOf,
  partnerOf,
  patternIndexOf,
  publicTally,
  recentHistory,
  selfplayRow,
  trickOwnership,
  type HandShape,
} from "../../benchmarks/selfplay-features.js";

function randomDeck(random: RandomSource, size: number): CardId[] {
  const deck = Array.from({ length: 54 }, (_, index) => asCardId(index));
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random.next() * (index + 1));
    const held = deck[index]!;
    deck[index] = deck[swapIndex]!;
    deck[swapIndex] = held;
  }
  return deck.slice(0, size).sort(compareCardIds);
}

type PlayDecisionContext = Extract<AiDecisionContext, { kind: "play" }>;

function playContext(state: GameState, seat: Seat): PlayDecisionContext {
  const view = createPlayerView(state, seat);
  if (view === null || view.phase === "bidding") {
    throw new Error("Fixture expected a playing view.");
  }
  return Object.freeze({
    kind: "play",
    view,
    legalActions: generateLegalActions({ hand: view.hand, currentPlay: view.currentPlay }),
  });
}

/** Walks a deal with the shipped default strategy until `seat` is to move. */
function rootFor(
  dealSeed: number,
  landlord: Seat,
  seat: Seat,
): Readonly<{ state: GameState; context: PlayDecisionContext }> {
  let state = startWithLandlord(dealDeck(dealSeed), landlord);
  for (let ply = 0; ply < 200; ply += 1) {
    if (state.phase === "finished") {
      throw new Error("Fixture walked past the end of the deal.");
    }
    if (state.phase !== "playing" && state.phase !== "ready-to-play") {
      throw new Error(`Fixture reached phase ${state.phase}.`);
    }
    if (state.currentSeat === seat) {
      return Object.freeze({ state, context: playContext(state, seat) });
    }
    const command = DEFAULT_AI_STRATEGY.chooseCommand(playContext(state, state.currentSeat));
    const result = transition(state, command);
    if (!result.ok) {
      throw new Error(`Fixture played an illegal command: ${result.error.code}.`);
    }
    state = result.state;
  }
  throw new Error("Fixture never reached the seat.");
}

function anyPlay(context: PlayDecisionContext): ValidatedPlayAction {
  const action = context.legalActions.find((candidate) => candidate.type === "play");
  if (action === undefined) {
    throw new Error("Fixture expected at least one play action.");
  }
  return action;
}

describe("self-play feature schema shape", () => {
  it("keeps the name list, the count and the row length in lockstep", () => {
    expect(SELFPLAY_FEATURE_COUNT).toBe(SELFPLAY_FEATURE_NAMES.length);
    expect(new Set(SELFPLAY_FEATURE_NAMES).size).toBe(SELFPLAY_FEATURE_NAMES.length);
    expect(SELFPLAY_FEATURE_SCHEMA_VERSION).toBe(1);

    const { context } = rootFor(5001, "human", "ai-one");
    expect(selfplayRow(context.view, anyPlay(context))).toHaveLength(SELFPLAY_FEATURE_COUNT);
  });

  it("takes exactly two inputs, so no reference action can be smuggled in", () => {
    expect(selfplayRow.length).toBe(2);
  });

  it("names no column after a parent action, a parent state, or a delta against one", () => {
    const forbidden = /(^|_)(a0|reference|parent|production|policy|seed|deal|batch|episode|winner|label|reward)/i;
    expect(SELFPLAY_FEATURE_NAMES.filter((name) => forbidden.test(name))).toEqual([]);
  });

  it("carries exactly the frozen number of history events", () => {
    const historyColumns = SELFPLAY_FEATURE_NAMES.filter((name) => /^hist\d+_/.test(name));
    expect(historyColumns).toHaveLength(SELFPLAY_HISTORY_LENGTH * 19);
    for (let index = 0; index < SELFPLAY_HISTORY_LENGTH; index += 1) {
      expect(historyColumns.filter((name) => name.startsWith(`hist${index}_`))).toHaveLength(19);
    }
  });

  it("gives every pattern kind its own index and keeps pass distinct from no-action", () => {
    expect(new Set(SELFPLAY_PATTERN_KINDS).size).toBe(SELFPLAY_PATTERN_KINDS.length);
    expect(patternIndexOf("pass")).toBe(0);
    expect(patternIndexOf("rocket")).toBe(SELFPLAY_PATTERN_KINDS.length - 1);
    expect(patternIndexOf("not-a-pattern")).toBe(NO_ACTION_PATTERN_INDEX);
    expect(EMPTY_HISTORY_EVENT.patternKind).toBe(NO_ACTION_PATTERN_INDEX);
    expect(EMPTY_HISTORY_EVENT.isPass).toBe(-1);
  });
});

describe("self-play descriptors agree with the engine", () => {
  const SHAPE_CASES: readonly { readonly name: string; readonly hand: readonly CardId[] }[] = [
    { name: "empty", hand: [] },
    { name: "single", hand: cardIds(["3", 1]) },
    { name: "rocket only", hand: cardIds(["small-joker", 1], ["big-joker", 1]) },
    { name: "five-card straight", hand: cardIds(...RANK_ORDER.slice(0, 5).map((rank): CardGroup => [rank, 1])) },
    {
      name: "straight broken by a gap",
      hand: cardIds(["3", 1], ["4", 1], ["5", 1], ["6", 1], ["8", 1]),
    },
    {
      name: "three consecutive pairs",
      hand: cardIds(["3", 2], ["4", 2], ["5", 2], ["9", 1]),
    },
    { name: "airplane", hand: cardIds(["3", 3], ["4", 3], ["K", 1]) },
    { name: "bomb plus loose cards", hand: cardIds(["3", 4], ["4", 1], ["5", 1], ["6", 1]) },
    {
      name: "two and jokers outside every run",
      hand: cardIds(["2", 4], ["A", 2], ["small-joker", 1], ["big-joker", 1]),
    },
    {
      name: "full ladder",
      hand: cardIds(...RANK_ORDER.slice(0, 12).map((rank): CardGroup => [rank, 1])),
    },
  ];

  it.each(SHAPE_CASES)("matches estimateBasicHandTurns for $name", ({ hand }) => {
    expect(minimumTurnsFromCounts(countsOf(hand))).toBe(estimateBasicHandTurns(hand));
  });

  it("matches estimateBasicHandTurns on random hands", () => {
    const random = seededRandom(0x5eed_fea1);
    for (let sample = 0; sample < 400; sample += 1) {
      const hand = randomDeck(random, 1 + Math.floor(random.next() * 20));
      expect(
        minimumTurnsFromCounts(countsOf(hand)),
        `sample ${sample} size ${hand.length}`,
      ).toBe(estimateBasicHandTurns(hand));
    }
  });

  it("names every shape field, so a new descriptor cannot go unlabelled", () => {
    const shape = handShapeOf(countsOf(cardIds(["3", 1])));
    expect(Object.keys(shape).sort()).toEqual([...HAND_SHAPE_NAMES].sort());
    for (const name of HAND_SHAPE_NAMES) {
      expect(typeof (shape as unknown as HandShape)[name], name).toBe("number");
    }
  });

  it("agrees with the engine about who owns the current trick", () => {
    for (let dealSeed = 5001; dealSeed < 5021; dealSeed += 1) {
      const landlord = SEAT_ORDER[dealSeed % 3]!;
      for (const seat of SEAT_ORDER) {
        const { state } = rootFor(dealSeed, landlord, seat);
        if (state.phase !== "playing" && state.phase !== "ready-to-play") {
          continue;
        }
        const view = createPlayerView(state, seat);
        if (view === null || view.phase === "bidding") {
          continue;
        }
        expect(trickOwnership(view).owner, `deal ${dealSeed} seat ${seat}`).toBe(
          currentPlaySeat(view),
        );
      }
    }
  });

  it("keeps the public tally a function of the public history alone", () => {
    const { state, context } = rootFor(5003, "human", "ai-two");
    const view = context.view;
    const tally = publicTally(view, countsOf(view.hand));

    let playedTotal = 0;
    for (const count of tally.played) {
      playedTotal += count;
    }
    const historyPlays = view.history.filter((entry) => entry.type === "play");
    const historyCards = historyPlays.reduce(
      (sum, entry) => sum + (entry.type === "play" ? entry.play.cards.length : 0),
      0,
    );
    expect(playedTotal).toBe(historyCards);
    expect(tally.turnIndex).toBe(view.history.length);

    // Unseen = deck copies minus my cards minus publicly played cards.
    for (let slot = 0; slot < tally.unseen.length; slot += 1) {
      const deckCopies = slot < 13 ? 4 : 1;
      expect(tally.unseen[slot], `slot ${slot}`).toBe(
        deckCopies - (countsOf(view.hand)[slot] ?? 0) - (tally.played[slot] ?? 0),
      );
    }
    expect(state.phase === "playing" || state.phase === "ready-to-play").toBe(true);
  });
});

describe("self-play feature rows are legal-observation only", () => {
  function rowSignature(view: PlayingPlayerView): readonly string[] {
    return generateLegalActions({ hand: view.hand, currentPlay: view.currentPlay }).map((action) =>
      selfplayRow(view, action).join(","),
    );
  }

  it("does not move when the two hidden hands are re-dealt", () => {
    for (let dealSeed = 5001; dealSeed < 5007; dealSeed += 1) {
      const landlord = SEAT_ORDER[dealSeed % 3]!;
      const studied: Seat = SEAT_ORDER[(dealSeed + 1) % 3]!;
      const { state } = rootFor(dealSeed, landlord, studied);
      if (state.phase !== "playing") {
        continue;
      }
      const view = createPlayerView(state, studied);
      if (view === null || view.phase === "bidding") {
        continue;
      }
      const before = rowSignature(view);
      for (let variant = 0; variant < 3; variant += 1) {
        const redealt = redealHidden(state, studied, dealSeed * 31 + variant);
        const other = createPlayerView(redealt, studied);
        expect(other === null || other.phase === "bidding").toBe(false);
        if (other === null || other.phase === "bidding") {
          continue;
        }
        expect(rowSignature(other), `deal ${dealSeed} variant ${variant}`).toEqual(before);
      }
    }
  });

  it("moves the terminal winner when the hidden hands move, so the guard is not vacuous", () => {
    let moved = 0;
    for (let dealSeed = 5001; dealSeed < 5013; dealSeed += 1) {
      const landlord = SEAT_ORDER[dealSeed % 3]!;
      const studied: Seat = SEAT_ORDER[(dealSeed + 1) % 3]!;
      const { state } = rootFor(dealSeed, landlord, studied);
      if (state.phase !== "playing") {
        continue;
      }
      const played = finishedWinner(state);
      const other = finishedWinner(redealHidden(state, studied, dealSeed * 17 + 3));
      if (played !== other) {
        moved += 1;
      }
    }
    expect(moved).toBeGreaterThan(0);
  });

  it("is deterministic: the same view and action give byte-identical rows", () => {
    const { context } = rootFor(5002, "ai-one", "human");
    for (const action of context.legalActions) {
      expect(selfplayRow(context.view, action).join(",")).toBe(
        selfplayRow(context.view, action).join(","),
      );
    }
  });

  it("emits finite numbers except in the slots that have no value", () => {
    const { context } = rootFor(5004, "ai-two", "ai-one");
    // A slot is allowed to be NaN only where the value genuinely does not exist,
    // and the schema says so by name. Anything else is a NaN leak into the model.
    const conditionalNaN = new Set(
      ["act_mainRankStrength", "act_sequenceLength"].map((name) =>
        SELFPLAY_FEATURE_NAMES.indexOf(name),
      ),
    );
    const absentTrick = new Set(
      ["trick_mainRankStrength", "trick_sequenceLength"].map((name) =>
        SELFPLAY_FEATURE_NAMES.indexOf(name),
      ),
    );

    for (const action of context.legalActions) {
      const row = selfplayRow(context.view, action);
      row.forEach((value, index) => {
        const allowed =
          (conditionalNaN.has(index) && action.type === "pass") ||
          (absentTrick.has(index) && context.view.currentPlay === null);
        if (allowed) {
          expect(Number.isNaN(value), `${SELFPLAY_FEATURE_NAMES[index]}`).toBe(true);
          return;
        }
        expect(Number.isFinite(value), `${SELFPLAY_FEATURE_NAMES[index]} for ${action.type}`).toBe(
          true,
        );
      });
    }
  });

  it("uses NaN for a rocket's main rank rather than inventing a strength", () => {
    const { context } = rootFor(5004, "ai-two", "ai-one");
    const rocket = context.legalActions.find(
      (action) => action.type === "play" && action.play.pattern.kind === "rocket",
    );
    if (rocket === undefined) {
      return;
    }
    const index = SELFPLAY_FEATURE_NAMES.indexOf("act_mainRankStrength");
    expect(Number.isNaN(selfplayRow(context.view, rocket)[index])).toBe(true);
  });

  it("gives the landlord no partner and a farmer a real one", () => {
    const landlordRoot = rootFor(5005, "ai-one", "ai-one");
    expect(partnerOf("ai-one", "ai-one")).toBeNull();
    expect(partnerOf("human", "ai-one")).toBe("ai-two");
    expect(partnerOf("ai-two", "ai-one")).toBe("human");

    const row = selfplayRow(landlordRoot.context.view, anyPlay(landlordRoot.context));
    const partnerRemaining = SELFPLAY_FEATURE_NAMES.indexOf("pub_partnerRemaining");
    expect(Number.isNaN(row[partnerRemaining])).toBe(true);
  });

  it("pads a short history with a marker that is not a pass", () => {
    const { context } = rootFor(5006, "human", "human");
    if (context.view.history.length > 0) {
      const events = recentHistory(context.view, context.view.seat, null);
      expect(events).toHaveLength(SELFPLAY_HISTORY_LENGTH);
      expect(events.filter((event) => event.patternKind === NO_ACTION_PATTERN_INDEX).length).toBe(
        SELFPLAY_HISTORY_LENGTH - context.view.history.length,
      );
    }
  });

  it("puts the most recent public event first", () => {
    // Walk to a state with at least three public events and check ordering.
    let state: GameState = startWithLandlord(dealDeck(5007), "human");
    for (let ply = 0; ply < 200; ply += 1) {
      if (state.phase === "finished") {
        break;
      }
      if (state.phase !== "playing" && state.phase !== "ready-to-play") {
        break;
      }
      state = transition(state, DEFAULT_AI_STRATEGY.chooseCommand(playContext(state, state.currentSeat))).state;
      const view = createPlayerView(state, "human");
      if (view !== null && view.phase === "playing" && view.history.length >= 3) {
        const events = recentHistory(view, "human", null);
        const last = view.history[view.history.length - 1]!;
        expect(events[0]?.isPass).toBe(last.type === "pass" ? 1 : 0);
        expect(events[0]?.actorIsSelf).toBe(last.seat === "human" ? 1 : 0);
        expect(events[1]?.isPass).toBe(
          view.history[view.history.length - 2]!.type === "pass" ? 1 : 0,
        );
        return;
      }
    }
    throw new Error("Fixture never reached a state with three public events.");
  });
});

function finishedWinner(state: PlayingState): Seat | null {
  let current: GameState = state;
  for (let ply = 0; ply < 200; ply += 1) {
    if (current.phase === "finished") {
      return current.winner;
    }
    if (current.phase !== "playing" && current.phase !== "ready-to-play") {
      return null;
    }
    const result = transition(
      current,
      DEFAULT_AI_STRATEGY.chooseCommand(playContext(current, current.currentSeat)),
    );
    if (!result.ok) {
      return null;
    }
    current = result.state;
  }
  return null;
}
