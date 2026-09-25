/**
 * Why a powered-diagnostic group was excluded.
 *
 * The diagnostic drops a group when the preregistered root rule finds no
 * decision to stand on. That is a legitimate outcome of the rule, but "87
 * excluded" is not an explanation, and a small exclusion rate is not a reason
 * to stop asking: the same code path would also swallow a crash, a timeout or a
 * malformed state. This audit re-runs exactly the excluded groups and names the
 * reason for each, so "the rule found nothing" and "something broke" cannot be
 * confused.
 *
 * It re-runs only the baseline arm, and only for the groups the merged summary
 * says were dropped — a few dozen games, not six thousand.
 *
 * ```
 *   AI_SELFPLAY_EXCLUSIONS=1 vitest run --config vitest.benchmark.config.ts \
 *     benchmarks/selfplay-exclusion-audit.test.ts
 * ```
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createPi1Bundle, createTierBundle, type MixtureSpec, type PolicyBundle } from "./selfplay-policy.js";
import {
  collectEpisode,
  type CollectorConfig,
  type ScenarioSpecName,
} from "./selfplay-collector.js";

const ENABLED = process.env.AI_SELFPLAY_EXCLUSIONS === "1";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const POWERED_DIR = join(ROOT, ".local", "selfplay-powered");
const OUT = join(POWERED_DIR, "exclusion-audit.json");

const DEV_START = 900_001;
const DEV_GROUPS = 6_000;
const SCENARIOS: readonly ScenarioSpecName[] = ["L", "F-next", "F-prev"];

/** The same environment the powered diagnostic ran in. */
function environment(): CollectorConfig {
  const bundles = new Map<string, PolicyBundle>([
    ["PI1", createPi1Bundle("master")],
    ["MASTER", createTierBundle("MASTER", "master")],
  ]);
  const mixture: MixtureSpec = Object.freeze({
    version: "fas-mixture-v1",
    current: "PI1",
    history: Object.freeze(["MASTER"]),
    weights: Object.freeze({ current: 1, sharedHistory: 0, independentHistory: 0 }),
  });
  return Object.freeze({
    bundles,
    learningBundleId: "PI1",
    mixture,
    epsilon: 0,
    explorationSalt: 0,
    mixtureSalt: 0,
    auditProposal: false,
  });
}

describe.skipIf(!ENABLED)("powered diagnostic exclusion audit", () => {
  it("names the reason for every excluded group", () => {
    const merged = JSON.parse(readFileSync(join(POWERED_DIR, "merged-summary.json"), "utf8")) as {
      perGroup: { dealIndex: number }[];
    };
    const kept = new Set(merged.perGroup.map((row) => row.dealIndex));
    const all = Array.from({ length: DEV_GROUPS }, (_, offset) => DEV_START + offset);
    const excluded = all.filter((dealIndex) => !kept.has(dealIndex));
    expect(kept.size + excluded.length).toBe(DEV_GROUPS);

    const config = environment();
    const reasons: Record<string, number> = {};
    const details: unknown[] = [];

    for (const dealIndex of excluded) {
      const scenario = SCENARIOS[(dealIndex - DEV_START) % SCENARIOS.length]!;
      const episode = collectEpisode(config, dealIndex, scenario);
      const decisions = episode.records.length;
      const counts = episode.records.map((record) => record.legalActionCount);
      const maxLegal = counts.length === 0 ? 0 : Math.max(...counts);

      const reason =
        decisions === 0
          ? "learning-seat-never-decided"
          : maxLegal < 2
            ? "every-decision-had-one-legal-action"
            : "unexplained";
      reasons[reason] = (reasons[reason] ?? 0) + 1;
      details.push({
        dealIndex,
        scenario,
        role: episode.role,
        learningSeat: episode.learningSeat,
        landlord: episode.landlord,
        plies: episode.audit.plies,
        learningDecisions: decisions,
        legalCounts: counts,
        winner: episode.winner,
        reason,
      });
    }

    const summary = {
      devRange: [DEV_START, DEV_START + DEV_GROUPS - 1],
      kept: kept.size,
      excluded: excluded.length,
      reasons,
      details,
    };
    writeFileSync(OUT, JSON.stringify(summary, null, 2));
    console.log(
      `[exclusions] ${excluded.length} excluded of ${DEV_GROUPS}: ` +
        Object.entries(reasons).map(([key, value]) => `${key}=${value}`).join(" "),
    );
    for (const entry of details.slice(0, 10)) {
      console.log(`  ${JSON.stringify(entry)}`);
    }
    expect(reasons.unexplained ?? 0).toBe(0);
  }, 1_800_000);
});
