/**
 * Spec 023 measurement: how often does the winning-distance aggregation change
 * master's move, and what does a position where it does look like?
 *
 * Research scaffolding. Delete with the rest of `benchmarks/diagnosis/`.
 */

import { describe, expect, it } from "vitest";

import type { AiDecisionContext } from "../../src/core/ai/index.js";
import { DEFAULT_AI_STRATEGY, createPlayerView } from "../../src/core/ai/index.js";
import { rankMasterPlayActions } from "../../src/core/ai/enhanced.js";
import { transition } from "../../src/core/game/index.js";
import type { GameState } from "../../src/core/game/index.js";
import { generateLegalActions } from "../../src/core/rules/index.js";
import { armSchedule, dealDeck, startWithLandlord } from "../ai-tournament.js";
import { rankWithSumUtility } from "./master-flip.js";

const DEALS = Number(process.env.AI_FLIP_DEALS ?? "25");
const SEED_BASE = Number(process.env.AI_FLIP_SEED ?? "301");
const MASTER_OPTIONS = { maxWorlds: 32, rolloutDepth: 3 as const, rootAnalyzerNodes: 220 };

function actionKey(action: unknown): string {
  const candidate = action as { type?: string; play?: { cards: readonly number[] } };
  if (candidate.type !== "play") {
    return "pass";
  }
  return [...(candidate.play?.cards ?? [])].sort((left, right) => left - right).join(",");
}

describe("spec 023 aggregation flip", () => {
  it(`measures ${String(DEALS)} deals of master decisions`, () => {
    let decisions = 0;
    let flips = 0;
    let farmerRoots = 0;
    let farmerFlips = 0;
    let examples = 0;
    const lines: string[] = [];

    for (let dealIndex = 0; dealIndex < DEALS; dealIndex += 1) {
      const deck = dealDeck(SEED_BASE + dealIndex);
      for (const game of armSchedule(dealIndex)) {
        // Only the strong seat is interesting; the weak seats are `default`.
        let state: GameState = startWithLandlord(deck, game.landlord);
        for (let commandCount = 0; commandCount < 256; commandCount += 1) {
          if (state.phase === "finished") {
            break;
          }
          if (state.phase !== "ready-to-play" && state.phase !== "playing") {
            throw new Error(`Unexpected phase: ${state.phase}`);
          }
          const seat = state.currentSeat;
          const view = createPlayerView(state, seat);
          if (view === null || view.phase === "bidding") {
            throw new Error("Expected a playing view.");
          }
          const context: Extract<AiDecisionContext, { readonly kind: "play" }> = Object.freeze({
            kind: "play",
            view,
            legalActions: generateLegalActions({ hand: view.hand, currentPlay: view.currentPlay }),
          });

          let command;
          if (seat === game.strongSeat) {
            const seed = 424_242;
            const real = rankMasterPlayActions(context, { ...MASTER_OPTIONS, seed })[0]?.action;
            const stubbed = rankWithSumUtility(context, seed)[0]?.action;
            decisions += 1;
            const isFarmerRoot = seat !== game.landlord;
            if (isFarmerRoot) {
              farmerRoots += 1;
            }
            if (actionKey(real) !== actionKey(stubbed)) {
              flips += 1;
              if (isFarmerRoot) {
                farmerFlips += 1;
              }
              if (examples < 3) {
                examples += 1;
                lines.push(
                  `  flip: seat=${seat} landlord=${game.landlord} hand=${String(view.hand.length)} cards=${view.hand.join(",")} currentPlay=${view.currentPlay === null ? "none" : actionKey(view.currentPlay)} real=${actionKey(real)} sum=${actionKey(stubbed)}`,
                );
              }
            }
            command = real?.type === "play"
              ? Object.freeze({ type: "play" as const, seat, cards: real.play.cards })
              : Object.freeze({ type: "pass" as const, seat });
          } else {
            // The other seats play the shipped default level.
            command = DEFAULT_AI_STRATEGY.chooseCommand(context);
          }
          const result = transition(state, command);
          if (!result.ok) {
            throw new Error(`Illegal command: ${result.error.code}`);
          }
          state = result.state;
        }
      }
    }

    console.log(
      [
        "",
        `master decisions: ${String(decisions)} (farmer root: ${String(farmerRoots)})`,
        `moves changed by the aggregation: ${String(flips)} (${((flips / Math.max(1, decisions)) * 100).toFixed(1)}%), of which farmer root: ${String(farmerFlips)}`,
        ...lines,
        "",
      ].join("\n"),
    );

    expect(decisions).toBeGreaterThan(0);
  }, 1_800_000);
});
