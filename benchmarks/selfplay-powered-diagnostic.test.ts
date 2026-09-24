/**
 * The powered development counterfactual diagnostic.
 *
 * One initial deal group, one decision root, paired arms, terminal outcome. The
 * statistical unit is the deal group — never the decision root — because two
 * roots inside one deal share a deck, a landlord and a continuation, so treating
 * them as independent samples would inflate N without adding information.
 *
 * ```
 *   A = π1's own action at the root            (the incumbent)
 *   B = the prototype model's argmax           (the challenger)
 *   C = a preregistered other legal action     (only on a fixed 1000-group subset)
 * ```
 *
 * Both arms start from the *identical* simulator state and are completed under
 * one frozen continuation with exploration off, so the only difference between
 * them is the single forced action. That makes this a **greedy deployment
 * counterfactual diagnostic**: it measures what one-step deviation buys under
 * deployment play. It is **not** an unbiased estimate of the Q target the model
 * was trained on, because the training target was collected under ε = 0.10
 * exploration and a different opponent mixture. The two are different
 * measurements and are never pooled.
 *
 * Root selection, fixed before the run and independent of anything the model
 * does: the learning seat's **first decision whose legal action set holds at
 * least two actions**. It reads no outcome, no score and no hidden hand, and it
 * is a deterministic function of the deal.
 *
 * ```
 *   AI_SELFPLAY_POWERED=1 AI_SELFPLAY_POWERED_GROUPS=6000 \
 *     vitest run --config vitest.benchmark.config.ts benchmarks/selfplay-powered-diagnostic.test.ts
 * ```
 */
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
  scoreLegalActions,
  type MixtureSpec,
  type PolicyBundle,
  type SelfPlayRole,
} from "./selfplay-policy.js";
import {
  collectEpisode,
  type CollectorConfig,
  type EpisodeResult,
  type ScenarioSpecName,
} from "./selfplay-collector.js";

const ENABLED = process.env.AI_SELFPLAY_POWERED === "1";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUT_DIR =
  process.env.AI_SELFPLAY_POWERED_OUT ?? join(ROOT, ".local", "selfplay-powered");
const MODELS_DIR = join(ROOT, ".local", "selfplay-rehearsal");

/** The development pool declared in research/full-action-selfplay-v1/development-pool.md. */
const DEV_START = Number(process.env.AI_SELFPLAY_POWERED_START ?? 900_001);
const DEV_GROUPS = Number(process.env.AI_SELFPLAY_POWERED_GROUPS ?? 6_000);
/** The fixed subset that also runs the third arm. Lowest indices, chosen up front. */
const C_ARM_GROUPS = Number(process.env.AI_SELFPLAY_POWERED_C ?? 1_000);
/** Kept here so a resumed run cannot silently change the root rule. */
const ROOT_RULE = "first-learning-decision-with-at-least-two-legal-actions-v1";

const ROLES: readonly SelfPlayRole[] = ["landlord", "farmer-next", "farmer-previous"];
const SCENARIOS: readonly ScenarioSpecName[] = ["L", "F-next", "F-prev"];

function report(line: string): void {
  console.log(line);
}

type PlayView = PlayingPlayerView;

/** A1/A2 every decision's legal-action context, built from the observation only. */
function contextOf(view: PlayView): readonly ValidatedPlayAction[] {
  return generateLegalActions({ hand: view.hand, currentPlay: view.currentPlay });
}

function loadPrototype(): Record<SelfPlayRole, TreeModel> {
  const models = {} as Record<SelfPlayRole, TreeModel>;
  for (const role of ROLES) {
    models[role] = parseTreeModel(
      JSON.parse(readFileSync(join(MODELS_DIR, `${role}.model.json`), "utf8")),
    );
  }
  return models;
}

/**
 * The environment: every seat plays π1, exploration is off. Nothing else is
 * cheap here on purpose — the incumbent's own action is only *the incumbent's
 * action* if the incumbent actually chose it.
 */
