import { describe, expect, it } from "vitest";

import {
  CASUAL_AI_STRATEGY,
  EXPERT_AI_STRATEGY,
  SCORING_CASUAL_AI_STRATEGY,
  createPlayerView,
  rankMasterPlayActions,
  rankScoredPlayActions,
  type AiDecisionContext,
  type AiStrategy,
} from "../src/core/ai/index.js";
import {
  createDeck,
  shuffle,
  type CardId,
  type RandomSource,
} from "../src/core/cards/index.js";
import {
  INITIAL_GAME_STATE,
  SEAT_ORDER,
  transition,
  type GameCommand,
  type GameState,
  type Seat,
} from "../src/core/game/index.js";
import { generateLegalActions } from "../src/core/rules/index.js";

type Profile = "casual" | "default" | "expert" | "master";
type Timing = Record<Profile, number[]>;

function seededRandom(seed: number): RandomSource {
  let value = seed >>> 0;
  return {
    next() {
      value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
      return value / 0x1_0000_0000;
    },
  };
}

function masterStrategy(seed: number): AiStrategy {
  let decision = 0;
  return Object.freeze({
    chooseCommand(context: AiDecisionContext): GameCommand {
      if (context.kind === "bid") {
        return EXPERT_AI_STRATEGY.chooseCommand(context);
      }
      const ranked = rankMasterPlayActions(context, {
        maxWorlds: 4,
        rolloutDepth: 3,
        rootAnalyzerNodes: 220,
        seed: seed + decision,
      });
      decision += 1;
      const action = ranked[0]?.action;
      return action === undefined || action.type === "pass"
        ? { type: "pass", seat: context.view.seat }
        : { type: "play", seat: context.view.seat, cards: action.play.cards };
    },
  });
}

const BENCHMARK_EXPERT_STRATEGY: AiStrategy = Object.freeze({
  chooseCommand(context: AiDecisionContext): GameCommand {
    if (context.kind === "bid") {
      return EXPERT_AI_STRATEGY.chooseCommand(context);
    }
    const action = rankScoredPlayActions(context, "expert", { analyzerNodes: 220 })[0]?.action;
    return action === undefined || action.type === "pass"
      ? { type: "pass", seat: context.view.seat }
      : { type: "play", seat: context.view.seat, cards: action.play.cards };
  },
});

function strategyFor(profile: Profile, seed: number): AiStrategy {
  switch (profile) {
    case "casual": return SCORING_CASUAL_AI_STRATEGY;
    case "default": return CASUAL_AI_STRATEGY;
    case "expert": return BENCHMARK_EXPERT_STRATEGY;
    case "master": return masterStrategy(seed);
  }
}

function startWithLandlord(deck: readonly CardId[], landlord: Seat): GameState {
  const dealt = transition(INITIAL_GAME_STATE, { type: "deal", deck });
  if (!dealt.ok || dealt.state.phase !== "bidding") {
    throw new Error("Benchmark deal failed.");
  }
  let state = dealt.state;
  for (const seat of SEAT_ORDER) {
    const bid = transition(state, {
      type: "bid",
      seat,
      decision: seat === landlord ? "call" : "decline",
    });
    if (!bid.ok) {
      throw new Error(`Benchmark bid failed: ${bid.error.code}`);
    }
    if (seat === landlord) {
      return bid.state;
    }
    if (bid.state.phase !== "bidding") {
      throw new Error("Benchmark bidding ended before its fixed landlord.");
    }
    state = bid.state;
  }
  throw new Error("Benchmark landlord was not selected.");
}

function choose(
  state: Extract<GameState, { readonly currentSeat: Seat }>,
  strategy: AiStrategy,
): GameCommand {
  const view = createPlayerView(state, state.currentSeat);
  if (view === null || view.phase === "bidding") {
    throw new Error("Benchmark expected a playing view.");
  }
  return strategy.chooseCommand(Object.freeze({
    kind: "play",
    view,
    legalActions: generateLegalActions({ hand: view.hand, currentPlay: view.currentPlay }),
  }));
}

function playGame(
  deck: readonly CardId[],
  landlord: Seat,
  profiles: Readonly<Record<Seat, Profile>>,
  timing: Timing,
  seed: number,
): Seat {
  let state = startWithLandlord(deck, landlord);
  const strategies: Record<Seat, AiStrategy> = {
    human: strategyFor(profiles.human, seed + 1),
    "ai-one": strategyFor(profiles["ai-one"], seed + 2),
    "ai-two": strategyFor(profiles["ai-two"], seed + 3),
  };
  for (let commandCount = 0; commandCount < 256; commandCount += 1) {
    if (state.phase === "finished") {
      return state.winner;
    }
    if (state.phase !== "ready-to-play" && state.phase !== "playing") {
      throw new Error(`Unexpected benchmark phase: ${state.phase}`);
    }
    const profile = profiles[state.currentSeat];
    const started = performance.now();
    const command = choose(state, strategies[state.currentSeat]);
    timing[profile].push(performance.now() - started);
    const result = transition(state, command);
    if (!result.ok) {
      throw new Error(`Illegal ${profile} command: ${result.error.code}`);
    }
    state = result.state;
  }
  throw new Error("Benchmark game exceeded 256 commands.");
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

describe("role-balanced AI benchmark", () => {
  it("reports adjacent profile outcomes and timing without entering the daily check", () => {
    const dealCount = Math.max(1, Number.parseInt(process.env.AI_BENCH_DEALS ?? "2", 10) || 2);
    const timing: Timing = { casual: [], default: [], expert: [], master: [] };
    const comparisons = [
      ["casual", "default"],
      ["default", "expert"],
      ["expert", "master"],
    ] as const;
    const summaries: string[] = [];

    for (const [weaker, stronger] of comparisons) {
      let strongerWins = 0;
      let games = 0;
      for (let dealSeed = 301; dealSeed < 301 + dealCount; dealSeed += 1) {
        const deck = shuffle(createDeck(), seededRandom(dealSeed));
        for (const landlord of SEAT_ORDER) {
          const strongerLandlord: Record<Seat, Profile> = {
            human: weaker,
            "ai-one": weaker,
            "ai-two": weaker,
          };
          strongerLandlord[landlord] = stronger;
          if (playGame(deck, landlord, strongerLandlord, timing, dealSeed * 10) === landlord) {
            strongerWins += 1;
          }
          games += 1;

          const strongerFarmers: Record<Seat, Profile> = {
            human: stronger,
            "ai-one": stronger,
            "ai-two": stronger,
          };
          strongerFarmers[landlord] = weaker;
          if (playGame(deck, landlord, strongerFarmers, timing, dealSeed * 20) !== landlord) {
            strongerWins += 1;
          }
          games += 1;
        }
      }
      summaries.push(`${stronger} vs ${weaker}: ${strongerWins}/${games}`);
    }

    for (const profile of ["casual", "default", "expert", "master"] as const) {
      summaries.push(
        `${profile} ms median=${percentile(timing[profile], 0.5).toFixed(2)} ` +
        `p95=${percentile(timing[profile], 0.95).toFixed(2)} ` +
        `max=${Math.max(...timing[profile], 0).toFixed(2)}`,
      );
    }
    console.log(`\n${summaries.join("\n")}`);
    expect(timing.casual.length).toBeGreaterThan(0);
    expect(timing.default.length).toBeGreaterThan(0);
    expect(timing.expert.length).toBeGreaterThan(0);
    expect(timing.master.length).toBeGreaterThan(0);
  });
});
