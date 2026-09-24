/**
 * One shard of a batch-shaped collection, with a canonical per-group digest.
 *
 * This is the unit the scaling test is built from. Its whole job is to make
 * "the workers did the same thing" checkable: every group produces a digest over
 * the *scientific* content of its three episodes — the trajectory, the explored
 * decisions, the terminal reward and the training rows — and nothing else. Wall
 * clocks, process ids, shard offsets and file paths are deliberately outside the
 * digest, because those are the only things a different worker count is allowed
 * to change.
 *
 * The digest is per group, so merging shards in canonical order is exact and the
 * merged value is comparable to a single-worker run of the same deal ids.
 *
 * ```
 *   AI_SELFPLAY_COLLECT=1 AI_SELFPLAY_COLLECT_START=919001 \
 *   AI_SELFPLAY_COLLECT_GROUPS=200 AI_SELFPLAY_COLLECT_OUT=<dir> \
 *     vitest run --config vitest.benchmark.config.ts benchmarks/selfplay-collect-shard.test.ts
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
import { rowsOfEpisodes, statsOf, type DatasetRow } from "./selfplay-dataset.js";
import { SELFPLAY_FEATURE_COUNT } from "./selfplay-features.js";

const ENABLED = process.env.AI_SELFPLAY_COLLECT === "1";
const ROOT = fileURLToPath(new URL("../", import.meta.url));

const START = Number(process.env.AI_SELFPLAY_COLLECT_START ?? 919_001);
const GROUPS = Number(process.env.AI_SELFPLAY_COLLECT_GROUPS ?? 200);
const OUT_DIR = process.env.AI_SELFPLAY_COLLECT_OUT ?? join(ROOT, ".local", "selfplay-collect");

/** Exactly the batch-1 configuration the freeze draft names. */
export function batchOneConfig(): CollectorConfig {
  const bundles = new Map<string, PolicyBundle>([
    ["PI1", createPi1Bundle("master")],
    ["P0", createTierBundle("P0", "master")],
  ]);
  const mixture: MixtureSpec = Object.freeze({
    version: "fas-mixture-v1",
    current: "PI1",
    history: Object.freeze(["P0"]),
    weights: DEFAULT_MIXTURE_WEIGHTS,
  });
  return Object.freeze({
    bundles,
    learningBundleId: "PI1",
    mixture,
    epsilon: SELFPLAY_EPSILON,
    explorationSalt: 0x5eed_1001,
    mixtureSalt: 0x5eed_2002,
    auditProposal: true,
  });
}

function float32Bytes(values: readonly number[]): Buffer {
  const buffer = Buffer.allocUnsafe(values.length * 4);
  for (let index = 0; index < values.length; index += 1) {
    buffer.writeFloatLE(values[index] ?? 0, index * 4);
  }
  return buffer;
}

/**
 * The scientific content of one deal group, as a digest. Everything inside is a
 * pure function of the deal id, the scenario, the policies and the keyed RNG.
 */
export function groupDigest(episodes: readonly EpisodeResult[]): {
  readonly digest: string;
  readonly rowBytes: number;
  readonly rows: number;
} {
  const ordered = [...episodes].sort((left, right) =>
    left.scenario.localeCompare(right.scenario),
  );
  const parts: string[] = [];
  let rowBytes = 0;
  let rows = 0;

  for (const episode of ordered) {
    const trajectory = episode.trajectory
      .map((step) => `${step.ply}:${step.seat}:${step.actionIdentity}:${step.legalActionCount}`)
      .join(",");
    const decisions = episode.records
      .map((record) =>
        [
          record.seatDecisionIndex,
          record.legalActionCount,
          record.executedActionIdentity,
          record.greedyActionIdentity,
          record.explored ? 1 : 0,
          record.actionChanged ? 1 : 0,
          record.behaviorProbability.toFixed(12),
          record.terminalReward,
        ].join(":"),
      )
      .join(",");
    const featureBytes = float32Bytes(
      episode.records.flatMap((record) => [...record.features]),
    );
    rowBytes += featureBytes.length;
    rows += episode.records.length;
    parts.push(
      [
        episode.dealIndex,
        episode.scenario,
        episode.role,
        episode.learningSeat,
        episode.landlord,
        episode.winner,
        episode.learningTeamWon ? 1 : 0,
        trajectory,
        decisions,
        createHash("sha256").update(featureBytes).digest("hex"),
      ].join("|"),
    );
  }

  return {
    digest: createHash("sha256").update(parts.join("\n")).digest("hex"),
    rowBytes,
    rows,
  };
}

