/**
 * The feasibility rehearsal: collect → train → diagnose, end to end.
 *
 * Gated behind `AI_SELFPLAY_REHEARSAL` so it never runs as part of the ordinary
 * benchmark sweep. It uses retired prototype seeds (5001–5400), writes its
 * artifacts under `.local/selfplay-rehearsal/`, and is explicitly
 * **DEVELOPMENT ONLY**: nothing it produces may be read as evidence about
 * strength, and none of it may be used to decide a formal verdicT.
 *
 * What it is for is one question:
 *
 *   Does a full-action, three-role, non-neural Monte-Carlo value-learning loop
 *   produce a model whose scores depend on *which action* is being scored, or
 *   only on how good the position already was?
 *
 * The decisive measurements are the within-state/between-state dispersion ratio
 * and the three-arm counterfactual fork. Both are printed, together with every
 * cost, and both are allowed to come out badly.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseTreeModel, type TreeModel } from "../src/core/ai/cf-model.js";
import { generateLegalActions } from "../src/core/rules/index.js";
import {
  DEFAULT_MIXTURE_WEIGHTS,
  createQBundle,
  createTierBundle,
  argmaxAction,
  type MixtureSpec,
  type PolicyBundle,
  type SelfPlayRole,
} from "./selfplay-policy.js";
import {
  SELFPLAY_EPSILON,
  collectEpisode,
  groupScenarios,
  type CollectorConfig,
  type EpisodeResult,
  type ScenarioSpecName,
} from "./selfplay-collector.js";
import {
  SELFPLAY_FEATURE_COUNT,
  SELFPLAY_FEATURE_NAMES,
} from "./selfplay-features.js";
import {
  SELFPLAY_DATASET_VERSION,
  SELFPLAY_LGBM_PARAMS,
  SELFPLAY_LGBM_SEED,
  rowsForRole,
  rowsOfEpisodes,
  schemaHash,
  statsOf,
} from "./selfplay-dataset.js";
import {
  dispersionOf,
  policyChangeOf,
  regressionError,
  scoreAllActions,
} from "./selfplay-diagnostics.js";
import { actionIdentity } from "./selfplay-actions.js";

const ENABLED = process.env.AI_SELFPLAY_REHEARSAL === "1";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUT_DIR = join(ROOT, ".local", "selfplay-rehearsal");

/** Retired prototype seeds. Never a formal corpus. */
const REHEARSAL_START = 5001;
const REHEARSAL_GROUPS = Number(process.env.AI_SELFPLAY_GROUPS ?? 1200);
const CURATED_ROOTS = 300;

const ROLES: readonly SelfPlayRole[] = ["landlord", "farmer-next", "farmer-previous"];

function report(line: string): void {
  console.log(line);
}

function rehearsalBundles(): {
  registry: ReadonlyMap<string, PolicyBundle>;
  current: string;
  history: string;
} {
  const current = "REH-current";
  const history = "REH-history";
  return {
    registry: new Map<string, PolicyBundle>([
      [current, createTierBundle(current, "casual")],
      [history, createTierBundle(history, "default")],
    ]),
    current,
    history,
  };
}

function configFor(): CollectorConfig {
  const { registry, current, history } = rehearsalBundles();
  const mixture: MixtureSpec = Object.freeze({
    version: "fas-mixture-v1",
    current,
    history: Object.freeze([history]),
    weights: DEFAULT_MIXTURE_WEIGHTS,
  });
  return Object.freeze({
    bundles: registry,
    learningBundleId: current,
    mixture,
    epsilon: SELFPLAY_EPSILON,
    explorationSalt: 0x5eed_1001,
    mixtureSalt: 0x5eed_2002,
    auditProposal: true,
  });
}

function writeFloat32(path: string, values: readonly number[]): void {
  const buffer = Buffer.allocUnsafe(values.length * 4);
  for (let index = 0; index < values.length; index += 1) {
    buffer.writeFloatLE(values[index] ?? 0, index * 4);
  }
  writeFileSync(path, buffer);
}

