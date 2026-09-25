/**
 * Landlord independent validation — one shard.
 *
 * Four games per initial deal group, two pre-registered environments:
 *
 *   PRIMARY    A: landlord = baseline (master tier)      B: landlord = candidate
 *              both with both farmer seats on π1
 *   SECONDARY  A2: landlord = baseline                    B2: landlord = candidate
 *              both with both farmer seats on the old `default` tier
 *
 * The tested outcome is always **the landlord's team winning**. The candidate
 * controls every landlord decision; the two farmer seats never change between
 * the arms they are being compared within.
 *
 * Each completed group is checkpointed to its own file with an atomic rename, so
 * a resumed run re-reads finished groups instead of replaying them, and a group
 * is either wholly present or wholly absent.
 *
 * The console output is deliberately blind: progress, throughput and integrity
 * only. No wins, no deltas, no interval — see `landlord-validation-protocol.md`
 * §11. The reading happens once, after the seal.
 *
 * ```
 *   AI_SELFPLAY_LV=1 AI_SELFPLAY_LV_START=950001 AI_SELFPLAY_LV_GROUPS=300 \
 *   AI_SELFPLAY_LV_OUT=<dir> vitest run --config vitest.benchmark.config.ts \
 *     benchmarks/selfplay-landlord-validation.test.ts
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

const ENABLED = process.env.AI_SELFPLAY_LV === "1";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUT_DIR = process.env.AI_SELFPLAY_LV_OUT ?? join(ROOT, ".local", "landlord-validation", "run");
const CHECKPOINT_DIR = join(OUT_DIR, "checkpoints");

/** Frozen by the protocol: namespace landlord-independent-validation-v1. */
const START = Number(process.env.AI_SELFPLAY_LV_START ?? 950_001);
const GROUPS = Number(process.env.AI_SELFPLAY_LV_GROUPS ?? 2_400);
const CANDIDATE_SHA = "7ad463175b54d632c1d3e7ad1b15af3cfd0c454b96b39f73f636254a964b98a9";

export interface GroupRecord {
  readonly dealIndex: number;
  /** PRIMARY: landlord team won, baseline arm / candidate arm. */
  readonly primaryBaselineWon: boolean;
  readonly primaryCandidateWon: boolean;
  /** SECONDARY: same question, old/default farmers. */
  readonly secondaryBaselineWon: boolean;
  readonly secondaryCandidateWon: boolean;
  /** Operational counters, so a silent fallback would be visible. */
  readonly candidateDecisions: number;
  readonly baselineDecisions: number;
}

interface Arms {
  readonly primaryBaseline: CollectorConfig;
  readonly primaryCandidate: CollectorConfig;
  readonly secondaryBaseline: CollectorConfig;
  readonly secondaryCandidate: CollectorConfig;
}

/**
 * The frozen candidate, loaded alone and checked against its manifest digest
 * before it is allowed to play. A mismatch is a hard stop: the run must not
 * silently fall back to the incumbent.
 */
function buildArms(): Arms {
  const modelPath = join(ROOT, ".local/selfplay-reh/TARGET/train-input/landlord.model.json");
  const bytes = readFileSync(modelPath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== CANDIDATE_SHA) {
    throw new Error(
      `Candidate digest ${digest} does not match the frozen ${CANDIDATE_SHA}; refusing to run.`,
    );
  }
  const model = parseTreeModel(JSON.parse(bytes.toString("utf8")));
  if (model.numFeatures !== 403) {
    throw new Error(`Candidate declares ${model.numFeatures} features, not 403.`);
  }

  const pi1 = createPi1Bundle("master");
  const candidateLandlord: ActionPolicy = createQModelPolicy(model, CANDIDATE_SHA);
  const baselineLandlord: ActionPolicy = createTierPolicy("master");
  const defaultFarmer: ActionPolicy = createTierPolicy("default");

  function bundle(
    bundleId: string,
    landlord: ActionPolicy,
    farmerNext: ActionPolicy,
    farmerPrevious: ActionPolicy,
  ): PolicyBundle {
    return Object.freeze({
      bundleId,
      identity: bundleId,
      roles: Object.freeze({
        landlord,
        "farmer-next": farmerNext,
        "farmer-previous": farmerPrevious,
      }),
    });
  }

  function configFor(bundle: PolicyBundle, extra: readonly string[]): CollectorConfig {
    const bundles = new Map<string, PolicyBundle>();
    for (const id of extra) {
      bundles.set(id, pi1);
    }
    bundles.set("PI1", pi1);
    bundles.set(bundle.bundleId, bundle);
    return Object.freeze({
      bundles,
      learningBundleId: bundle.bundleId,
      mixture: Object.freeze({
        version: "fas-mixture-v1",
        current: bundle.bundleId,
        history: Object.freeze(["PI1"]),
        weights: Object.freeze({ current: 1, sharedHistory: 0, independentHistory: 0 }),
      }),
      epsilon: 0,
      explorationSalt: 0,
      mixtureSalt: 0,
      auditProposal: false,
    });
  }

  const primaryA = bundle("LV-A-primary", baselineLandlord, pi1.roles["farmer-next"], pi1.roles["farmer-previous"]);
  const primaryB = bundle("LV-B-primary", candidateLandlord, pi1.roles["farmer-next"], pi1.roles["farmer-previous"]);
  const secondaryA = bundle("LV-A2-secondary", baselineLandlord, defaultFarmer, defaultFarmer);
  const secondaryB = bundle("LV-B2-secondary", candidateLandlord, defaultFarmer, defaultFarmer);

  return Object.freeze({
    primaryBaseline: configFor(primaryA, []),
    primaryCandidate: configFor(primaryB, []),
    secondaryBaseline: configFor(secondaryA, []),
    secondaryCandidate: configFor(secondaryB, []),
  });
}

