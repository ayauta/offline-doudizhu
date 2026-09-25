import { describe, expect, it } from "vitest";

import { CASUAL_AI_STRATEGY, createPlayerView } from "../../src/core/ai/index.js";
import {
  rankMasterPlayActions,
  rankPlayActionsWithProposal,
  type ScoredActionDetail,
} from "../../src/core/ai/enhanced.js";
import { createDeck, shuffle, type RandomSource } from "../../src/core/cards/index.js";
import {
  INITIAL_GAME_STATE,
  SEAT_ORDER,
  transition,
  type GameState,
  type Seat,
} from "../../src/core/game/index.js";
import { generateLegalActions } from "../../src/core/rules/index.js";

/**
 * The invariants below are properties of the *orderings*, not of any score's
 * magnitude, so a smaller allowance tests the same contract for far less work
 * in the daily gate.
 */
const PROPOSAL_ANALYZER_NODES = 64;

function seeded(seed: number): RandomSource {
  let value = seed >>> 0;
  return {
    next() {
      value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
      return value / 0x1_0000_0000;
    },
  };
}

function dealWithLandlord(seed: number, landlord: Seat): GameState {
  const deck = shuffle(createDeck(), seeded(seed));
  const dealt = transition(INITIAL_GAME_STATE, { type: "deal", deck });
  if (!dealt.ok) {
    throw new Error("test deal failed");
  }
  let state = dealt.state;
  for (const seat of SEAT_ORDER) {
    const bid = transition(state, {
      type: "bid",
      seat,
      decision: seat === landlord ? "call" : "decline",
    });
    if (!bid.ok) {
      throw new Error("test bid failed");
    }
    if (seat === landlord) {
      return bid.state;
    }
    state = bid.state;
  }
  throw new Error("test landlord was not selected");
}

/** Every decision context a game passes through. */
function decisionContexts(dealSeed: number, landlord: Seat): number {
  let state = dealWithLandlord(dealSeed, landlord);
  let contexts = 0;

  for (let step = 0; step < 256; step += 1) {
    if (state.phase === "finished") {
      break;
    }
    if (state.phase !== "ready-to-play" && state.phase !== "playing") {
      throw new Error(`unexpected phase ${state.phase}`);
    }
    const seat = state.currentSeat;
    const view = createPlayerView(state, seat);
    if (view === null || view.phase === "bidding") {
      throw new Error("expected a playing view");
    }
    const context = Object.freeze({
      kind: "play" as const,
      view,
      legalActions: generateLegalActions({ hand: view.hand, currentPlay: view.currentPlay }),
    });
    contexts += 1;

    const candidates = rankMasterPlayActions(context, {
      seed: dealSeed * 31 + step,
      maxWorlds: 1,
      rolloutDepth: 2,
    });
    const legalCount = context.legalActions.length;

    // The shortlist is always min(3, legal actions) long. Any future change to
    // which candidates are admitted has to keep that size, or it silently
    // changes the root-level search budget along with the candidate set.
    expect(candidates.length, `legal actions ${legalCount}`).toBe(Math.min(3, legalCount));

    const proposal = rankPlayActionsWithProposal(context, "expert", {
      analyzerNodes: PROPOSAL_ANALYZER_NODES,
    });
    // base + prior is exactly what ships, except for a play that empties the
    // hand, which the shipped code scores before the prior is applied.
    for (const detail of proposal.details as readonly ScoredActionDetail[]) {
      const emptiesHand = detail.action.type === "play" &&
        detail.action.play.cards.length === view.hand.length;
      if (emptiesHand) {
        expect(detail.baseScore).toBe(1_000_000);
        expect(detail.prior).toBe(0);
      } else {
        expect(detail.anchoredScore).toBe(detail.baseScore + detail.prior);
      }
      expect(detail.prior % 160).toBe(0);
      expect(detail.prior).toBeLessThanOrEqual(12 * 160);
    }

    // Play every seat with the same strategy, exactly as the benchmark's game
    // loop does — `runAiTurn` refuses the human seat by contract.
    const applied = transition(state, CASUAL_AI_STRATEGY.chooseCommand(context));
    if (!applied.ok) {
      throw new Error(`test turn failed: ${applied.error.code}`);
    }
    state = applied.state;
  }

  return contexts;
}

describe("scoring split and shortlist size", () => {
  it("keeps base + prior equal to the shipped score, and the shortlist min(3, legal)", () => {
    let contexts = 0;
    // Six deals is enough to exercise these invariants; this test plays real
    // games, and the daily gate should not pay for more coverage than that.
    for (let deal = 0; deal < 6; deal += 1) {
      const landlord = SEAT_ORDER[deal % SEAT_ORDER.length] as Seat;
      contexts += decisionContexts(20_260_920 + deal, landlord);
    }
    expect(contexts).toBeGreaterThan(200);
  }, 30_000);
});
