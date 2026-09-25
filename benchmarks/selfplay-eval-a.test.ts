/**
 * Evaluation A — single-step greedy deployment diagnostic, three arms.
 *
 * On the already-exposed development root pool, three first actions are forced
 * from the **identical** simulator state and completed under one frozen π1
 * continuation with exploration off:
 *
 *     A = π1's own action        B = CHEAP argmax        C = TARGET argmax
 *
 * All three are measured inside one pass, so `TARGET − CHEAP` is a paired
 * difference over the same roots rather than a subtraction of two separately
 * reported estimates.
 *
 * This is a **single-step** diagnostic. It says what one deviating action is
 * worth under deployment play. It is **not** a full-policy takeover result and
 * it is **not** an unbiased estimate of the Q target the models were trained on.
 * The two must never be reported as one number.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseTreeModel, type TreeModel } from "../src/core/ai/cf-model.js";
import { generateLegalActions, type ValidatedPlayAction } from "../src/core/rules/index.js";
import type { PlayingPlayerView } from "../src/core/ai/index.js";
import {
  argmaxAction,
  createPi1Bundle,
  createTierBundle,
  roleOfSeat,
  scoreLegalActions,
  type MixtureSpec,
  type PolicyBundle,
  type SelfPlayRole,
} from "./selfplay-policy.js";
import {
  collectEpisode,
  type CollectorConfig,
  type ScenarioSpecName,
} from "./selfplay-collector.js";

const ENABLED = process.env.AI_SELFPLAY_EVAL_A === "1";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUT_DIR = process.env.AI_SELFPLAY_EVAL_A_OUT ?? join(ROOT, ".local", "selfplay-eval-a");

/** The already-exposed development root pool, frozen by the rehearsal protocol. */
const START = Number(process.env.AI_SELFPLAY_EVAL_A_START ?? 900_001);
const GROUPS = Number(process.env.AI_SELFPLAY_EVAL_A_GROUPS ?? 6_000);

const ROLES: readonly SelfPlayRole[] = ["landlord", "farmer-next", "farmer-previous"];
const SCENARIOS: readonly ScenarioSpecName[] = ["L", "F-next", "F-prev"];

const MODEL_DIR = join(ROOT, ".local", "selfplay-reh");

function report(line: string): void {
  console.log(line);
}

function loadModels(branch: string): Record<SelfPlayRole, TreeModel> {
  const models = {} as Record<SelfPlayRole, TreeModel>;
  for (const role of ROLES) {
    models[role] = parseTreeModel(
      JSON.parse(
        readFileSync(join(MODEL_DIR, branch, "train-input", `${role}.model.json`), "utf8"),
      ),
    );
  }
  return models;
}

function modelDigests(branch: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const role of ROLES) {
    out[role] = (
      JSON.parse(
        readFileSync(join(MODEL_DIR, branch, "train-input", `${role}.model.json`), "utf8"),
      ) as { modelSha256: string }
    ).modelSha256;
  }
  return out;
}

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

interface Root {
  readonly dealIndex: number;
  readonly scenario: ScenarioSpecName;
  readonly seatDecisionIndex: number;
  readonly legalActionCount: number;
  readonly parentIndex: number;
  readonly parentIdentity: string;
  readonly view: PlayingPlayerView;
  /**
   * The incumbent's own terminal outcome. Forcing π1 to play the action π1
   * already played reproduces the episode exactly — the collector's replay guard
   * asserts that identity — so arm A is read off the baseline rather than paid
   * for a second time. `consistencyChecks` below re-forces it on a subsample and
   * fails the run if the identity ever stops holding.
   */
  readonly parentWon: boolean;
}

function selectRoot(dealIndex: number, scenario: ScenarioSpecName, config: CollectorConfig): Root | null {
  const baseline = collectEpisode(config, dealIndex, scenario);
  const record = baseline.records.find((entry) => entry.legalActionCount >= 2);
  if (record === undefined) {
    return null;
  }
  return {
    dealIndex,
    scenario,
    seatDecisionIndex: record.seatDecisionIndex,
    legalActionCount: record.legalActionCount,
    parentIndex: record.greedyIndex,
    parentIdentity: record.greedyActionIdentity,
    view: record.view,
    parentWon: baseline.learningTeamWon,
  };
}

