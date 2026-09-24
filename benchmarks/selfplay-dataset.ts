/**
 * Turning collected episodes into a dataset, and saying out loud what is in it.
 *
 * The two rules that matter here are both about what a row is *not*:
 *
 * 1. **A row's features never contain provenance.** Deal index, scenario, role,
 *    bundle identities, mixture arm and behaviour probability are recorded
 *    beside the row because a reviewer needs them and a model must not see
 *    them. The feature vector is built by `selfplay-features.ts` from the
 *    observation alone; everything in `Provenance` is written next to it and
 *    never into it.
 *
 * 2. **A batch trains only on its own rows.** The Monte-Carlo target is
 *    `E[G | h, a]` under *this* batch's continuation and opponent mixture, so
 *    pulling old terminal labels into a new fit would be training on a different
 *    question's answer. Old data stays for integrity tests, feature tests and
 *    diagnostics; it does not enter a new fit.
 */
import { createHash } from "node:crypto";

import type { PlayingPlayerView } from "../src/core/ai/ai.js";
import { SELFPLAY_FEATURE_NAMES, SELFPLAY_FEATURE_SCHEMA_VERSION } from "./selfplay-features.js";
import { COLLECTOR_VERSION, type EpisodeResult, type LearningRecord } from "./selfplay-collector.js";
import { ACTION_IDENTITY_VERSION } from "./selfplay-actions.js";

export const SELFPLAY_DATASET_VERSION = "fas-dataset-v1";

/** Where a group's rows go. Same group, same split, whatever scenario it is. */
export const SELFPLAY_SPLIT_SALT = "fas-split-v1";
export const SELFPLAY_DEV_PERCENT = 20;

function fnv1a(text: string): number {
  let hash = 0x811c_9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x0100_0193) >>> 0;
  }
  return hash >>> 0;
}

export type SelfPlaySplit = "train" | "dev";

/**
 * The split of an initial deal group. Keyed on the group rather than the
 * episode, which is what keeps a group's three role scenarios together: a
 * scenario is the same deal seen from a different seat, so splitting them apart
 * would put the same deck on both sides of the line.
 */
export function splitOfDealGroup(dealIndex: number): SelfPlaySplit {
  return fnv1a(`${SELFPLAY_SPLIT_SALT}:${dealIndex}`) % 100 < SELFPLAY_DEV_PERCENT
    ? "dev"
    : "train";
}

/** Everything a reviewer needs and a model must not have. */
export interface Provenance {
  readonly dealIndex: number;
  readonly dealSeed: number;
  readonly gameSeed: number;
  readonly episodeId: string;
  readonly scenario: string;
  readonly role: string;
  readonly learningSeat: string;
  readonly landlord: string;
  readonly seatDecisionIndex: number;
  readonly ply: number;
  readonly legalActionCount: number;
  readonly executedActionIdentity: string;
  readonly executedIndex: number;
  readonly greedyActionIdentity: string;
  readonly greedyIndex: number;
  readonly explored: boolean;
  readonly actionChanged: boolean;
  readonly behaviorProbability: number;
  readonly inOldC3: boolean;
  readonly inOldC5: boolean;
  readonly proposalAvailable: boolean;
  readonly learningBundleId: string;
  readonly opponents: readonly Readonly<{ seat: string; role: string; bundleId: string }>[];
  readonly mixtureArm: string;
  readonly mixtureVersion: string;
  readonly policyBundleIdentities: readonly string[];
}

export interface DatasetRow {
  readonly features: readonly number[];
  /** 1 when the learning seat's team won. The whole Monte-Carlo target. */
  readonly reward: number;
  readonly provenance: Provenance;
  /**
   * The observation the row was built from. Diagnostics need it to re-enumerate
   * and re-score the whole legal set; it is legal-observation-only, so carrying
   * it costs nothing in leakage terms.
   */
  readonly view: PlayingPlayerView;
}

function provenanceOf(record: LearningRecord): Provenance {
  return {
    dealIndex: record.dealIndex,
    dealSeed: record.dealSeed,
    gameSeed: record.gameSeed,
    episodeId: record.episodeId,
    scenario: record.scenario,
    role: record.role,
    learningSeat: record.learningSeat,
    landlord: record.landlord,
    seatDecisionIndex: record.seatDecisionIndex,
    ply: record.ply,
    legalActionCount: record.legalActionCount,
    executedActionIdentity: record.executedActionIdentity,
    executedIndex: record.executedIndex,
    greedyActionIdentity: record.greedyActionIdentity,
    greedyIndex: record.greedyIndex,
    explored: record.explored,
    actionChanged: record.actionChanged,
    behaviorProbability: record.behaviorProbability,
    inOldC3: record.inOldC3,
    inOldC5: record.inOldC5,
    proposalAvailable: record.proposalAvailable,
    learningBundleId: record.learningBundleId,
    opponents: record.opponents,
    mixtureArm: record.mixtureArm,
    mixtureVersion: record.mixtureVersion,
    policyBundleIdentities: record.policyBundleIdentities,
  };
}