describe.skipIf(!ENABLED)("full-action self-play feasibility rehearsal", () => {
  it("collects, trains and diagnoses", () => {
    mkdirSync(OUT_DIR, { recursive: true });
    const config = configFor();

    // ---- 1. Collect -------------------------------------------------------
    const collectedAt = Date.now();
    const episodes: EpisodeResult[] = [];
    for (
      let dealIndex = REHEARSAL_START;
      dealIndex < REHEARSAL_START + REHEARSAL_GROUPS;
      dealIndex += 1
    ) {
      for (const scenario of groupScenarios()) {
        episodes.push(collectEpisode(config, dealIndex, scenario));
      }
    }
    const collectMs = Date.now() - collectedAt;

    const splits = rowsOfEpisodes(episodes);
    const trainStats = statsOf(splits.train);
    const devStats = statsOf(splits.dev);
    report(
      `[rehearsal] collected ${REHEARSAL_GROUPS} groups / ${episodes.length} episodes in ` +
        `${(collectMs / 1000).toFixed(1)} s\n` +
        `  train rows ${trainStats.rows} over ${trainStats.groups} groups ` +
        `(positive ${(100 * trainStats.positiveRate).toFixed(1)}%, explored ` +
        `${(100 * trainStats.exploredRate).toFixed(1)}%, mean legal ${trainStats.meanLegalActions.toFixed(1)})\n` +
        `  dev rows   ${devStats.rows} over ${devStats.groups} groups ` +
        `(positive ${(100 * devStats.positiveRate).toFixed(1)}%)`,
    );

    // ---- 2. Write rows and fit -------------------------------------------
    const manifest = {
      datasetVersion: SELFPLAY_DATASET_VERSION,
      schemaHash: schemaHash(),
      featureCount: SELFPLAY_FEATURE_COUNT,
      featureNames: SELFPLAY_FEATURE_NAMES,
      seedRange: [REHEARSAL_START, REHEARSAL_START + REHEARSAL_GROUPS - 1],
      groups: REHEARSAL_GROUPS,
      label: "DEVELOPMENT_ONLY",
      params: SELFPLAY_LGBM_PARAMS,
      seed: SELFPLAY_LGBM_SEED,
      roleRows: Object.fromEntries(
        ROLES.map((role) => [role, rowsForRole(splits.train, role).length]),
      ),
    };
    writeFileSync(join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));

    for (const role of ROLES) {
      const rows = rowsForRole(splits.train, role);
      writeFloat32(join(OUT_DIR, `${role}.train.x.f32`), rows.flatMap((row) => [...row.features]));
      writeFloat32(join(OUT_DIR, `${role}.train.y.f32`), rows.map((row) => row.reward));
    }

    const trainedAt = Date.now();
    const python = spawnSync(
      "python3",
      [join(ROOT, "scripts", "selfplay-train.py"), OUT_DIR],
      {
        cwd: ROOT,
        env: { ...process.env, PYTHONPATH: join(ROOT, ".local", "pylibs") },
        encoding: "utf8",
      },
    );
    process.stdout.write(python.stdout ?? "");
    if (python.status !== 0) {
      process.stderr.write(python.stderr ?? "");
    }
    expect(python.status).toBe(0);
    const trainMs = Date.now() - trainedAt;

    // ---- 3. Load the three models ----------------------------------------
    const models = {} as Record<SelfPlayRole, { model: TreeModel; sha256: string }>;
    const stateOnly = {} as Record<SelfPlayRole, TreeModel>;
    for (const role of ROLES) {
      const raw = JSON.parse(readFileSync(join(OUT_DIR, `${role}.model.json`), "utf8")) as {
        modelSha256: string;
      };
      const model = parseTreeModel(raw);
      expect(model.numFeatures).toBe(SELFPLAY_FEATURE_COUNT);
      models[role] = { model, sha256: raw.modelSha256 };

      // The ablation: the same rows, the same parameters, with every column
      // that describes the candidate action removed. If the full model is no
      // better on held-out rows, the action columns are carrying nothing.
      stateOnly[role] = parseTreeModel(
        JSON.parse(readFileSync(join(OUT_DIR, `${role}.stateonly.model.json`), "utf8")),
      );
    }
    const bundle = createQBundle(models, "SP-B1-rehearsal");

    // ---- 4. Diagnostics ---------------------------------------------------
    const lines: string[] = [];
    lines.push(
      `[rehearsal] training: ${(trainMs / 1000).toFixed(1)} s for 3 models, ` +
        `${(ROLES.map((role) => JSON.stringify(models[role]).length).reduce((a, b) => a + b, 0) / 1e6).toFixed(1)} MB of JSON`,
    );

    for (const role of ROLES) {
      const model = models[role].model;
      const devRows = rowsForRole(splits.dev, role);
      const trainRows = rowsForRole(splits.train, role);
      const trainError = regressionError(model, trainRows);
      const devError = regressionError(model, devRows);
      const contexts = devRows.map((row) =>
        Object.freeze({
          kind: "play" as const,
          view: row.view,
          legalActions: generateLegalActions({
            hand: row.view.hand,
            currentPlay: row.view.currentPlay,
          }),
        }),
      );
      const dispersion = dispersionOf(model, contexts);
      const stateDispersion = dispersionOf(stateOnly[role], contexts);
      const stateError = regressionError(stateOnly[role], devRows);
      const change = policyChangeOf(model, devRows, { auditProposal: true });
      const changedByStage = Object.entries(change.byStage)
        .map(([stage, value]) => `${stage} ${value.changed}/${value.decisions}`)
        .join("  ");

      lines.push(
        `[rehearsal] ${role}:\n` +
          `  rows            train ${trainRows.length}  dev ${devRows.length}\n` +
          `  regression      train MSE ${trainError.mse.toFixed(5)}  dev MSE ${devError.mse.toFixed(5)}  ` +
          `(constant baseline ${devError.constantBaselineMse.toFixed(5)}, mean reward ${devError.mean.toFixed(3)})\n` +
          `  dispersion      within-state SD ${dispersion.withinStateSd.toFixed(5)}  ` +
          `between-state SD ${dispersion.betweenStateSd.toFixed(5)}  ratio ${dispersion.ratio.toFixed(3)}\n` +
          `  ablation        state-only dev MSE ${stateError.mse.toFixed(5)} ` +
          `(full ${devError.mse.toFixed(5)}); state-only dispersion ratio ` +
          `${stateDispersion.ratio.toFixed(3)}\n` +
          `  score range     mean spread ${dispersion.meanSpread.toFixed(4)} ` +
          `(top ${dispersion.meanTop.toFixed(4)}, bottom ${dispersion.meanBottom.toFixed(4)})\n` +
          `  action change   ${change.changedFromGreedy}/${change.decisions} ` +
          `(${((100 * change.changedFromGreedy) / Math.max(1, change.decisions)).toFixed(1)}%)  ` +
          `outside C3 ${change.chosenOutsideC3}/${change.withProposal}  ` +
          `outside C5 ${change.chosenOutsideC5}/${change.withProposal}\n` +
          `  by stage        ${changedByStage}`,
      );
    }

    // ---- 5. The three-arm counterfactual fork ----------------------------
    // The third arm is chosen by a preregistered, outcome-blind rule: the legal
    // action at the median index of the engine's canonical order. It is never
    // picked by looking at how it turns out.
    const candidates = splits.dev
      .filter((row) => row.provenance.legalActionCount >= 3)
      .sort(
        (left, right) =>
          left.provenance.dealIndex - right.provenance.dealIndex ||
          left.provenance.scenario.localeCompare(right.provenance.scenario) ||
          left.provenance.seatDecisionIndex - right.provenance.seatDecisionIndex,
      );
    const stride = Math.max(1, Math.floor(candidates.length / CURATED_ROOTS));
    const roots = candidates.filter((_, index) => index % stride === 0).slice(0, CURATED_ROOTS);

    let parentWins = 0;
    let modelWins = 0;
    let medianWins = 0;
    let modelBeatsParent = 0;
    let parentBeatsModel = 0;
    let modelBeatsMedian = 0;
    let medianBeatsModel = 0;
    let distinctArms = 0;
    let rootsWithSignal = 0;
    let agreement = 0;
    let comparable = 0;
    const forkStarted = Date.now();

    for (const row of roots) {
      const role = row.provenance.role as SelfPlayRole;
      const actions = generateLegalActions({
        hand: row.view.hand,
        currentPlay: row.view.currentPlay,
      });
      const scores = scoreAllActions(models[role].model, {
        kind: "play",
        view: row.view,
        legalActions: actions,
      }).scores;
      const parentIndex = actions.findIndex(
        (action) => actionIdentity(action) === row.provenance.greedyActionIdentity,
      );
      const modelIndex = argmaxAction(scores);
      const medianIndex = Math.floor(actions.length / 2);
      if (parentIndex < 0) {
        continue;
      }

      const identities = [parentIndex, modelIndex, medianIndex].map((index) =>
        actionIdentity(actions[index]!),
      );
      const isDistinct = new Set(identities).size;
      if (isDistinct === 3) {
        distinctArms += 1;
      }

      const outcomes = [parentIndex, modelIndex, medianIndex].map((actionIndex) =>
        collectEpisode(config, row.provenance.dealIndex, row.provenance.scenario as ScenarioSpecName, {
          seatDecisionIndex: row.provenance.seatDecisionIndex,
          choose: () => actionIndex,
          continuationBundleId: config.learningBundleId,
          explorationAfterFork: "off",
        }).learningTeamWon,
      );
      const [parentWon, modelWon, medianWon] = outcomes as [boolean, boolean, boolean];

      parentWins += parentWon ? 1 : 0;
      modelWins += modelWon ? 1 : 0;
      medianWins += medianWon ? 1 : 0;
      modelBeatsParent += modelWon && !parentWon ? 1 : 0;
      parentBeatsModel += parentWon && !modelWon ? 1 : 0;
      modelBeatsMedian += modelWon && !medianWon ? 1 : 0;
      medianBeatsModel += medianWon && !modelWon ? 1 : 0;
      if (isDistinct === 3) {
        rootsWithSignal += 1;
        // Pairwise agreement between the model's score order and the realized
        // outcome order, over the three arms. A model that ranks actions at
        // random scores 0.5 here; a model that knows nothing about actions
        // scores 0.5 too, because its scores are ties.
        const armIndex = [parentIndex, modelIndex, medianIndex];
        const armWon = [parentWon, modelWon, medianWon];
        let pairs = 0;
        let agree = 0;
        for (let left = 0; left < 3; left += 1) {
          for (let right = left + 1; right < 3; right += 1) {
            if (armWon[left] === armWon[right]) {
              continue;
            }
            pairs += 1;
            const scoreLeft = scores[armIndex[left]!]!;
            const scoreRight = scores[armIndex[right]!]!;
            const agrees =
              (armWon[left] === true && scoreLeft > scoreRight) ||
              (armWon[left] === false && scoreLeft < scoreRight);
            if (agrees) {
              agree += 1;
            }
          }
        }
        if (pairs > 0) {
          agreement += agree / pairs;
          comparable += 1;
        }
      }
      void rootsWithSignal;
    }

    const n = roots.length;
    lines.push(
      `[rehearsal] development counterfactual, ${n} roots x 3 arms ` +
        `(${((Date.now() - forkStarted) / 1000).toFixed(0)} s):\n` +
        `  win rate        parent policy ${(100 * parentWins / n).toFixed(1)}%  ` +
        `model argmax ${(100 * modelWins / n).toFixed(1)}%  ` +
        `median legal ${(100 * medianWins / n).toFixed(1)}%\n` +
        `  model vs parent ${modelBeatsParent} better / ${parentBeatsModel} worse\n` +
        `  model vs median ${modelBeatsMedian} better / ${medianBeatsModel} worse\n` +
        `  distinct arms   ${distinctArms}/${n} roots had three different actions\n` +
        `  rank agreement  ${comparable === 0 ? "n/a" : (agreement / comparable).toFixed(3)} ` +
        `over ${comparable} roots with a decided pair`,
    );

    report(lines.join("\n"));
    writeFileSync(
      join(OUT_DIR, "rehearsal-report.txt"),
      `${lines.join("\n")}\n`,
    );
    writeFileSync(
      join(OUT_DIR, "rehearsal-summary.json"),
      JSON.stringify(
        {
          label: "DEVELOPMENT_ONLY",
          groups: REHEARSAL_GROUPS,
          seedRange: [REHEARSAL_START, REHEARSAL_START + REHEARSAL_GROUPS - 1],
          collectSeconds: collectMs / 1000,
          trainSeconds: trainMs / 1000,
          trainStats,
          devStats,
          models: Object.fromEntries(ROLES.map((role) => [role, models[role].sha256])),
          bundleIdentity: bundle.identity,
          forks: {
            roots: n,
            distinctArms,
            parentWins,
            modelWins,
            medianWins,
            modelBeatsParent,
            parentBeatsModel,
          },
        },
        null,
        2,
      ),
    );
    expect(n).toBeGreaterThan(0);
  }, 3_600_000);
});