function forcedWon(
  config: CollectorConfig,
  root: Root,
  index: number,
): boolean {
  const episode = collectEpisode(config, root.dealIndex, root.scenario, {
    seatDecisionIndex: root.seatDecisionIndex,
    choose: (_view, legal) => Math.min(index, legal.length - 1),
    continuationBundleId: config.learningBundleId,
    explorationAfterFork: "off",
  });
  return episode.learningTeamWon;
}

describe.skipIf(!ENABLED)("evaluation A: single-step greedy deployment diagnostic", () => {
  it("compares π1, CHEAP and TARGET on identical roots", () => {
    mkdirSync(OUT_DIR, { recursive: true });
    const config = environment();
    const cheap = loadModels("CHEAP");
    const target = loadModels("TARGET");

    const started = Date.now();
    const rows: Record<string, unknown>[] = [];
    let excluded = 0;
    let consistencyChecks = 0;

    for (let offset = 0; offset < GROUPS; offset += 1) {
      const dealIndex = START + offset;
      const scenario = SCENARIOS[offset % SCENARIOS.length]!;
      const root = selectRoot(dealIndex, scenario, config);
      if (root === null) {
        excluded += 1;
        continue;
      }
      const legalActions: readonly ValidatedPlayAction[] = generateLegalActions({
        hand: root.view.hand,
        currentPlay: root.view.currentPlay,
      });
      if (legalActions.length !== root.legalActionCount) {
        throw new Error(`Root/replay mismatch at ${dealIndex}: ${legalActions.length} vs ${root.legalActionCount}`);
      }
      const role = roleOfSeat(root.view.seat, root.view.landlord);
      const cheapIndex = argmaxAction(scoreLegalActions(root.view, cheap[role], legalActions).scores);
      const targetIndex = argmaxAction(scoreLegalActions(root.view, target[role], legalActions).scores);

      const targetWon = forcedWon(config, root, targetIndex);
      const cheapWon = forcedWon(config, root, cheapIndex);
      const parentWon = root.parentWon;
      // Re-force arm A on a fixed subsample and require the identity to hold.
      if (offset % 50 === 0) {
        consistencyChecks += 1;
        if (forcedWon(config, root, root.parentIndex) !== parentWon) {
          throw new Error(
            `Forcing pi1's own action at ${dealIndex} did not reproduce the baseline; ` +
              "the arm-A shortcut is not valid for this run.",
          );
        }
      }

      rows.push({
        dealIndex,
        scenario,
        role,
        legalActionCount: root.legalActionCount,
        parentIndex: root.parentIndex,
        cheapIndex,
        targetIndex,
        parentWon,
        cheapWon,
        targetWon,
        cheapChanged: cheapIndex !== root.parentIndex,
        targetChanged: targetIndex !== root.parentIndex,
        cheapEqualsTarget: cheapIndex === targetIndex,
      });
    }

    const elapsed = Date.now() - started;
    const n = rows.length;
    const paired = (left: string, right: string): Record<string, number> => {
      const d = rows.map((row) => (row[right] ? 1 : 0) - (row[left] ? 1 : 0));
      const mean = d.reduce((sum, value) => sum + value, 0) / n;
      const variance = d.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, n - 1);
      const se = Math.sqrt(variance / n);
      return {
        mean,
        se,
        low: mean - 1.96 * se,
        high: mean + 1.96 * se,
        better: d.filter((value) => value > 0).length,
        worse: d.filter((value) => value < 0).length,
        ties: d.filter((value) => value === 0).length,
      };
    };

    const comparisons = {
      "TARGET - CHEAP": paired("cheapWon", "targetWon"),
      "TARGET - pi1": paired("parentWon", "targetWon"),
      "CHEAP - pi1": paired("parentWon", "cheapWon"),
    };

    const byRole = ROLES.map((role) => {
      const subset = rows.filter((row) => row.role === role);
      const m = (
        left: string,
        right: string,
      ): { mean: number; se: number; better: number; worse: number } => {
        const d = subset.map((row) => (row[right] ? 1 : 0) - (row[left] ? 1 : 0));
        const mean = d.reduce((sum, value) => sum + value, 0) / Math.max(1, subset.length);
        const variance =
          d.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, subset.length - 1);
        const se = Math.sqrt(variance / Math.max(1, subset.length));
        return { mean, se, better: d.filter((v) => v > 0).length, worse: d.filter((v) => v < 0).length };
      };
      return {
        role,
        groups: subset.length,
        pi1Win: subset.filter((row) => row.parentWon).length / Math.max(1, subset.length),
        cheapWin: subset.filter((row) => row.cheapWon).length / Math.max(1, subset.length),
        targetWin: subset.filter((row) => row.targetWon).length / Math.max(1, subset.length),
        targetMinusCheap: m("cheapWon", "targetWon"),
        targetMinusPi1: m("parentWon", "targetWon"),
        cheapMinusPi1: m("parentWon", "cheapWon"),
        cheapChanged: subset.filter((row) => row.cheapChanged).length,
        targetChanged: subset.filter((row) => row.targetChanged).length,
      };
    });

    const fmt = (label: string, value: Record<string, number>): string =>
      `${label}: Δ ${(100 * (value.mean ?? 0)).toFixed(3)}pp  SE ${(100 * (value.se ?? 0)).toFixed(3)}pp  ` +
      `95% CI [${(100 * (value.low ?? 0)).toFixed(3)}, ${(100 * (value.high ?? 0)).toFixed(3)}]pp  ` +
      `${value.better} better / ${value.worse} worse / ${value.ties} tie`;

    const lines = [
      `[eval-a] single-step greedy deployment diagnostic, ${n} groups (${excluded} excluded)`,
      `  wall ${(elapsed / 60000).toFixed(1)} min   mean legal ${(rows.reduce((s, r) => s + (r.legalActionCount as number), 0) / n).toFixed(2)}`,
      `  arm A read from the baseline (forced-run identity re-checked on ${consistencyChecks} groups: all held)`,
      `  win rates   pi1 ${(100 * rows.filter((r) => r.parentWon).length) / n}%  ` +
        `CHEAP ${(100 * rows.filter((r) => r.cheapWon).length) / n}%  TARGET ${(100 * rows.filter((r) => r.targetWon).length) / n}%`,
      `  ${fmt("TARGET - CHEAP", comparisons["TARGET - CHEAP"]!)}`,
      `  ${fmt("TARGET - pi1  ", comparisons["TARGET - pi1"]!)}`,
      `  ${fmt("CHEAP  - pi1  ", comparisons["CHEAP - pi1"]!)}`,
      `  deviation   CHEAP left pi1 at ${rows.filter((r) => r.cheapChanged).length}/${n}, TARGET at ${rows.filter((r) => r.targetChanged).length}/${n}`,
      `  agreement   CHEAP pick == TARGET pick at ${rows.filter((r) => r.cheapEqualsTarget).length}/${n}`,
      ...byRole.map(
        (entry) =>
          `  ${entry.role.padEnd(16)} ${entry.groups} groups  pi1 ${(100 * entry.pi1Win).toFixed(2)}%  ` +
          `CHEAP ${(100 * entry.cheapWin).toFixed(2)}%  TARGET ${(100 * entry.targetWin).toFixed(2)}%  ` +
          `T-C ${(100 * entry.targetMinusCheap.mean).toFixed(3)}±${(100 * 1.96 * entry.targetMinusCheap.se).toFixed(3)}pp  ` +
          `T-pi1 ${(100 * entry.targetMinusPi1.mean).toFixed(3)}±${(100 * 1.96 * entry.targetMinusPi1.se).toFixed(3)}pp  ` +
          `C-pi1 ${(100 * entry.cheapMinusPi1.mean).toFixed(3)}±${(100 * 1.96 * entry.cheapMinusPi1.se).toFixed(3)}pp`,
      ),
    ];
    report(lines.join("\n"));
    writeFileSync(join(OUT_DIR, "eval-a-report.txt"), `${lines.join("\n")}\n`);
    writeFileSync(
      join(OUT_DIR, "eval-a-summary.json"),
      JSON.stringify(
        {
          label: "DEVELOPMENT_ONLY",
          diagnostic: "single-step-greedy-deployment",
          pool: [START, START + GROUPS - 1],
          groups: n,
          excluded,
          modelDigests: { CHEAP: modelDigests("CHEAP"), TARGET: modelDigests("TARGET") },
          comparisons,
          byRole,
          rows,
          contentDigest: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
        },
        null,
        2,
      ),
    );
    expect(n).toBeGreaterThan(0);
  }, 86_400_000);
});
