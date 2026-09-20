/**
 * Gate B-A: full-game strength validation of the frozen farmer selector.
 *
 * Three env-gated modes.
 *
 *   invariant  AI_CF_GB_INVARIANT=1 AI_BENCH_DEAL_START=40001 AI_BENCH_DEALS=8
 *   run        AI_CF_GB_OUT=<shard.json> AI_CF_GB_ARM=baseline|challenger \
 *              AI_BENCH_DEAL_START=40001 AI_BENCH_DEALS=150
 *   report     AI_CF_GB_REPORT=<baseline.json>,<challenger.json>
 *
 * The two arms differ in exactly one thing: whether the strong seat's strategy
 * is decorated with the frozen selector. Same schedule, same deals, same seeds,
 * same opponents — so the per-deal difference is the selector and nothing else.
 *
 * The strength numbers come out of `paired-compare.test.ts`'s method, not a new
 * one: this file only produces dumps in the shape that harness already reads.
 * Re-deriving the statistics for a new experiment is how two experiments end up
 * not comparable.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SEAT_ORDER, type Seat } from "../src/core/game/index.js";
import {
  createMeasuredStrategy,
  createRecorder,
  dealDeck,
  playGame,
  readConfig,
  report,
  runPairTournament,
  scheduleFor,
} from "./ai-tournament.js";
import { parseTreeModel, type TreeModel } from "./cf-model.js";
import { createChallengerStrategy, createSelectorStats, type SelectorStats } from "./cf-challenger.js";
import { percentile } from "./ai-stats.js";

const INVARIANT = process.env.AI_CF_GB_INVARIANT === "1";
const OUT = process.env.AI_CF_GB_OUT;
const REPORT = process.env.AI_CF_GB_REPORT;
const ENABLED = INVARIANT || OUT !== undefined || REPORT !== undefined;

const MODEL_PATH = process.env.AI_CF_MODEL ?? ".local/cf-rows/model.json";
const THRESHOLD_FILE = process.env.AI_CF_THRESHOLD_FILE ?? ".local/cf-rows/threshold.json";

/**
 * The threshold comes out of the frozen calibration artifact, never from a
 * literal here: a retyped threshold is a second source of truth, and the one
 * that drifts is always the one nobody re-reads.
 */
function frozenThreshold(): number {
  const record = JSON.parse(readFileSync(THRESHOLD_FILE, "utf8")) as {
    decision: string;
    selected: number | null;
  };
  if (record.decision !== "selected" || typeof record.selected !== "number") {
    throw new Error("No threshold was frozen; Gate B must not run.");
  }
  return record.selected;
}

function loadModel(): TreeModel {
  return parseTreeModel(JSON.parse(readFileSync(MODEL_PATH, "utf8")));
}

type ArmRun = Readonly<{ perDealA: number[]; perDealB: number[] }>;

function runArm(arm: "baseline" | "challenger"): Readonly<{
  run: ArmRun;
  games: SelectorStats[];
}> {
  const config = readConfig();
  expect(config.designed).toBe(true);
  const model = loadModel();
  const threshold = frozenThreshold();
  const perGame: SelectorStats[] = [];
  const recorder = createRecorder();

  const pairRun = runPairTournament(config, "master", "default", recorder, {
    quiet: false,
    ...(arm === "challenger" ? {
      decoratorFor: (strongSeat: Seat) => {
        const stats = createSelectorStats();
        perGame.push(stats);
        return (strategy: ReturnType<typeof createMeasuredStrategy>) =>
          createChallengerStrategy(strategy, { model, threshold, seat: strongSeat, stats });
      },
    } : {}),
  });

  return Object.freeze({
    run: Object.freeze({
      perDealA: [...pairRun.perDealA],
      perDealB: [...pairRun.perDealB],
    }),
    games: perGame,
  });
}

