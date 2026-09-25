/**
 * Descriptive diagnostics for the default-environment regression.
 *
 * This asks *where* the TARGET landlord's behaviour differs from the baseline's
 * when the farmers are the old `default` tier, and whether the difference
 * concentrates anywhere in particular. It is descriptive: nothing here selects a
 * feature, changes a config, or feeds a candidate decision.
 *
 * The state axes are the ones a reviewer can read off the observation without a
 * simulator oracle: game phase (by the landlord's own decision index), whether
 * the landlord was leading or responding, the size of the legal action set, and
 * the hand size when the decision was made. The behavioural axis is whether the
 * candidate picked a different action than the baseline would have.
 *
 * ```
 *   AI_SELFPLAY_DIAG=1 AI_SELFPLAY_DIAG_START=915001 AI_SELFPLAY_DIAG_GROUPS=40 \
 *   AI_SELFPLAY_DIAG_OUT=<dir> vitest run --config vitest.benchmark.config.ts \
 *     benchmarks/selfplay-landlord-diag.test.ts
 * ```
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseTreeModel } from "../src/core/ai/cf-model.js";
import { SEAT_ORDER } from "../src/core/game/index.js";
import { generateLegalActions } from "../src/core/rules/index.js";
import { cfActionCommand, cfCommandKey } from "../src/app/ai/cf-selector.js";
import {
  createPi1Bundle,
  createQModelPolicy,
  createTierPolicy,
  roleOfSeat,
  type ActionPolicy,
  type PolicyBundle,
} from "./selfplay-policy.js";
import { collectEpisode, type CollectorConfig } from "./selfplay-collector.js";
import { stageOf } from "./selfplay-diagnostics.js";

const ENABLED = process.env.AI_SELFPLAY_DIAG === "1";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUT = process.env.AI_SELFPLAY_DIAG_OUT ?? join(ROOT, ".local", "landlord-diag");
const START = Number(process.env.AI_SELFPLAY_DIAG_START ?? 915_001);
const GROUPS = Number(process.env.AI_SELFPLAY_DIAG_GROUPS ?? 1_200);
const TARGET_SHA = "7ad463175b54d632c1d3e7ad1b15af3cfd0c454b96b39f73f636254a964b98a9";

function loadTarget(): ActionPolicy {
  const bytes = readFileSync(join(ROOT, ".local/selfplay-reh/TARGET/train-input/landlord.model.json"));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== TARGET_SHA) {
    throw new Error(`TARGET landlord hashes to ${digest}, not the frozen ${TARGET_SHA}.`);
  }
  return createQModelPolicy(parseTreeModel(JSON.parse(bytes.toString("utf8"))), TARGET_SHA);
}

function bundle(id: string, landlord: ActionPolicy, next: ActionPolicy, previous: ActionPolicy): PolicyBundle {
  return Object.freeze({ bundleId: id, identity: id, roles: Object.freeze({ landlord, "farmer-next": next, "farmer-previous": previous }) });
}

function configFor(target: PolicyBundle, anchor: PolicyBundle): CollectorConfig {
  return Object.freeze({
    bundles: new Map<string, PolicyBundle>([[anchor.bundleId, anchor], [target.bundleId, target]]),
    learningBundleId: target.bundleId,
    mixture: Object.freeze({
      version: "fas-mixture-v1",
      current: target.bundleId,
      history: Object.freeze([anchor.bundleId]),
      weights: Object.freeze({ current: 1, sharedHistory: 0, independentHistory: 0 }),
    }),
    epsilon: 0,
    explorationSalt: 0,
    mixtureSalt: 0,
    auditProposal: false,
  });
}

interface DiagRecord {
  readonly dealIndex: number;
  readonly environment: "pi1" | "default";
  readonly baselineWon: boolean;
  readonly candidateWon: boolean;
  readonly landlordDecisions: number;
  readonly disagreements: number;
  readonly byStage: Record<string, { decisions: number; disagreements: number }>;
  readonly byLead: Record<string, { decisions: number; disagreements: number }>;
  readonly byLegal: Record<string, { decisions: number; disagreements: number }>;
  readonly byHand: Record<string, { decisions: number; disagreements: number }>;
}

function bucketLegal(count: number): string {
  return count <= 2 ? "1-2" : count <= 8 ? "3-8" : count <= 30 ? "9-30" : "31+";
}

function bucketHand(count: number): string {
  return count <= 5 ? "1-5" : count <= 10 ? "6-10" : count <= 15 ? "11-15" : "16+";
}

describe.skipIf(!ENABLED)("landlord descriptive diagnostics shard", () => {
  it("compares candidate and baseline landlord decisions state by state", () => {
    mkdirSync(OUT, { recursive: true });
    const target = loadTarget();
    const pi1 = createPi1Bundle("master");
    const baseline = createTierPolicy("master");
    const defaultFarmer = createTierPolicy("default");

    const envs = [
      {
        name: "pi1" as const,
        anchor: bundle("DG-pi1-anchor", baseline, pi1.roles["farmer-next"], pi1.roles["farmer-previous"]),
        cand: bundle("DG-pi1-cand", target, pi1.roles["farmer-next"], pi1.roles["farmer-previous"]),
      },
      {
        name: "default" as const,
        anchor: bundle("DG-def-anchor", baseline, defaultFarmer, defaultFarmer),
        cand: bundle("DG-def-cand", target, defaultFarmer, defaultFarmer),
      },
    ];

    const out: DiagRecord[] = [];
    for (const env of envs) {
      const baseConfig = configFor(env.anchor, pi1);

      // Walk the baseline game and, at every landlord decision, ask what the
      // candidate would have played — the counterfactual comparison the
      // regression is about, without running a second game for it.
      const candConfig = configFor(env.cand, env.anchor);
      for (let offset = 0; offset < GROUPS; offset += 1) {
        const dealIndex = START + offset;
        const baseEpisode = collectEpisode(baseConfig, dealIndex, "L");
        const candEpisode = collectEpisode(candConfig, dealIndex, "L");
        const byStage: DiagRecord["byStage"] = {};
        const byLead: DiagRecord["byLead"] = {};
        const byLegal: DiagRecord["byLegal"] = {};
        const byHand: DiagRecord["byHand"] = {};
        let decisions = 0;
        let disagreements = 0;

        for (const record of baseEpisode.records) {
          const view = record.view;
          if (roleOfSeat(view.seat, view.landlord) !== "landlord") {
            continue;
          }
          const legal = generateLegalActions({ hand: view.hand, currentPlay: view.currentPlay });
          const input = Object.freeze({
            context: Object.freeze({ kind: "play" as const, view, legalActions: legal }),
            seat: view.seat,
            role: "landlord" as const,
            dealSeed: dealIndex,
            gameSeed: 0,
            decisionIndex: record.seatDecisionIndex,
          });
          const baseKey = cfCommandKey(cfActionCommand(view.seat, baseline(input)));
          const candKey = cfCommandKey(cfActionCommand(view.seat, target(input)));
          const differs = baseKey !== candKey;
          decisions += 1;
          disagreements += differs ? 1 : 0;

          for (const [table, key] of [
            [byStage, stageOf(record.seatDecisionIndex)],
            [byLead, view.currentPlay === null ? "leading" : "responding"],
            [byLegal, bucketLegal(legal.length)],
            [byHand, bucketHand(view.hand.length)],
          ] as const) {
            const cell = table[key] ?? { decisions: 0, disagreements: 0 };
            cell.decisions += 1;
            cell.disagreements += differs ? 1 : 0;
            table[key] = cell;
          }
        }

        out.push({
          dealIndex,
          environment: env.name,
          baselineWon: baseEpisode.learningTeamWon,
          candidateWon: candEpisode.learningTeamWon,
          landlordDecisions: decisions,
          disagreements,
          byStage,
          byLead,
          byLegal,
          byHand,
        });
      }
    }

    writeFileSync(join(OUT, "diag.json"), JSON.stringify(out, null, 2));
    const digest = createHash("sha256").update(JSON.stringify(out)).digest("hex");
    const summary: Record<string, unknown> = { records: out.length, digest };
    for (const env of ["pi1", "default"] as const) {
      const rows = out.filter((r) => r.environment === env);
      const decisions = rows.reduce((s, r) => s + r.landlordDecisions, 0);
      const disag = rows.reduce((s, r) => s + r.disagreements, 0);
      summary[env] = { groups: rows.length, decisions, disagreements: disag, rate: disag / Math.max(1, decisions) };
      console.log(
        `[diag] ${env}: ${rows.length} groups, ${decisions} landlord decisions, ` +
          `${disag} disagreements (${((100 * disag) / Math.max(1, decisions)).toFixed(2)}%)`,
      );
      for (const axis of ["byStage", "byLead", "byLegal", "byHand"] as const) {
        const merged: Record<string, { decisions: number; disagreements: number }> = {};
        for (const row of rows) {
          for (const [key, cell] of Object.entries(row[axis])) {
            const slot = merged[key] ?? { decisions: 0, disagreements: 0 };
            slot.decisions += cell.decisions;
            slot.disagreements += cell.disagreements;
            merged[key] = slot;
          }
        }
        summary[`${env}.${axis}`] = merged;
        console.log(
          `        ${axis.padEnd(8)} ` +
            Object.entries(merged)
              .sort()
              .map(
                ([key, cell]) =>
                  `${key}: ${((100 * cell.disagreements) / Math.max(1, cell.decisions)).toFixed(1)}% of ${cell.decisions}`,
              )
              .join("  "),
        );
      }
    }
    writeFileSync(join(OUT, "diag-summary.json"), JSON.stringify(summary, null, 2));
    void SEAT_ORDER;
    expect(out.length).toBe(GROUPS * 2);
  }, 86_400_000);
});
