import { describe, expect, it } from "vitest";

import {
  asCardId,
  createDeck,
  type CardId,
} from "../../src/core/cards/index.js";
import {
  INITIAL_GAME_STATE,
  transition,
  type FinishedState,
  type PlayingState,
  type Seat,
} from "../../src/core/game/index.js";

const FINAL_CARDS: Readonly<Record<Seat, CardId>> = Object.freeze({
  human: asCardId(0),
  "ai-one": asCardId(4),
  "ai-two": asCardId(8),
});

function nearFinish(landlord: Seat, winner: Seat): PlayingState {
  return {
    phase: "playing",
    hands: {
      human: [FINAL_CARDS.human],
      "ai-one": [FINAL_CARDS["ai-one"]],
      "ai-two": [FINAL_CARDS["ai-two"]],
    },
    bottomCards: [],
    landlord,
    currentSeat: winner,
    currentPlay: null,
    lastPlaySeat: null,
    consecutivePasses: 0,
    history: [],
  };
}

function finishRound(landlord: Seat, winner: Seat): FinishedState {
  const result = transition(nearFinish(landlord, winner), {
    type: "play",
    seat: winner,
    cards: [FINAL_CARDS[winner]],
  });
  if (!result.ok || result.state.phase !== "finished") {
    throw new Error("Expected the final card to finish the round.");
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

describe("game result", () => {
  it.each([
    {
      name: "human landlord wins",
      landlord: "human",
      winner: "human",
      result: {
        winner: "human",
        winningSide: "landlord",
        humanRole: "landlord",
        humanOutcome: "win",
      },
    },
    {
      name: "AI farmer defeats the human landlord",
      landlord: "human",
      winner: "ai-one",
      result: {
        winner: "ai-one",
        winningSide: "farmers",
        humanRole: "landlord",
        humanOutcome: "loss",
      },
    },
    {
      name: "human farmer defeats an AI landlord",
      landlord: "ai-one",
      winner: "human",
      result: {
        winner: "human",
        winningSide: "farmers",
        humanRole: "farmer",
        humanOutcome: "win",
      },
    },
    {
      name: "AI landlord defeats the human farmer",
      landlord: "ai-one",
      winner: "ai-one",
      result: {
        winner: "ai-one",
        winningSide: "landlord",
        humanRole: "farmer",
        humanOutcome: "loss",
      },
    },
  ] as const)("derives presentation data when $name", ({ landlord, winner, result }) => {
    const state = nearFinish(landlord, winner);

    const transitionResult = transition(state, {
      type: "play",
      seat: winner,
      cards: [FINAL_CARDS[winner]],
    });

    expect(transitionResult).toMatchObject({
      ok: true,
      state: {
        phase: "finished",
        landlord,
        winner,
        result,
      },
      events: [
        { type: "cards-played", seat: winner, remainingCardCount: 0 },
        { type: "game-finished", winner, result },
      ],
    });
  });

  it("restarts a finished round at the clean awaiting-deal boundary", () => {
    const finished = finishRound("human", "human");

    const result = transition(finished, { type: "restart" });

    expect(result).toEqual({
      ok: true,
      state: INITIAL_GAME_STATE,
      events: [{ type: "game-restarted" }],
    });
    expect(finished.phase).toBe("finished");
    expectDeepFrozen(finished);
    expectDeepFrozen(result);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);

    const freshDeal = transition(result.state, {
      type: "deal",
      deck: createDeck().reverse(),
    });
    expect(freshDeal).toMatchObject({
      ok: true,
      state: { phase: "bidding", currentSeat: "human" },
      events: [{ type: "deal-completed" }],
    });

    const wrongPhase = transition(INITIAL_GAME_STATE, { type: "restart" });
    expect(wrongPhase).toEqual({
      ok: false,
      state: INITIAL_GAME_STATE,
      error: { code: "command-not-allowed" },
    });
    expect(wrongPhase.state).toBe(INITIAL_GAME_STATE);
  });
});
