/**
 * The 2x2 development matrix: two landlord candidates, two farmer environments.
 *
 * This is **development / candidate-selection** data on the already-exposed
 * 1200-group pool. It can compare candidates; it cannot confirm one. The fresh
 * `landlord-independent-validation-v1` pool is RETIRED and is never read here.
 *
 * ```
 *                       farmers = pi1/pi1        farmers = default/default
 *   TARGET landlord     cell T-A                  cell T-B
 *   CHEAP  landlord     cell C-A                  cell C-B
 * ```
 *
 * Each cell is a paired comparison against the same baseline — production
 * `master` at the landlord seat with the overlay not installed — on the same
 * initial deals, so every delta is a difference of two outcomes on one deal and
 * not a subtraction of two separately reported estimates.
 *
 * Six games per deal: one baseline and two candidates in each environment. The
 * baseline is shared between the two candidates, which is what makes
 * `CHEAP − TARGET` a paired contrast on the same deals.
 *
 * ```
 *   AI_SELFPLAY_MATRIX=1 AI_SELFPLAY_MATRIX_START=915001 AI_SELFPLAY_MATRIX_GROUPS=150 \
 *   AI_SELFPLAY_MATRIX_OUT=<dir> vitest run --config vitest.benchmark.config.ts \
 *     benchmarks/selfplay-landlord-matrix.test.ts
 * ```
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseTreeModel } from "../src/core/ai/cf-model.js";
import {
  createPi1Bundle,
  createQModelPolicy,
  createTierPolicy,
  type ActionPolicy,
  type PolicyBundle,
} from "./selfplay-policy.js";
import { collectEpisode, type CollectorConfig } from "./selfplay-collector.js";

const ENABLED = process.env.AI_SELFPLAY_MATRIX === "1";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUT_DIR = process.env.AI_SELFPLAY_MATRIX_OUT ?? join(ROOT, ".local", "landlord-matrix", "run");
const CHECKPOINTS = join(OUT_DIR, "checkpoints");

/** The exposed development pool. Development only; never a confirmatory pool. */
const START = Number(process.env.AI_SELFPLAY_MATRIX_START ?? 915_001);
const GROUPS = Number(process.env.AI_SELFPLAY_MATRIX_GROUPS ?? 1_200);

const TARGET_SHA = "7ad463175b54d632c1d3e7ad1b15af3cfd0c454b96b39f73f636254a964b98a9";
const CHEAP_SHA = "070f5b0b728176a8fb11d6a79e585b1315b847e053a23821830e17394faac26b";

export interface MatrixRecord {
  readonly dealIndex: number;
  readonly targetVsPi1Baseline: boolean;
  readonly targetVsPi1: boolean;
  readonly cheapVsPi1: boolean;
  readonly targetVsDefaultBaseline: boolean;
  readonly targetVsDefault: boolean;
  readonly cheapVsDefault: boolean;
}

function loadCandidate(path: string, expected: string): ActionPolicy {
  const bytes = readFileSync(path);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== expected) {
    throw new Error(`Candidate ${path} hashes to ${digest}, not the frozen ${expected}.`);
  }
  const model = parseTreeModel(JSON.parse(bytes.toString("utf8")));
  if (model.numFeatures !== 403) {
    throw new Error(`Candidate ${path} declares ${model.numFeatures} features, not 403.`);
  }
  return createQModelPolicy(model, expected);
}

function bundle(id: string, landlord: ActionPolicy, next: ActionPolicy, previous: ActionPolicy): PolicyBundle {
  return Object.freeze({
    bundleId: id,
    identity: id,
    roles: Object.freeze({ landlord, "farmer-next": next, "farmer-previous": previous }),
  });
}

