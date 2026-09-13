/**
 * Spec 053/023 measurement wrapper: runs pair tournaments and writes per-deal
 * results so two configurations can be compared with paired per-deal intervals.
 *
 * Research scaffolding. Delete with the rest of `benchmarks/diagnosis/`.
 *
 *   AI_ARM_LABEL=baseline AI_ARM_SEED=301 AI_ARM_DEALS=400 \
 *   AI_ARM_PAIRS=default:expert,casual:default \
 *   AI_ARM_OUT=docs/exec-plans/active/023-baseline.json pnpm harvest:ai -t 'arm run'
 */

import { writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  createRecorder,
  readConfig,
  runPairTournament,
  type Profile,
} from "../ai-tournament.js";

const LABEL = process.env.AI_ARM_LABEL ?? "unnamed";
const SEED = Number(process.env.AI_ARM_SEED ?? "301");
const DEALS = Number(process.env.AI_ARM_DEALS ?? "400");
const SECONDS = Number(process.env.AI_ARM_SECONDS ?? "180");
const OUT = process.env.AI_ARM_OUT;
/**
 * Spec 053 measured with 10: every tenth decision is re-run without a deadline,
 * which occupies wall clock and so shifts how often the shipped budget
 * truncates. It is part of the measurement configuration, not an accessory.
 */
const UNBOUNDED_EVERY = Number(process.env.AI_ARM_UNBOUNDED_EVERY ?? "10");
const PAIRS = (process.env.AI_ARM_PAIRS ?? "default:expert,casual:default")
  .split(",")
  .map((pair) => {
    const [stronger, weaker] = pair.split(":");
    return { stronger: stronger as Profile, weaker: weaker as Profile };
  });

describe("arm run", () => {
  it(`measures ${LABEL} over ${String(DEALS)} deals`, () => {
    const base = readConfig();
    const config = Object.freeze({
      ...base,
      deals: DEALS,
      seedBase: SEED,
      secondsCap: SECONDS,
      unboundedEvery: UNBOUNDED_EVERY,
    });
    const runs: Record<string, unknown> = {};

    for (const pair of PAIRS) {
      const recorder = createRecorder({ logCommands: true });
      const started = Date.now();
      const run = runPairTournament(config, pair.stronger, pair.weaker, recorder);
      const key = `${pair.stronger}-${pair.weaker}`;
      const pooled = run.perDealA.map((wins, index) => wins + (run.perDealB[index] ?? 0));
      const rate = pooled.reduce((total, wins) => total + wins, 0) / (pooled.length * 6);
      runs[key] = {
        stronger: pair.stronger,
        weaker: pair.weaker,
        requestedDeals: run.requestedDeals,
        playedDeals: run.playedDeals,
        stoppedEarly: run.stoppedEarly,
        elapsedMs: Date.now() - started,
        perDealA: run.perDealA,
        perDealB: run.perDealB,
        pooled,
        rate,
      };
      console.log(
        `[arm ${LABEL}] ${key}: ${(rate * 100).toFixed(3)}% over ${String(run.playedDeals)} deals, ${((Date.now() - started) / 1000).toFixed(0)}s`,
      );
    }

    const payload = {
      label: LABEL,
      date: "2026-09-12",
      config: { deals: DEALS, seedBase: SEED, secondsCap: SECONDS },
      runs,
    };
    if (OUT !== undefined) {
      writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      console.log(`[arm ${LABEL}] wrote ${OUT}`);
    }
    expect(Object.keys(runs).length).toBe(PAIRS.length);
  }, 1_800_000);
});