export interface SplitRows {
  readonly train: readonly DatasetRow[];
  readonly dev: readonly DatasetRow[];
}

/**
 * Flattens episodes into rows, splitting by deal group. Losses, ties and
 * badly-explored episodes are all kept: they are the data, not noise to be
 * trimmed, and dropping them would bias the target towards wins.
 */
export function rowsOfEpisodes(episodes: readonly EpisodeResult[]): SplitRows {
  const train: DatasetRow[] = [];
  const dev: DatasetRow[] = [];
  for (const episode of episodes) {
    const split = splitOfDealGroup(episode.dealIndex);
    for (const record of episode.records) {
      const row: DatasetRow = Object.freeze({
        features: record.features,
        reward: record.terminalReward,
        provenance: Object.freeze(provenanceOf(record)),
        view: record.view,
      });
      (split === "train" ? train : dev).push(row);
    }
  }
  return { train: Object.freeze(train), dev: Object.freeze(dev) };
}

export interface RowStats {
  readonly rows: number;
  readonly positiveRate: number;
  readonly exploredRate: number;
  readonly meanLegalActions: number;
  readonly groups: number;
  readonly byRole: Readonly<Record<string, number>>;
  readonly meanRewardByRole: Readonly<Record<string, number>>;
}

export function statsOf(rows: readonly DatasetRow[]): RowStats {
  let positive = 0;
  let explored = 0;
  let legalTotal = 0;
  const groups = new Set<number>();
  const byRole: Record<string, number> = {};
  const rewardByRole: Record<string, number> = {};

  for (const row of rows) {
    positive += row.reward;
    explored += row.provenance.explored ? 1 : 0;
    legalTotal += row.provenance.legalActionCount;
    groups.add(row.provenance.dealIndex);
    byRole[row.provenance.role] = (byRole[row.provenance.role] ?? 0) + 1;
    rewardByRole[row.provenance.role] = (rewardByRole[row.provenance.role] ?? 0) + row.reward;
  }

  return {
    rows: rows.length,
    positiveRate: rows.length === 0 ? Number.NaN : positive / rows.length,
    exploredRate: rows.length === 0 ? Number.NaN : explored / rows.length,
    meanLegalActions: rows.length === 0 ? Number.NaN : legalTotal / rows.length,
    groups: groups.size,
    byRole,
    meanRewardByRole: Object.fromEntries(
      Object.entries(rewardByRole).map(([role, total]) => [role, total / (byRole[role] ?? 1)]),
    ),
  };
}

/** Rows for one role, in the order they were collected. One model per role. */
export function rowsForRole(
  rows: readonly DatasetRow[],
  role: string,
): readonly DatasetRow[] {
  return rows.filter((row) => row.provenance.role === role);
}

export function schemaHash(): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        datasetVersion: SELFPLAY_DATASET_VERSION,
        featureSchemaVersion: SELFPLAY_FEATURE_SCHEMA_VERSION,
        actionIdentityVersion: ACTION_IDENTITY_VERSION,
        collectorVersion: COLLECTOR_VERSION,
        names: SELFPLAY_FEATURE_NAMES,
      }),
    )
    .digest("hex");
}

/**
 * The training configuration, written out as literals with no search. These are
 * the frozen engineering starting point the research proposal names; they are
 * not claimed to be optimal, and nothing here tunes them.
 */
export const SELFPLAY_LGBM_PARAMS = Object.freeze({
  objective: "regression",
  metric: "l2",
  num_iterations: 512,
  max_depth: 8,
  num_leaves: 63,
  learning_rate: 0.05,
  min_data_in_leaf: 100,
  lambda_l1: 0.0,
  lambda_l2: 5.0,
  max_bin: 255,
  num_threads: 1,
  deterministic: true,
  force_col_wise: true,
  verbosity: -1,
});

export const SELFPLAY_LGBM_SEED = 20_260_924;

/** The JSON shape the TypeScript evaluator reads. Mirrors `TreeModel`. */
export interface SerializedModel {
  readonly formatVersion: number;
  readonly lightgbmVersion: string;
  readonly modelSha256: string;
  readonly numTrees: number;
  readonly numFeatures: number;
  readonly featureNames: readonly string[];
  readonly trees: readonly {
    readonly feature: readonly number[];
    readonly threshold: readonly number[];
    readonly defaultLeft: readonly number[];
    readonly missingZero: readonly number[];
    readonly left: readonly number[];
    readonly right: readonly number[];
    readonly value: readonly number[];
  }[];
}