describe.skipIf(!ENABLED)("batch-shaped collection shard", () => {
  it("collects a window and writes a canonical per-group digest", () => {
    mkdirSync(OUT_DIR, { recursive: true });
    const config = batchOneConfig();
    const rssStart = process.memoryUsage().rss;
    const cpuStart = process.cpuUsage();
    const started = Date.now();

    const digests: { dealIndex: number; digest: string; rows: number; rowBytes: number }[] = [];
    const episodes: EpisodeResult[] = [];
    // Row bytes are actually written, not multiplied out: the production path
    // writes float32 blobs and the disk cost has to be measured the same way.
    let writtenBytes = 0;
    const rssSamples: number[] = [];

    for (let offset = 0; offset < GROUPS; offset += 1) {
      const dealIndex = START + offset;
      const group: EpisodeResult[] = [];
      for (const scenario of groupScenarios()) {
        group.push(collectEpisode(config, dealIndex, scenario));
      }
      episodes.push(...group);
      const digest = groupDigest(group);
      digests.push({ dealIndex, ...digest });

      const rows = rowsOfEpisodes(group);
      for (const split of ["train", "dev"] as const) {
        for (const role of ["landlord", "farmer-next", "farmer-previous"] as const) {
          const selected: DatasetRow[] = [...rows.train, ...rows.dev].filter(
            (row) => row.provenance.role === role && row.provenance.dealIndex === dealIndex,
          );
          if (selected.length === 0) {
            continue;
          }
          const bytes = float32Bytes(selected.flatMap((row) => [...row.features]));
          writeFileSync(join(OUT_DIR, `${dealIndex}.${split}.${role}.f32`), bytes);
          writtenBytes += bytes.length;
        }
      }
      if (offset % 25 === 0) {
        rssSamples.push(process.memoryUsage().rss);
      }
    }

    const collectMs = Date.now() - started;
    const cpu = process.cpuUsage(cpuStart);
    const allRows = [...rowsOfEpisodes(episodes).train, ...rowsOfEpisodes(episodes).dev];
    const stats = statsOf(allRows);

    const header = {
      start: START,
      groups: GROUPS,
      collectSeconds: collectMs / 1000,
      groupsPerMinute: (GROUPS / collectMs) * 60_000,
      games: episodes.length,
      gamesPerMinute: (episodes.length / collectMs) * 60_000,
      cpuSeconds: (cpu.user + cpu.system) / 1e6,
      cpuUtilisation: (cpu.user + cpu.system) / 1e6 / (collectMs / 1000),
      rssStartBytes: rssStart,
      rssEndBytes: process.memoryUsage().rss,
      rssMaxBytes: Math.max(rssStart, ...rssSamples, process.memoryUsage().rss),
      rows: stats.rows,
      rowsPerGroup: stats.rows / GROUPS,
      writtenBytes,
      bytesPerGroup: writtenBytes / GROUPS,
      featureCount: SELFPLAY_FEATURE_COUNT,
      digests,
      collectionDigest: createHash("sha256")
        .update(
          [...digests]
            .sort((left, right) => left.dealIndex - right.dealIndex)
            .map((entry) => `${entry.dealIndex}:${entry.digest}`)
            .join("\n"),
        )
        .digest("hex"),
    };
    writeFileSync(join(OUT_DIR, "shard.json"), JSON.stringify(header, null, 2));
    console.log(
      `[collect-shard] ${GROUPS} groups from ${START}: ${(collectMs / 1000).toFixed(1)} s, ` +
        `${header.groupsPerMinute.toFixed(2)} groups/min, cpu ${(100 * header.cpuUtilisation).toFixed(1)}%, ` +
        `rss ${(rssStart / 1e6).toFixed(0)}->${(header.rssEndBytes / 1e6).toFixed(0)} MB, ` +
        `rows ${stats.rows}, written ${(writtenBytes / 1e6).toFixed(1)} MB`,
    );
    expect(digests).toHaveLength(GROUPS);
  }, 3_600_000);
});
