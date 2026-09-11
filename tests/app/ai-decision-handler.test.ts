import { describe, expect, it } from "vitest";

import {
  decideEnhancedAi,
  type EnhancedAiWorkerRequest,
} from "../../src/app/ai/decision-handler.js";
import type { EnhancedAiType } from "../../src/app/ports/ai-decision-service.js";
import { createPlayerView, type AiDecisionContext } from "../../src/core/ai/index.js";
import { createDeck } from "../../src/core/cards/index.js";
import {
  INITIAL_GAME_STATE,
  transition,
  type GameState,
} from "../../src/core/game/index.js";
import { generateLegalActions } from "../../src/core/rules/index.js";

function playingContext(): Extract<AiDecisionContext, { readonly kind: "play" }> {
  const dealt = transition(INITIAL_GAME_STATE, { type: "deal", deck: createDeck() });
  if (!dealt.ok || dealt.state.phase !== "bidding") {
    throw new Error("Expected deal.");
  }
  const declined = transition(dealt.state, {
    type: "bid",
    seat: "human",
    decision: "decline",
  });
  if (!declined.ok || declined.state.phase !== "bidding") {
    throw new Error("Expected decline.");
  }
  const called = transition(declined.state, {
    type: "bid",
    seat: "ai-one",
    decision: "call",
  });
  if (!called.ok || called.state.phase !== "ready-to-play") {
    throw new Error("Expected AI landlord.");
  }
  const view = createPlayerView(called.state, "ai-one");
  if (view === null || view.phase === "bidding") {
    throw new Error("Expected playing view.");
  }
  return Object.freeze({
    kind: "play",
    view,
    legalActions: generateLegalActions({ hand: view.hand, currentPlay: null }),
  });
}

function fixedPlayingState(): GameState {
  const dealt = transition(INITIAL_GAME_STATE, { type: "deal", deck: createDeck() });
  if (!dealt.ok || dealt.state.phase !== "bidding") {
    throw new Error("Expected fixed deal.");
  }
  const called = transition(dealt.state, { type: "bid", seat: "human", decision: "call" });
  if (!called.ok) {
    throw new Error("Expected fixed landlord.");
  }
  return called.state;
}

function playCompleteEnhancedGame(aiType: EnhancedAiType): number {
  let state = fixedPlayingState();
  let commandCount = 0;
  while (state.phase !== "finished" && commandCount < 256) {
    if (state.phase !== "ready-to-play" && state.phase !== "playing") {
      throw new Error(`Unexpected enhanced-game phase: ${state.phase}.`);
    }
    const view = createPlayerView(state, state.currentSeat);
    if (view === null || view.phase === "bidding") {
      throw new Error("Expected enhanced playing view.");
    }
    const context: Extract<AiDecisionContext, { readonly kind: "play" }> = Object.freeze({
      kind: "play",
      view,
      legalActions: generateLegalActions({ hand: view.hand, currentPlay: view.currentPlay }),
    });
    let clockReads = 0;
    const outcome = decideEnhancedAi({
      requestId: commandCount,
      aiType,
      context,
      seed: 100 + commandCount,
    }, {
      deadline: 10,
      // Master returns its best bounded root result once this synthetic
      // deadline expires. Sampling itself is covered by the core fixtures.
      now: () => (++clockReads <= 2 ? 0 : 11),
    });
    if (!outcome.ok) {
      throw new Error(`Enhanced ${aiType} decision failed.`);
    }
    const result = transition(state, outcome.command);
    if (!result.ok) {
      throw new Error(`Enhanced ${aiType} produced ${result.error.code}.`);
    }
    state = result.state;
    commandCount += 1;
  }
  if (state.phase !== "finished") {
    throw new Error(`Enhanced ${aiType} game exceeded 256 commands.`);
  }
  return commandCount;
}

describe("enhanced AI request handler", () => {
  it.each(["casual", "expert", "master"] as const)(
    "finishes a deterministic full game with legal %s commands",
    (aiType) => {
      expect(playCompleteEnhancedGame(aiType)).toBeLessThan(256);
    },
  );

  it.each(["casual", "expert", "master"] as const)(
    "returns a legal serializable command for %s",
    (aiType) => {
      const context = playingContext();
      let elapsed = 0;
      const request: EnhancedAiWorkerRequest = {
        requestId: 4,
        aiType,
        context,
        seed: 11,
      };
      const outcome = decideEnhancedAi(request, {
        deadline: 45,
        now: () => {
          elapsed += 20;
          return elapsed;
        },
      });

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) {
        return;
      }
      expect(outcome.command.type).toBe("play");
      expect(context.legalActions.some((action) =>
        action.type === "play" && outcome.command.type === "play" &&
        action.play.cards.join(",") === outcome.command.cards.join(","),
      )).toBe(true);
      expect(() => structuredClone(outcome)).not.toThrow();
    },
  );

  it("returns the expert fallback when the master deadline has already expired", () => {
    const context = playingContext();
    const expert = decideEnhancedAi({
      requestId: 1,
      aiType: "expert",
      context,
      seed: 8,
    }, { deadline: 10, now: () => 0 });
    const master = decideEnhancedAi({
      requestId: 2,
      aiType: "master",
      context,
      seed: 8,
    }, { deadline: 0, now: () => 1 });

    expect(master).toEqual(expert);
  });
});