function configFor(target: PolicyBundle, anchor: PolicyBundle): CollectorConfig {
  return Object.freeze({
    bundles: new Map<string, PolicyBundle>([
      [anchor.bundleId, anchor],
      [target.bundleId, target],
    ]),
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

/** The learning seat is the landlord in scenario `L`; we read its team's result. */
function landlordTeamWon(config: CollectorConfig, dealIndex: number): boolean {
  const episode = collectEpisode(config, dealIndex, "L");
  if (episode.role !== "landlord") {
    throw new Error(`Scenario L did not seat the learning seat as landlord at ${dealIndex}.`);
  }
  return episode.learningTeamWon;
}

describe.skipIf(!ENABLED)("landlord 2x2 development matrix shard", () => {
  it("runs six games per deal and checkpoints each completed deal", () => {
    mkdirSync(CHECKPOINTS, { recursive: true });
    const target = loadCandidate(
      join(ROOT, ".local/selfplay-reh/TARGET/train-input/landlord.model.json"),
      TARGET_SHA,
    );
    const cheap = loadCandidate(
      join(ROOT, ".local/selfplay-reh/CHEAP/train-input/landlord.model.json"),
      CHEAP_SHA,
    );
    const pi1 = createPi1Bundle("master");
    const baselineLandlord = createTierPolicy("master");
    const defaultFarmer = createTierPolicy("default");

    // Environment A: both farmer seats on pi1 (master + overlay).
    const pi1Anchor = bundle("MX-pi1-anchor", baselineLandlord, pi1.roles["farmer-next"], pi1.roles["farmer-previous"]);
    const targetA = bundle("MX-T-pi1", target, pi1.roles["farmer-next"], pi1.roles["farmer-previous"]);
    const cheapA = bundle("MX-C-pi1", cheap, pi1.roles["farmer-next"], pi1.roles["farmer-previous"]);
    // Environment B: both farmer seats on the old default tier.
    const defaultAnchor = bundle("MX-def-anchor", baselineLandlord, defaultFarmer, defaultFarmer);
    const targetB = bundle("MX-T-def", target, defaultFarmer, defaultFarmer);
    const cheapB = bundle("MX-C-def", cheap, defaultFarmer, defaultFarmer);

    const pi1Base = configFor(pi1Anchor, pi1);
    const pi1Target = configFor(targetA, pi1Anchor);
    const pi1Cheap = configFor(cheapA, pi1Anchor);
    const defBase = configFor(defaultAnchor, pi1);
    const defTarget = configFor(targetB, defaultAnchor);
    const defCheap = configFor(cheapB, defaultAnchor);

    const started = Date.now();
    let completed = 0;
    let resumed = 0;

    for (let offset = 0; offset < GROUPS; offset += 1) {
      const dealIndex = START + offset;
      const path = join(CHECKPOINTS, `${dealIndex}.json`);
      if (existsSync(path)) {
        resumed += 1;
        continue;
      }
      const record: MatrixRecord = {
        dealIndex,
        targetVsPi1Baseline: landlordTeamWon(pi1Base, dealIndex),
        targetVsPi1: landlordTeamWon(pi1Target, dealIndex),
        cheapVsPi1: landlordTeamWon(pi1Cheap, dealIndex),
        targetVsDefaultBaseline: landlordTeamWon(defBase, dealIndex),
        targetVsDefault: landlordTeamWon(defTarget, dealIndex),
        cheapVsDefault: landlordTeamWon(defCheap, dealIndex),
      };
      const temporary = `${path}.tmp`;
      writeFileSync(temporary, JSON.stringify(record));
      renameSync(temporary, path);
      completed += 1;
      if (completed % 25 === 0) {
        const elapsed = (Date.now() - started) / 1000;
        console.log(
          `[mx] progress ${completed}/${GROUPS - resumed} completed, ${resumed} resumed, ` +
            `${(completed / elapsed).toFixed(2)} groups/s, eta ${(((GROUPS - resumed - completed) / Math.max(1e-9, completed / elapsed))).toFixed(0)}s`,
        );
      }
    }
    console.log(`[mx] shard ${START}+${GROUPS}: ${completed} completed, ${resumed} resumed`);
    expect(completed + resumed).toBe(GROUPS);
  }, 86_400_000);
});