/** The landlord's team won. The learning seat is the landlord in scenario `L`. */
function landlordTeamWon(config: CollectorConfig, dealIndex: number): { won: boolean; decisions: number } {
  const episode = collectEpisode(config, dealIndex, "L");
  if (episode.role !== "landlord") {
    throw new Error(`Scenario L did not put the learning seat on the landlord at ${dealIndex}.`);
  }
  return { won: episode.learningTeamWon, decisions: episode.records.length };
}

function checkpointPath(dealIndex: number): string {
  return join(CHECKPOINT_DIR, `${dealIndex}.json`);
}

function writeCheckpoint(record: GroupRecord): void {
  const path = checkpointPath(record.dealIndex);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(record));
  renameSync(temporary, path);
}

describe.skipIf(!ENABLED)("landlord independent validation shard", () => {
  it("runs the pre-registered arms and checkpoints every completed group", () => {
    mkdirSync(CHECKPOINT_DIR, { recursive: true });
    const arms = buildArms();

    const started = Date.now();
    let completed = 0;
    let resumed = 0;

    for (let offset = 0; offset < GROUPS; offset += 1) {
      const dealIndex = START + offset;
      if (existsSync(checkpointPath(dealIndex))) {
        resumed += 1;
        continue;
      }
      const primaryBaseline = landlordTeamWon(arms.primaryBaseline, dealIndex);
      const primaryCandidate = landlordTeamWon(arms.primaryCandidate, dealIndex);
      const secondaryBaseline = landlordTeamWon(arms.secondaryBaseline, dealIndex);
      const secondaryCandidate = landlordTeamWon(arms.secondaryCandidate, dealIndex);

      writeCheckpoint({
        dealIndex,
        primaryBaselineWon: primaryBaseline.won,
        primaryCandidateWon: primaryCandidate.won,
        secondaryBaselineWon: secondaryBaseline.won,
        secondaryCandidateWon: secondaryCandidate.won,
        candidateDecisions: primaryCandidate.decisions,
        baselineDecisions: primaryBaseline.decisions,
      });
      completed += 1;

      // Blind progress only: no wins, no deltas, no intervals.
      if (completed % 25 === 0) {
        const elapsed = (Date.now() - started) / 1000;
        console.log(
          `[lv] progress ${completed}/${GROUPS - resumed} completed, ${resumed} resumed, ` +
            `${(completed / elapsed).toFixed(2)} groups/s, elapsed ${elapsed.toFixed(0)}s, ` +
            `eta ${(((GROUPS - resumed - completed) / Math.max(1e-9, completed / elapsed))).toFixed(0)}s`,
        );
      }
    }

    const shard = {
      start: START,
      groups: GROUPS,
      completed,
      resumed,
      seconds: (Date.now() - started) / 1000,
      candidateSha256: CANDIDATE_SHA,
    };
    writeFileSync(join(OUT_DIR, `shard-${START}.json`), JSON.stringify(shard, null, 2));
    console.log(`[lv] shard ${START}+${GROUPS}: ${completed} completed, ${resumed} resumed`);
    expect(completed + resumed).toBe(GROUPS);
  }, 86_400_000);
});
