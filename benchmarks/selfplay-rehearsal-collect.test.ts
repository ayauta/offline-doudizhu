/**
 * One shard of the dual-environment rehearsal collection.
 *
 * The two branches differ in exactly one thing: which policy bundles fill the
 * learning seat and the two opponent seats. Everything else — group ids, split,
 * scenario assignment, exploration salts, epsilon, feature schema, row
 * semantics — is shared, which is what makes "the environment moved the result"
 * a statement the design can actually support.
 *
 * A shard writes its rows in deal order, so concatenating shards in index order
 * yields the canonical order; the driver relies on that and checks it.
 *
 * ```
 *   AI_SELFPLAY_REH=1 AI_SELFPLAY_REH_BRANCH=CHEAP \
 *   AI_SELFPLAY_REH_START=907001 AI_SELFPLAY_REH_GROUPS=750 \
 *   AI_SELFPLAY_REH_OUT=... vitest run --config vitest.benchmark.config.ts \
 *     benchmarks/selfplay-rehearsal-collect.test.ts
 * ```
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_MIXTURE_WEIGHTS,
  createPi1Bundle,
  createTierBundle,
  type MixtureSpec,
  type PolicyBundle,
} from "./selfplay-policy.js";
import {
  SELFPLAY_EPSILON,
  collectEpisode,
  groupScenarios,
  type CollectorConfig,
  type EpisodeResult,
} from "./selfplay-collector.js";
import {
  SELFPLAY_DATASET_VERSION,
  rowsOfEpisodes,
  schemaHash,
  splitOfDealGroup,
  statsOf,
  type DatasetRow,
} from "./selfplay-dataset.js";
import { SELFPLAY_FEATURE_COUNT, SELFPLAY_FEATURE_NAMES } from "./selfplay-features.js";
import { COLLECTOR_VERSION } from "./selfplay-collector.js";
import { ACTION_IDENTITY_VERSION } from "./selfplay-actions.js";

const ENABLED = process.env.AI_SELFPLAY_REH === "1";
const ROOT = fileURLToPath(new URL("../", import.meta.url));

export type Branch = "CHEAP" | "TARGET";
export const BRANCHES: readonly Branch[] = Object.freeze(["CHEAP", "TARGET"]);

const START = Number(process.env.AI_SELFPLAY_REH_START ?? 907_001);
const GROUPS = Number(process.env.AI_SELFPLAY_REH_GROUPS ?? 750);
const BRANCH = (process.env.AI_SELFPLAY_REH_BRANCH ?? "CHEAP") as Branch;
const OUT_DIR = process.env.AI_SELFPLAY_REH_OUT ?? join(ROOT, ".local", "selfplay-reh", BRANCH);

/** The two frozen environment manifests, in code. */
export function branchConfig(branch: Branch): CollectorConfig {
  const bundles = new Map<string, PolicyBundle>();
  if (branch === "CHEAP") {
    bundles.set("REH-current", createTierBundle("REH-current", "casual"));
    bundles.set("REH-history", createTierBundle("REH-history", "default"));
  } else {
    bundles.set("PI1", createPi1Bundle("master"));
    bundles.set("P0", createTierBundle("P0", "master"));
  }
  const current = branch === "CHEAP" ? "REH-current" : "PI1";
  const history = branch === "CHEAP" ? "REH-history" : "P0";
  const mixture: MixtureSpec = Object.freeze({
    version: "fas-mixture-v1",
    current,
    history: Object.freeze([history]),
    weights: DEFAULT_MIXTURE_WEIGHTS,
  });
  return Object.freeze({
    bundles,
    learningBundleId: current,
    mixture,
    epsilon: SELFPLAY_EPSILON,
    explorationSalt: 0x5eed_1001,
    mixtureSalt: 0x5eed_2002,
    auditProposal: true,
  });
}

export function branchManifest(branch: Branch): Record<string, unknown> {
  const bundles =
    branch === "CHEAP"
      ? {
          "REH-current": { kind: "tier", tier: "casual", note: "scoring casual, analyzerNodes 24" },
          "REH-history": { kind: "tier", tier: "default", note: "shipped DEFAULT_AI_STRATEGY" },
        }
      : {
          PI1: { kind: "pi1-chain", championId: "ai-v1", tier: "master", note: "master + frozen cf overlay on farmer seats" },
          P0: { kind: "tier", tier: "master", note: "pre-pi1 production AI" },
        };
  return {
    branchId: branch,
    bundles,
    learningBundleId: branch === "CHEAP" ? "REH-current" : "PI1",
    mixture: {
      version: "fas-mixture-v1",
      current: branch === "CHEAP" ? "REH-current" : "PI1",
      history: [branch === "CHEAP" ? "REH-history" : "P0"],
      weights: { current: 0.5, sharedHistory: 0.25, independentHistory: 0.25 },
    },
    epsilon: SELFPLAY_EPSILON,
    explorationSalt: 0x5eed_1001,
    mixtureSalt: 0x5eed_2002,
    auditProposal: true,
  };
}

function float32Bytes(values: readonly number[]): Buffer {
  const buffer = Buffer.allocUnsafe(values.length * 4);
  for (let index = 0; index < values.length; index += 1) {
    buffer.writeFloatLE(values[index] ?? 0, index * 4);
  }
  return buffer;
}

