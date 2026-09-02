import { describe, expect, it } from "vitest";

import {
  BASELINE_AI_STRATEGY,
  createPlayerView,
  runAiTurn,
  type AiStrategy,
} from "../../src/core/ai/index.js";
import { createDeck } from "../../src/core/cards/index.js";
import {
  INITIAL_GAME_STATE,
  transition,
  type BiddingState,
  type GameCommand,
  type GameState,
  type ReadyToPlayState,
} from "../../src/core/game/index.js";
import { generateLegalActions } from "../../src/core/rules/index.js";

function biddingForAiOne(): BiddingState {
  const dealt = transition(INITIAL_GAME_STATE, {
    type: "deal",
    deck: createDeck(),
  });
  if (!dealt.ok || dealt.state.phase !== "bidding") {
    throw new Error("Expected a successful deal.");
  }
  const declined = transition(dealt.state, {
    type: "bid",
    seat: "human",
    decision: "decline",
  });
  if (!declined.ok || declined.state.phase !== "bidding") {
    throw new Error("Expected bidding to continue with ai-one.");
  }
  return declined.state;
}

function readyWithAiOneLandlord(): ReadyToPlayState {
  const called = transition(biddingForAiOne(), {
    type: "bid",
    seat: "ai-one",
    decision: "call",
  });
  if (!called.ok || called.state.phase !== "ready-to-play") {
    throw new Error("Expected ai-one to become landlord.");
  }
  return called.state;
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

describe("redacted AI player views", () => {
  it("shows an AI its own bidding hand and public counts without bottom or opponent hands", () => {
    const state = biddingForAiOne();

    const view = createPlayerView(state, "ai-one");

    expect(view).toEqual({
      phase: "bidding",
      seat: "ai-one",
      hand: state.hands["ai-one"],
      currentSeat: "ai-one",
      declinedSeats: ["human"],
      remainingCardCounts: {
        human: 17,
        "ai-one": 17,
        "ai-two": 17,
      },
    });
    expect(view).not.toBeNull();
    expect(view).not.toHaveProperty("hands");
    expect(view).not.toHaveProperty("bottomCards");
    if (view !== null) {
      expect(view.hand).not.toBe(state.hands["ai-one"]);
      expect(Object.isFrozen(view)).toBe(true);
      expect(Object.isFrozen(view.hand)).toBe(true);
    }
  });

  it("shows revealed round data and only the requested seat's playing hand", () => {
    const state = readyWithAiOneLandlord();

    const view = createPlayerView(state, "ai-two");

    expect(view).toEqual({
      phase: "ready-to-play",
      seat: "ai-two",
      hand: state.hands["ai-two"],
      currentSeat: "ai-one",
      landlord: "ai-one",
      bottomCards: state.bottomCards,
      remainingCardCounts: {
        human: 17,
        "ai-one": 20,
        "ai-two": 17,
      },
      currentPlay: null,
      history: [],
    });
    expect(view).not.toHaveProperty("hands");
    if (view !== null && view.phase !== "bidding") {
      expect(view.hand).not.toBe(state.hands["ai-two"]);
      expect(view.bottomCards).not.toBe(state.bottomCards);
      expect(Object.isFrozen(view.history)).toBe(true);
    }
  });

  it("copies the current play and public history without exposing state references", () => {
    const ready = readyWithAiOneLandlord();
    const played = transition(ready, {
      type: "play",
      seat: "ai-one",
      cards: [ready.hands["ai-one"][0]!],
    });
    if (!played.ok || played.state.phase !== "playing") {
      throw new Error("Expected ai-one's lead to continue play.");
    }

    const view = createPlayerView(played.state, "ai-two");

    expect(view).toMatchObject({
      phase: "playing",
      seat: "ai-two",
      currentSeat: "ai-two",
      landlord: "ai-one",
      remainingCardCounts: {
        human: 17,
        "ai-one": 19,
        "ai-two": 17,
      },
      currentPlay: played.state.currentPlay,
      history: played.state.history,
    });
    if (view === null || view.phase !== "playing") {
      throw new Error("Expected a playing view.");
    }
    expect(view.currentPlay).not.toBe(played.state.currentPlay);
    expect(view.history).not.toBe(played.state.history);
    expect(view.history[0]).not.toBe(played.state.history[0]);
    expectDeepFrozen(view);
  });
});

describe("baseline AI strategy", () => {
  it("deterministically calls landlord for its own bidding seat", () => {
    const state = biddingForAiOne();
    const view = createPlayerView(state, "ai-one");
    if (view === null || view.phase !== "bidding") {
      throw new Error("Expected an ai-one bidding view.");
    }
    const context = Object.freeze({ kind: "bid" as const, view });

    expect(BASELINE_AI_STRATEGY.chooseCommand(context)).toEqual({
      type: "bid",
      seat: "ai-one",
      decision: "call",
    });
    expect(BASELINE_AI_STRATEGY.chooseCommand(context)).toEqual(
      BASELINE_AI_STRATEGY.chooseCommand(context),
    );
  });

  it("chooses the first engine-produced legal play for its own seat", () => {
    const state = readyWithAiOneLandlord();
    const view = createPlayerView(state, "ai-one");
    if (view === null || view.phase === "bidding") {
      throw new Error("Expected an ai-one playing view.");
    }
    const legalActions = generateLegalActions({
      hand: view.hand,
      currentPlay: view.currentPlay,
    });

    const command = BASELINE_AI_STRATEGY.chooseCommand(
      Object.freeze({ kind: "play", view, legalActions }),
    );

    expect(command).toEqual({
      type: "play",
      seat: "ai-one",
      cards: [state.hands["ai-one"][0]],
    });
    expect(Object.isFrozen(command)).toBe(true);
  });

  it("passes when the engine reports pass as the only legal response", () => {
    const ready = transition(INITIAL_GAME_STATE, {
      type: "deal",
      deck: createDeck(),
    });
    if (!ready.ok || ready.state.phase !== "bidding") {
      throw new Error("Expected a successful deal.");
    }
    const called = transition(ready.state, {
      type: "bid",
      seat: "human",
      decision: "call",
    });
    if (!called.ok || called.state.phase !== "ready-to-play") {
      throw new Error("Expected the human to become landlord.");
    }
    const rocket = transition(called.state, {
      type: "play",
      seat: "human",
      cards: createDeck().slice(52),
    });
    if (!rocket.ok || rocket.state.phase !== "playing") {
      throw new Error("Expected the human to lead the rocket.");
    }
    const view = createPlayerView(rocket.state, "ai-one");
    if (view === null || view.phase === "bidding") {
      throw new Error("Expected an ai-one response view.");
    }
    const legalActions = generateLegalActions({
      hand: view.hand,
      currentPlay: view.currentPlay,
    });

    expect(legalActions).toEqual([{ type: "pass" }]);
    expect(
      BASELINE_AI_STRATEGY.chooseCommand(
        Object.freeze({ kind: "play", view, legalActions }),
      ),
    ).toEqual({ type: "pass", seat: "ai-one" });
  });
});

describe("AI turn safety", () => {
  it("submits the baseline AI bidding command through the game transition", () => {
    const state = biddingForAiOne();
    const command = {
      type: "bid" as const,
      seat: "ai-one" as const,
      decision: "call" as const,
    };
    const expected = transition(state, command);
    if (!expected.ok) {
      throw new Error("Expected the baseline bid to be legal.");
    }

    const result = runAiTurn(state, BASELINE_AI_STRATEGY);

    expect(result).toEqual({
      ok: true,
      command,
      state: expected.state,
      events: expected.events,
    });
    expectDeepFrozen(result);
  });

  it("submits the baseline AI play through the same game transition", () => {
    const state = readyWithAiOneLandlord();
    const expectedCommand = {
      type: "play" as const,
      seat: "ai-one" as const,
      cards: [state.hands["ai-one"][0]!],
    };
    const expected = transition(state, expectedCommand);
    if (!expected.ok) {
      throw new Error("Expected the baseline play to be legal.");
    }

    expect(runAiTurn(state, BASELINE_AI_STRATEGY)).toEqual({
      ok: true,
      command: expectedCommand,
      state: expected.state,
      events: expected.events,
    });
  });

  it.each([
    {
      name: "spoofed seat",
      strategy: {
        chooseCommand: () => ({
          type: "bid" as const,
          seat: "human" as const,
          decision: "call" as const,
        }),
      },
      code: "not-current-bidder",
    },
    {
      name: "wrong-phase command",
      strategy: {
        chooseCommand: () => ({ type: "restart" as const }),
      },
      code: "command-not-allowed",
    },
  ] satisfies readonly {
    readonly name: string;
    readonly strategy: AiStrategy;
    readonly code: string;
  }[])("rejects a strategy's $name without changing state", ({ strategy, code }) => {
    const state = biddingForAiOne();

    const result = runAiTurn(state, strategy);

    expect(result).toEqual({
      ok: false,
      state,
      error: { code: "illegal-ai-command", gameError: { code } },
    });
    expect(result.state).toBe(state);
    expectDeepFrozen(result);
  });

  it.each([
    {
      name: "throws",
      strategy: {
        chooseCommand(): GameCommand {
          throw new Error("test strategy failure");
        },
      },
    },
    {
      name: "returns malformed runtime data",
      strategy: {
        chooseCommand: () => undefined as unknown as GameCommand,
      },
    },
  ] satisfies readonly { readonly name: string; readonly strategy: AiStrategy }[])(
    "contains a strategy that $name",
    ({ strategy }) => {
      const state = biddingForAiOne();

      const result = runAiTurn(state, strategy);

      expect(result).toEqual({
        ok: false,
        state,
        error: { code: "strategy-failed" },
      });
      expect(result.state).toBe(state);
    },
  );

  it("rejects a human turn without invoking the strategy", () => {
    const dealt = transition(INITIAL_GAME_STATE, {
      type: "deal",
      deck: createDeck(),
    });
    if (!dealt.ok) {
      throw new Error("Expected a successful deal.");
    }
    let calls = 0;
    const strategy: AiStrategy = {
      chooseCommand() {
        calls += 1;
        return { type: "bid", seat: "ai-one", decision: "call" };
      },
    };

    const result = runAiTurn(dealt.state, strategy);

    expect(result).toEqual({
      ok: false,
      state: dealt.state,
      error: { code: "not-ai-turn" },
    });
    expect(result.state).toBe(dealt.state);
    expect(calls).toBe(0);
  });
});

function firstLegalHumanCommand(state: GameState): GameCommand {
  if (
    (state.phase !== "ready-to-play" && state.phase !== "playing") ||
    state.currentSeat !== "human"
  ) {
    throw new Error("Expected an active human play turn.");
  }
  const view = createPlayerView(state, "human");
  if (view === null || view.phase === "bidding") {
    throw new Error("Expected a human playing view.");
  }
  const action = generateLegalActions({
    hand: view.hand,
    currentPlay: view.currentPlay,
  })[0];
  if (action === undefined || action.type === "pass") {
    return { type: "pass", seat: "human" };
  }
  return { type: "play", seat: "human", cards: action.play.cards };
}

describe("automated baseline games", () => {
  it.each([
    { name: "canonical order", deck: createDeck() },
    { name: "reverse order", deck: createDeck().reverse() },
    {
      name: "rotated order",
      deck: [...createDeck().slice(17), ...createDeck().slice(0, 17)],
    },
  ])("terminates the $name game with both AI seats acting", ({ deck }) => {
    const dealt = transition(INITIAL_GAME_STATE, { type: "deal", deck });
    if (!dealt.ok || dealt.state.phase !== "bidding") {
      throw new Error("Expected a successful deal.");
    }
    const humanDeclined = transition(dealt.state, {
      type: "bid",
      seat: "human",
      decision: "decline",
    });
    if (!humanDeclined.ok) {
      throw new Error("Expected the human decline to continue bidding.");
    }
    const landlordSelected = runAiTurn(humanDeclined.state, BASELINE_AI_STRATEGY);
    if (!landlordSelected.ok) {
      throw new Error(`Expected legal AI bidding, received ${landlordSelected.error.code}.`);
    }

    let state = landlordSelected.state;
    let commandCount = 0;
    const actingAiSeats = new Set<string>();
    while (state.phase !== "finished" && commandCount < 256) {
      if (state.phase !== "ready-to-play" && state.phase !== "playing") {
        throw new Error(`Unexpected game phase during automated play: ${state.phase}.`);
      }

      if (state.currentSeat === "human") {
        const result = transition(state, firstLegalHumanCommand(state));
        if (!result.ok) {
          throw new Error(`Expected legal human driver command, received ${result.error.code}.`);
        }
        state = result.state;
      } else {
        actingAiSeats.add(state.currentSeat);
        const result = runAiTurn(state, BASELINE_AI_STRATEGY);
        if (!result.ok) {
          throw new Error(`Expected legal AI command, received ${result.error.code}.`);
        }
        state = result.state;
      }
      commandCount += 1;
    }

    expect(state.phase).toBe("finished");
    expect(commandCount).toBeLessThan(256);
    expect(actingAiSeats).toEqual(new Set(["ai-one", "ai-two"]));
  });
});
