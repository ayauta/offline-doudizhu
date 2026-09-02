import { describe, expect, it } from "vitest";

import {
  asCardId,
  createDeck,
  type CardId,
} from "../../src/core/cards/index.js";
import {
  INITIAL_GAME_STATE,
  SEAT_ORDER,
  transition,
  type BiddingState,
  type Seat,
} from "../../src/core/game/index.js";

function deal(deck = createDeck()): BiddingState {
  const result = transition(INITIAL_GAME_STATE, { type: "deal", deck });
  if (!result.ok || result.state.phase !== "bidding") {
    throw new Error("Expected a successful deal into bidding.");
  }
  return result.state;
}

function expectDeepFrozen(value: unknown): void {
  if (typeof value !== "object" || value === null) {
    return;
  }
  expect(Object.isFrozen(value)).toBe(true);
  for (const nested of Object.values(value)) {
    expectDeepFrozen(nested);
  }
}

describe("bidding and deal state", () => {
  it("deals 17 cards round-robin to each seat, keeps three bottom cards, and starts with the human", () => {
    const result = transition(INITIAL_GAME_STATE, {
      type: "deal",
      deck: createDeck(),
    });

    expect(result).toEqual({
      ok: true,
      state: {
        phase: "bidding",
        hands: {
          human: [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 39, 42, 45, 48]
            .map(asCardId),
          "ai-one": [1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34, 37, 40, 43, 46, 49]
            .map(asCardId),
          "ai-two": [2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35, 38, 41, 44, 47, 50]
            .map(asCardId),
        },
        bottomCards: [asCardId(51), asCardId(52), asCardId(53)],
        currentSeat: "human",
        declinedSeats: [],
      },
      events: [{ type: "deal-completed" }],
    });
    expect(SEAT_ORDER).toEqual(["human", "ai-one", "ai-two"]);
    expect(Object.isFrozen(SEAT_ORDER)).toBe(true);
  });

  it.each([
    {
      name: "missing card",
      deck: createDeck().slice(0, 53),
    },
    {
      name: "duplicate card",
      deck: [...createDeck().slice(0, 53), asCardId(0)],
    },
    {
      name: "negative card ID",
      deck: [-1 as CardId, ...createDeck().slice(1)],
    },
    {
      name: "out-of-range card ID",
      deck: [54 as CardId, ...createDeck().slice(1)],
    },
    {
      name: "fractional card ID",
      deck: [1.5 as CardId, ...createDeck().slice(1)],
    },
  ])("rejects a deck with a $name without changing state", ({ deck }) => {
    const result = transition(INITIAL_GAME_STATE, { type: "deal", deck });

    expect(result).toEqual({
      ok: false,
      state: INITIAL_GAME_STATE,
      error: { code: "invalid-deck" },
    });
    expect(result.state).toBe(INITIAL_GAME_STATE);
  });

  it("makes the human landlord immediately when the human calls", () => {
    const bidding = deal();

    const result = transition(bidding, {
      type: "bid",
      seat: "human",
      decision: "call",
    });

    expect(result).toEqual({
      ok: true,
      state: {
        phase: "ready-to-play",
        hands: {
          human: [
            0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 39, 42, 45, 48,
            51, 52, 53,
          ].map(asCardId),
          "ai-one": [1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34, 37, 40, 43, 46, 49]
            .map(asCardId),
          "ai-two": [2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35, 38, 41, 44, 47, 50]
            .map(asCardId),
        },
        bottomCards: [asCardId(51), asCardId(52), asCardId(53)],
        landlord: "human",
        currentSeat: "human",
      },
      events: [
        {
          type: "landlord-selected",
          seat: "human",
          bottomCards: [asCardId(51), asCardId(52), asCardId(53)],
        },
      ],
    });
    expect(bidding.hands.human).toHaveLength(17);
  });

  it("re-sorts a landlord hand when low bottom cards are assigned", () => {
    const bidding = deal(createDeck().reverse());

    const result = transition(bidding, {
      type: "bid",
      seat: "human",
      decision: "call",
    });

    if (!result.ok || result.state.phase !== "ready-to-play") {
      throw new Error("Expected the human to become landlord.");
    }
    expect(result.state.hands.human).toEqual(
      [0, 1, 2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35, 38, 41, 44, 47, 50, 53]
        .map(asCardId),
    );
  });

  it("records a human decline and advances bidding to ai-one", () => {
    const bidding = deal();

    const result = transition(bidding, {
      type: "bid",
      seat: "human",
      decision: "decline",
    });

    expect(result).toEqual({
      ok: true,
      state: {
        ...bidding,
        currentSeat: "ai-one",
        declinedSeats: ["human"],
      },
      events: [{ type: "bid-declined", seat: "human" }],
    });
  });

  it("records ai-one declining after the human and advances bidding to ai-two", () => {
    const afterHuman = transition(deal(), {
      type: "bid",
      seat: "human",
      decision: "decline",
    });
    if (!afterHuman.ok || afterHuman.state.phase !== "bidding") {
      throw new Error("Expected bidding to continue with ai-one.");
    }

    const result = transition(afterHuman.state, {
      type: "bid",
      seat: "ai-one",
      decision: "decline",
    });

    expect(result).toEqual({
      ok: true,
      state: {
        ...afterHuman.state,
        currentSeat: "ai-two",
        declinedSeats: ["human", "ai-one"],
      },
      events: [{ type: "bid-declined", seat: "ai-one" }],
    });
  });

  it("requests a redeal after all three seats decline", () => {
    const afterHuman = transition(deal(), {
      type: "bid",
      seat: "human",
      decision: "decline",
    });
    if (!afterHuman.ok || afterHuman.state.phase !== "bidding") {
      throw new Error("Expected bidding to continue with ai-one.");
    }
    const afterAiOne = transition(afterHuman.state, {
      type: "bid",
      seat: "ai-one",
      decision: "decline",
    });
    if (!afterAiOne.ok || afterAiOne.state.phase !== "bidding") {
      throw new Error("Expected bidding to continue with ai-two.");
    }

    const result = transition(afterAiOne.state, {
      type: "bid",
      seat: "ai-two",
      decision: "decline",
    });

    expect(result).toEqual({
      ok: true,
      state: INITIAL_GAME_STATE,
      events: [
        { type: "bid-declined", seat: "ai-two" },
        { type: "redeal-requested" },
      ],
    });
  });

  it.each([
    { landlord: "ai-one", declines: ["human"] },
    { landlord: "ai-two", declines: ["human", "ai-one"] },
  ] satisfies readonly {
    readonly landlord: Seat;
    readonly declines: readonly Seat[];
  }[])("makes $landlord the landlord when it is the first caller", ({ landlord, declines }) => {
    let bidding = deal();
    for (const seat of declines) {
      const declined = transition(bidding, { type: "bid", seat, decision: "decline" });
      if (!declined.ok || declined.state.phase !== "bidding") {
        throw new Error(`Expected bidding to continue after ${seat} declined.`);
      }
      bidding = declined.state;
    }

    const result = transition(bidding, {
      type: "bid",
      seat: landlord,
      decision: "call",
    });

    expect(result).toMatchObject({
      ok: true,
      state: {
        phase: "ready-to-play",
        landlord,
        currentSeat: landlord,
        bottomCards: bidding.bottomCards,
      },
      events: [
        {
          type: "landlord-selected",
          seat: landlord,
          bottomCards: bidding.bottomCards,
        },
      ],
    });
    if (!result.ok || result.state.phase !== "ready-to-play") {
      throw new Error(`Expected ${landlord} to become landlord.`);
    }
    expect(result.state.hands[landlord]).toEqual(
      [...bidding.hands[landlord], ...bidding.bottomCards].sort((left, right) => left - right),
    );
    for (const seat of ["human", "ai-one", "ai-two"] as const) {
      expect(result.state.hands[seat]).toHaveLength(seat === landlord ? 20 : 17);
    }
  });

  it("accepts an independent fresh deck after all-pass and stores sorted non-aliased cards", () => {
    let bidding = deal();
    for (const seat of ["human", "ai-one"] as const) {
      const declined = transition(bidding, { type: "bid", seat, decision: "decline" });
      if (!declined.ok || declined.state.phase !== "bidding") {
        throw new Error(`Expected bidding to continue after ${seat} declined.`);
      }
      bidding = declined.state;
    }
    const allPassed = transition(bidding, {
      type: "bid",
      seat: "ai-two",
      decision: "decline",
    });
    if (!allPassed.ok || allPassed.state.phase !== "awaiting-deal") {
      throw new Error("Expected all-pass to request a new deal.");
    }

    const freshDeck = createDeck().reverse();
    const originalDeck = [...freshDeck];
    const result = transition(allPassed.state, { type: "deal", deck: freshDeck });

    expect(freshDeck).toEqual(originalDeck);
    expect(result).toMatchObject({
      ok: true,
      state: {
        phase: "bidding",
        hands: {
          human: [5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35, 38, 41, 44, 47, 50, 53]
            .map(asCardId),
        },
        bottomCards: [asCardId(0), asCardId(1), asCardId(2)],
        currentSeat: "human",
      },
    });
    freshDeck.reverse();
    if (!result.ok || result.state.phase !== "bidding") {
      throw new Error("Expected the fresh deck to enter bidding.");
    }
    const conservedCards = [
      ...result.state.hands.human,
      ...result.state.hands["ai-one"],
      ...result.state.hands["ai-two"],
      ...result.state.bottomCards,
    ].sort((left, right) => left - right);
    expect(conservedCards).toEqual(createDeck());
  });

  it("rejects out-of-turn and wrong-phase commands without changing state", () => {
    const bidding = deal();
    const humanCalls = transition(bidding, {
      type: "bid",
      seat: "human",
      decision: "call",
    });
    if (!humanCalls.ok || humanCalls.state.phase !== "ready-to-play") {
      throw new Error("Expected the human call to finish bidding.");
    }

    const cases = [
      {
        state: bidding,
        command: { type: "bid" as const, seat: "ai-one" as const, decision: "call" as const },
        code: "not-current-bidder",
      },
      {
        state: INITIAL_GAME_STATE,
        command: { type: "bid" as const, seat: "human" as const, decision: "call" as const },
        code: "command-not-allowed",
      },
      {
        state: bidding,
        command: { type: "deal" as const, deck: createDeck() },
        code: "command-not-allowed",
      },
      {
        state: humanCalls.state,
        command: { type: "bid" as const, seat: "human" as const, decision: "decline" as const },
        code: "command-not-allowed",
      },
    ] as const;

    for (const { state, command, code } of cases) {
      const result = transition(state, command);
      expect(result).toEqual({ ok: false, state, error: { code } });
      expect(result.state).toBe(state);
    }
  });

  it("returns deterministic deeply frozen serializable values without mutating inputs", () => {
    const deck = createDeck().reverse();
    const originalDeck = [...deck];

    const firstDeal = transition(INITIAL_GAME_STATE, { type: "deal", deck });
    const secondDeal = transition(INITIAL_GAME_STATE, { type: "deal", deck });

    expect(firstDeal).toEqual(secondDeal);
    expect(deck).toEqual(originalDeck);
    expectDeepFrozen(INITIAL_GAME_STATE);
    expectDeepFrozen(firstDeal);
    expect(JSON.parse(JSON.stringify(firstDeal))).toEqual(firstDeal);
    if (!firstDeal.ok || firstDeal.state.phase !== "bidding") {
      throw new Error("Expected the deterministic deal to enter bidding.");
    }

    const originalBidding = JSON.parse(JSON.stringify(firstDeal.state)) as unknown;
    const declined = transition(firstDeal.state, {
      type: "bid",
      seat: "human",
      decision: "decline",
    });
    expect(firstDeal.state).toEqual(originalBidding);
    expectDeepFrozen(declined);
    expect(JSON.parse(JSON.stringify(declined))).toEqual(declined);
    if (!declined.ok || declined.state.phase !== "bidding") {
      throw new Error("Expected bidding to continue with ai-one.");
    }

    const called = transition(declined.state, {
      type: "bid",
      seat: "ai-one",
      decision: "call",
    });
    expectDeepFrozen(called);
    expect(JSON.parse(JSON.stringify(called))).toEqual(called);

    const failure = transition(firstDeal.state, {
      type: "bid",
      seat: "ai-one",
      decision: "call",
    });
    expectDeepFrozen(failure);
    expect(JSON.parse(JSON.stringify(failure))).toEqual(failure);
  });
});