function environment(): CollectorConfig {
  const bundles = new Map<string, PolicyBundle>([
    ["PI1", createPi1Bundle("master")],
    // Registered so a mixture can name a frozen continuation without the
    // learning bundle having to be that continuation; unused in the main run.
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

interface RootSelection {
  readonly seatDecisionIndex: number;
  readonly legalActionCount: number;
  readonly parentIndex: number;
  readonly parentIdentity: string;
}

/** The preregistered root rule, applied to an unforced episode. */
function selectRoot(episode: EpisodeResult): RootSelection | null {
  for (const record of episode.records) {
    if (record.legalActionCount >= 2) {
      return {
        seatDecisionIndex: record.seatDecisionIndex,
        legalActionCount: record.legalActionCount,
        parentIndex: record.greedyIndex,
        parentIdentity: record.greedyActionIdentity,
      };
    }
  }
  return null;
}

/**
 * The third arm's rule, fixed before the run and blind to every outcome: the
 * action at the median index of the engine's canonical order, advanced until it
 * differs from both other arms. If the legal set is too small to hold three
 * distinct actions, the third arm is the parent and the root counts as a tie.
 */
function thirdArmIndex(
  legalActions: readonly ValidatedPlayAction[],
  parentIndex: number,
  modelIndex: number,
): number {
  const start = Math.floor(legalActions.length / 2);
  for (let offset = 0; offset < legalActions.length; offset += 1) {
    const index = (start + offset) % legalActions.length;
    if (index !== parentIndex && index !== modelIndex) {
      return index;
    }
  }
  return parentIndex;
}

interface ArmOutcome {
  readonly won: boolean;
}

function runArm(
  config: CollectorConfig,
  dealIndex: number,
  scenario: ScenarioSpecName,
  root: RootSelection,
  choose: (view: PlayView, legal: readonly ValidatedPlayAction[]) => number,
): ArmOutcome {
  // One pass per arm: the walk reaches the root itself, so no survey run and no
  // stored state are needed, and the forced action is chosen from the legal
  // observation inside the collector.
  const episode = collectEpisode(config, dealIndex, scenario, {
    seatDecisionIndex: root.seatDecisionIndex,
    choose,
    continuationBundleId: config.learningBundleId,
    explorationAfterFork: "off",
  });
  return { won: episode.learningTeamWon };
}

describe.skipIf(!ENABLED)("powered development counterfactual diagnostic", () => {
  it("measures paired terminal advantage over the incumbent, by deal group", () => {
    mkdirSync(OUT_DIR, { recursive: true });
    const config = environment();
    const models = loadPrototype();
    const modelDigests = Object.fromEntries(
      ROLES.map((role) => [
        role,
        (
          JSON.parse(readFileSync(join(MODELS_DIR, `${role}.model.json`), "utf8")) as {
            modelSha256: string;
          }
        ).modelSha256,
      ]),
    );

    const started = Date.now();
    const rows: {
      dealIndex: number;
      rootRule: string;
      role: SelfPlayRole;
      scenario: ScenarioSpecName;
      parentWon: boolean;
      modelWon: boolean;
      thirdWon: boolean | null;
      parentIndex: number;
      modelIndex: number;
      thirdIndex: number | null;
      legalActionCount: number;
      modelChangedAction: boolean;
      modelOutsideParentAndThird: boolean;
    }[] = [];
    let excluded = 0;

    for (let offset = 0; offset < DEV_GROUPS; offset += 1) {
      const dealIndex = DEV_START + offset;
      const scenario = SCENARIOS[offset % SCENARIOS.length]!;
      const withThird = offset < C_ARM_GROUPS;

      // Arm A is the unforced episode: π1 playing itself. There is no fork,
      // because the incumbent's action is what the incumbent already plays.
      const baseline = collectEpisode(config, dealIndex, scenario);
      const root = selectRoot(baseline);
      if (root === null) {
        excluded += 1;
        continue;
      }
      const view = baseline.records.find(
        (record) => record.seatDecisionIndex === root.seatDecisionIndex,
      )?.view;
      if (view === undefined) {
        excluded += 1;
        continue;
      }
      const legalActions = contextOf(view);
      if (legalActions.length !== root.legalActionCount) {
        throw new Error(
          `Root selection disagrees with the replay at deal ${dealIndex}: ` +
            `${legalActions.length} vs ${root.legalActionCount} legal actions.`,
        );
      }
      const role = baseline.role;
      const scores = scoreLegalActions(view, models[role], legalActions).scores;
      const modelIndex = argmaxAction(scores);
      const thirdIndex = withThird
        ? thirdArmIndex(legalActions, root.parentIndex, modelIndex)
        : null;

      const baselineRecord = baseline.records.find(
        (record) => record.seatDecisionIndex === root.seatDecisionIndex,
      );
      if (baselineRecord === undefined) {
        excluded += 1;
        continue;
      }

      const modelArm = runArm(
        config,
        dealIndex,
        scenario,
        root,
        (_v, legal) => Math.min(modelIndex, legal.length - 1),
      );
      const thirdArm =
        thirdIndex === null
          ? null
          : runArm(config, dealIndex, scenario, root, (_v, legal) =>
              Math.min(thirdIndex, legal.length - 1),
            );

      rows.push({
        dealIndex,
        rootRule: ROOT_RULE,
        role,
        scenario,
        parentWon: baseline.learningTeamWon,
        modelWon: modelArm.won,
        thirdWon: thirdArm === null ? null : thirdArm.won,
        parentIndex: root.parentIndex,
        modelIndex,
        thirdIndex,
        legalActionCount: root.legalActionCount,
        modelChangedAction: modelIndex !== root.parentIndex,
        modelOutsideParentAndThird:
          thirdIndex !== null && modelIndex !== root.parentIndex && modelIndex !== thirdIndex,
      });
    }

    const elapsed = Date.now() - started;
    const n = rows.length;
    const d = rows.map((row) => (row.modelWon ? 1 : 0) - (row.parentWon ? 1 : 0));
    const mean = d.reduce((sum, value) => sum + value, 0) / n;
    const variance = d.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, n - 1);
    const se = Math.sqrt(variance / n);
    const better = d.filter((value) => value > 0).length;
    const worse = d.filter((value) => value < 0).length;
    const ties = d.filter((value) => value === 0).length;

    const byRole = ROLES.map((role) => {
      const subset = rows.filter((row) => row.role === role);
      const deltas = subset.map((row) => (row.modelWon ? 1 : 0) - (row.parentWon ? 1 : 0));
      const m = deltas.reduce((sum, value) => sum + value, 0) / Math.max(1, subset.length);
      const v =
        deltas.reduce((sum, value) => sum + (value - m) ** 2, 0) /
        Math.max(1, subset.length - 1);
      return {
        role,
        groups: subset.length,
        parentRate: subset.filter((row) => row.parentWon).length / Math.max(1, subset.length),
        modelRate: subset.filter((row) => row.modelWon).length / Math.max(1, subset.length),
        delta: m,
        se: Math.sqrt(v / Math.max(1, subset.length)),
        changed: subset.filter((row) => row.modelChangedAction).length,
      };
    });

    const thirdRows = rows.filter((row) => row.thirdWon !== null);
    const thirdDelta = thirdRows.map(
      (row) => (row.thirdWon === true ? 1 : 0) - (row.parentWon ? 1 : 0),
    );
    const thirdMean =
      thirdDelta.reduce((sum, value) => sum + value, 0) / Math.max(1, thirdRows.length);
    const thirdVariance =
      thirdDelta.reduce((sum, value) => sum + (value - thirdMean) ** 2, 0) /
      Math.max(1, thirdRows.length - 1);
    const distinctThird = thirdRows.filter(
      (row) => row.thirdIndex !== row.parentIndex && row.thirdIndex !== row.modelIndex,
    ).length;

    const lines: string[] = [];
    lines.push(
      `[powered] greedy deployment counterfactual, π1 environment: ${n} deal groups (${excluded} excluded), ${DEV_GROUPS} attempted\n` +
        `  wall            ${(elapsed / 1000).toFixed(1)} s  (${(elapsed / Math.max(1, n)).toFixed(0)} ms/group)\n` +
        `  root rule       ${ROOT_RULE}\n` +
        `  roles           ${byRole.map((entry) => `${entry.role} ${entry.groups}`).join("  ")}\n` +
        `  mean legal      ${(rows.reduce((sum, row) => sum + row.legalActionCount, 0) / n).toFixed(2)}\n` +
        `  PRIMARY  A π1 ${(100 * rows.filter((row) => row.parentWon).length) / n}%  ` +
        `B model ${(100 * rows.filter((row) => row.modelWon).length) / n}%\n` +
        `  paired   Δ ${(100 * mean).toFixed(3)}pp  SE ${(100 * se).toFixed(3)}pp  ` +
        `95% CI [${(100 * (mean - 1.96 * se)).toFixed(3)}, ${(100 * (mean + 1.96 * se)).toFixed(3)}]pp\n` +
        `  discord  ${better} better / ${worse} worse / ${ties} tied ` +
        `(${(100 * (better + worse)) / n}% discordant)\n` +
        `  changed  model deviates from π1 at ${rows.filter((row) => row.modelChangedAction).length}/${n} roots\n` +
        `  C ARM    ${thirdRows.length} groups, ${distinctThird} with three distinct actions; ` +
        `Δ ${(100 * thirdMean).toFixed(3)}pp  SE ${(100 * Math.sqrt(thirdVariance / Math.max(1, thirdRows.length))).toFixed(3)}pp`,
    );
    for (const entry of byRole) {
      lines.push(
        `[powered] ${entry.role}: ${entry.groups} groups  π1 ${(100 * entry.parentRate).toFixed(2)}%  ` +
          `model ${(100 * entry.modelRate).toFixed(2)}%  Δ ${(100 * entry.delta).toFixed(3)}pp ` +
          `± ${(100 * 1.96 * entry.se).toFixed(3)}pp  changed ${entry.changed}`,
      );
    }

    report(lines.join("\n"));
    writeFileSync(join(OUT_DIR, "powered-report.txt"), `${lines.join("\n")}\n`);
    writeFileSync(
      join(OUT_DIR, "powered-summary.json"),
      JSON.stringify(
        {
          label: "DEVELOPMENT_ONLY",
          rootRule: ROOT_RULE,
          continuum: "greedy-deployment-counterfactual",
          devRange: [DEV_START, DEV_START + DEV_GROUPS - 1],
          groups: n,
          excluded,
          elapsedSeconds: elapsed / 1000,
          modelDigests,
          primary: { parentWins: rows.filter((r) => r.parentWon).length, modelWins: rows.filter((r) => r.modelWon).length, mean, se, better, worse, ties },
          byRole,
          thirdArm: { groups: thirdRows.length, distinct: distinctThird, mean: thirdMean },
          perGroup: rows,
        },
        null,
        2,
      ),
    );
    expect(n).toBeGreaterThan(0);
  }, 21_600_000);
});