describe.runIf(ENABLED)("Gate B", () => {
  it("checks the landlord invariant, runs one arm, or reports the pair", () => {
    if (INVARIANT) {
      // The landlord arm must be byte-identical between baseline and challenger.
      // Measured on the command stream, per game, not on the win totals: equal
      // win totals can still hide different play.
      const config = readConfig();
      const model = loadModel();
      const threshold = frozenThreshold();
      let games = 0;
      let divergences = 0;
      let firstDivergence = -1;
      let commandCount = 0;

      for (let offset = 0; offset < config.deals; offset += 1) {
        const dealIndex = config.dealStart + offset;
        const dealSeed = config.seedBase + dealIndex;
        const deck = dealDeck(dealSeed);
        for (const strongSeat of SEAT_ORDER) {
          // Arm A only: the strong level holds the landlord seat.
          const profiles = scheduleFor("master", "default", strongSeat);
          const gameSeed = dealSeed * 100 +
            SEAT_ORDER.indexOf(strongSeat) * 10 + SEAT_ORDER.indexOf(strongSeat);
          const play = (decorate: boolean): readonly string[] => {
            const rec = createRecorder({ logCommands: true });
            playGame(deck, strongSeat, profiles, rec, {
              unboundedEvery: config.unboundedEvery,
              seed: gameSeed,
              designed: true,
              ...(decorate ? {
                decorate: (seat: Seat, strategy: ReturnType<typeof createMeasuredStrategy>) =>
                  seat === strongSeat
                    ? createChallengerStrategy(strategy, {
                        model, threshold, seat: strongSeat, stats: createSelectorStats(),
                      })
                    : strategy,
              } : {}),
            });
            return rec.commands ?? [];
          };
          const baseline = play(false);
          const challenger = play(true);
          games += 1;
          commandCount += baseline.length;
          if (baseline.length !== challenger.length ||
            baseline.some((command, index) => command !== challenger[index])) {
            divergences += 1;
            if (firstDivergence < 0) {
              firstDivergence = games;
            }
          }
        }
      }
      report(`\nlandlord invariant: ${games} games, ${commandCount} baseline commands`);
      report(`divergent games ${divergences}${firstDivergence >= 0 ? ` (first #${firstDivergence})` : ""}`);
      expect(divergences).toBe(0);
      return;
    }

    if (OUT !== undefined) {
      const arm = (process.env.AI_CF_GB_ARM ?? "baseline") as "baseline" | "challenger";
      const { run, games } = runArm(arm);
      const config = readConfig();
      writeFileSync(OUT, `${JSON.stringify({
        label: `phase2-${arm}`,
        config: {
          deals: config.deals,
          seedBase: config.seedBase,
          dealStart: config.dealStart,
          designed: config.designed,
        },
        runs: { "master-default": { ...run, stoppedEarly: false } },
      }, null, 2)}\n`, "utf8");

      // Selector instrumentation, only meaningful on the challenger arm.
      const decisions = games.reduce((sum, stats) => sum + stats.decisions, 0);
      const eligible = games.reduce((sum, stats) => sum + stats.eligible, 0);
      const overrides = games.reduce((sum, stats) => sum + stats.overrides, 0);
      const featureMs = games.flatMap((stats) =>
        stats.eligible === 0 ? [] : [stats.featureMs / Math.max(1, stats.eligible)]);
      const inferenceMs = games.flatMap((stats) =>
        stats.eligible === 0 ? [] : [stats.inferenceMs / Math.max(1, stats.eligible)]);
      report(
        `[gate-b ${arm}] deals ${run.perDealA.length} decisions ${decisions} eligible ${eligible} ` +
        `overrides ${overrides} ` +
        `feature p50 ${percentile(featureMs, 0.5).toFixed(3)}ms p95 ${percentile(featureMs, 0.95).toFixed(3)}ms ` +
        `max ${(featureMs.length === 0 ? 0 : Math.max(...featureMs)).toFixed(3)}ms ` +
        `inference p50 ${percentile(inferenceMs, 0.5).toFixed(3)}ms p95 ${percentile(inferenceMs, 0.95).toFixed(3)}ms ` +
        `max ${(inferenceMs.length === 0 ? 0 : Math.max(...inferenceMs)).toFixed(3)}ms`,
      );
      expect(run.perDealA.length).toBeGreaterThan(0);
      return;
    }

    // Report mode: describe the pair for the human reader. The interval itself
    // is produced by paired-compare.test.ts from the same two files.
    const [basePath, candPath] = (REPORT as string).split(",");
    if (basePath === undefined || candPath === undefined) {
      throw new Error("AI_CF_GB_REPORT must be <baseline.json>,<challenger.json>");
    }
    const base = JSON.parse(readFileSync(basePath, "utf8")) as {
      runs: Record<string, { perDealA: number[]; perDealB: number[] }>;
    };
    const cand = JSON.parse(readFileSync(candPath, "utf8")) as {
      runs: Record<string, { perDealA: number[]; perDealB: number[] }>;
    };
    const baseRun = base.runs["master-default"];
    const candRun = cand.runs["master-default"];
    if (baseRun === undefined || candRun === undefined) {
      throw new Error("Both dumps must contain the master-default run.");
    }
    const deals = Math.min(baseRun.perDealA.length, candRun.perDealA.length);
    let armADifferences = 0;
    for (let index = 0; index < deals; index += 1) {
      if ((baseRun.perDealA[index] ?? 0) !== (candRun.perDealA[index] ?? 0)) {
        armADifferences += 1;
      }
    }
    report(`\npaired dumps over ${deals} deals; arm-A deals that differ: ${armADifferences}`);
    report(
      armADifferences === 0
        ? "landlord arm is exact — combined Δ = farmer Δ / 2 by construction"
        : "LANDLORD ARM DIFFERS — INVALID, do not read the farmer number as strength",
    );
    expect(deals).toBeGreaterThan(0);
  });
});