/** Scientific content of one group: no wall clock, no path, no shard offset. */
export function groupDigest(episodes: readonly EpisodeResult[]): string {
  const parts = [...episodes]
    .sort((left, right) => left.scenario.localeCompare(right.scenario))
    .map((episode) =>
      [
        episode.dealIndex,
        episode.scenario,
        episode.role,
        episode.learningSeat,
        episode.landlord,
        episode.winner,
        episode.learningTeamWon ? 1 : 0,
        episode.trajectory.map((step) => `${step.ply}:${step.seat}:${step.actionIdentity}`).join(","),
        episode.records
          .map((record) =>
            [
              record.seatDecisionIndex,
              record.legalActionCount,
              record.executedActionIdentity,
              record.greedyActionIdentity,
              record.explored ? 1 : 0,
              record.behaviorProbability.toFixed(12),
              record.terminalReward,
            ].join(":"),
          )
          .join(","),
        createHash("sha256")
          .update(float32Bytes(episode.records.flatMap((record) => [...record.features])))
          .digest("hex"),
      ].join("|"),
    );
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

describe.skipIf(!ENABLED)("rehearsal collection shard", () => {
  it("collects one branch window and writes rows in deal order", () => {
    mkdirSync(OUT_DIR, { recursive: true });
    const config = branchConfig(BRANCH);
    const cpuStart = process.cpuUsage();
    const started = Date.now();

    const perSplitRole: Record<string, DatasetRow[]> = {};
    const digests: { dealIndex: number; digest: string }[] = [];
    const patternKinds: Record<string, number> = {};
    const attachmentKinds: Record<string, number> = {};
    let explored = 0;
    let decisions = 0;
    let outsideC3 = 0;
    let outsideC5 = 0;
    let withProposal = 0;
    let rssMax = process.memoryUsage().rss;

    for (let offset = 0; offset < GROUPS; offset += 1) {
      const dealIndex = START + offset;
      const group: EpisodeResult[] = groupScenarios().map((scenario) =>
        collectEpisode(config, dealIndex, scenario),
      );
      digests.push({ dealIndex, digest: groupDigest(group) });

      for (const episode of group) {
        for (const [kind, count] of Object.entries(episode.audit.patternKindCounts)) {
          patternKinds[kind] = (patternKinds[kind] ?? 0) + count;
        }
        for (const [kind, count] of Object.entries(episode.audit.attachmentKindCounts)) {
          attachmentKinds[kind] = (attachmentKinds[kind] ?? 0) + count;
        }
      }

      const rows = rowsOfEpisodes(group);
      for (const split of ["train", "dev"] as const) {
        for (const row of split === "train" ? rows.train : rows.dev) {
          const key = `${split}.${row.provenance.role}`;
          (perSplitRole[key] ??= []).push(row);
        }
      }
      if (offset % 25 === 0) {
        rssMax = Math.max(rssMax, process.memoryUsage().rss);
      }
    }

    let writtenBytes = 0;
    for (const [key, rows] of Object.entries(perSplitRole)) {
      const x = float32Bytes(rows.flatMap((row) => [...row.features]));
      const y = float32Bytes(rows.map((row) => row.reward));
      writeFileSync(join(OUT_DIR, `${key}.x.f32`), x);
      writeFileSync(join(OUT_DIR, `${key}.y.f32`), y);
      writtenBytes += x.length + y.length;
    }

    for (const row of Object.values(perSplitRole).flat()) {
      decisions += 1;
      if (row.provenance.explored) {
        explored += 1;
      }
      if (row.provenance.proposalAvailable) {
        withProposal += 1;
        if (!row.provenance.inOldC3) {
          outsideC3 += 1;
        }
        if (!row.provenance.inOldC5) {
          outsideC5 += 1;
        }
      }
    }

    const allRows = Object.values(perSplitRole).flat();
    const stats = statsOf(allRows);
    const collectMs = Date.now() - started;
    const cpu = process.cpuUsage(cpuStart);

    const manifest = {
      branchId: BRANCH,
      environment: branchManifest(BRANCH),
      datasetVersion: SELFPLAY_DATASET_VERSION,
      collectorVersion: COLLECTOR_VERSION,
      actionIdentityVersion: ACTION_IDENTITY_VERSION,
      schemaHash: schemaHash(),
      featureCount: SELFPLAY_FEATURE_COUNT,
      featureNames: SELFPLAY_FEATURE_NAMES,
      start: START,
      groups: GROUPS,
      label: "DEVELOPMENT_ONLY",
      rowCounts: Object.fromEntries(Object.entries(perSplitRole).map(([key, rows]) => [key, rows.length])),
      rows: stats.rows,
      positiveRate: stats.positiveRate,
      exploredRate: stats.exploredRate,
      patternKinds,
      attachmentKinds,
      outsideC3,
      outsideC5,
      withProposal,
      collectSeconds: collectMs / 1000,
      cpuSeconds: (cpu.user + cpu.system) / 1e6,
      rssMaxBytes: rssMax,
      writtenBytes,
      groupDigests: digests,
      shardDigest: createHash("sha256")
        .update(digests.map((entry) => `${entry.dealIndex}:${entry.digest}`).join("\n"))
        .digest("hex"),
    };
    writeFileSync(join(OUT_DIR, "shard.json"), JSON.stringify(manifest, null, 2));
    console.log(
      `[reh] ${BRANCH} ${START}+${GROUPS}: ${(collectMs / 1000).toFixed(1)} s, ` +
        `${(GROUPS / (collectMs / 1000)) * 60} groups/min, rows ${stats.rows}, ` +
        `explored ${(100 * stats.exploredRate).toFixed(2)}%, written ${(writtenBytes / 1e6).toFixed(1)} MB`,
    );
    expect(digests).toHaveLength(GROUPS);
    expect(rowsOfEpisodes([]).train).toHaveLength(0);
    void splitOfDealGroup;
  }, 86_400_000);
});
