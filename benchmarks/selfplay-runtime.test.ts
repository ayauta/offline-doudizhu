/**
 * The measured cost of one real collection window.
 *
 * This runs the configuration the freeze draft names for batch 1, end to end:
 * three scenarios per deal group, π1 as the learning bundle, the 50/25/25
 * opponent mixture against `P0`, exploration at ε = 0.10, the old proposal
 * computed for the C3/C5 coverage audit, per-decision rows built for every
 * learning decision, and the rows written out as the float32 blobs a training
 * run would read.
 *
 * It must run **alone**. Every timing here is wall-clock, and the previous
 * research line lost a night to a number that had been extrapolated from a
 * smaller, quieter run. `AI_BENCH_JOBS` sharding would make these numbers
 * meaningless, so this file never shards.
 *
 * ```
 *   AI_SELFPLAY_RUNTIME=1 AI_SELFPLAY_RUNTIME_GROUPS=250 \
 *     vitest run --config vitest.benchmark.config.ts benchmarks/selfplay-runtime.test.ts
 * ```
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

const ENABLED = process.env.AI_SELFPLAY_RUNTIME === "1";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUT_DIR = join(ROOT, ".local", "selfplay-runtime");

/** Retired mechanical-prototype range for the pilot; the dev pool for the real run. */
const START = Number(process.env.AI_SELFPLAY_RUNTIME_START ?? 900_001);
const GROUPS = Number(process.env.AI_SELFPLAY_RUNTIME_GROUPS ?? 250);

function report(line: string): void {
  console.log(line);
}

/**
 * Batch 1 as the freeze draft states it: π1 initialises the learner, `P0` is the
 * historical bundle it is measured against, and both opponents are drawn from
 * the frozen mixture.
 */
function batchOneConfig(): CollectorConfig {
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

function writeFloat32(path: string, values: readonly number[]): void {
  const buffer = Buffer.allocUnsafe(values.length * 4);
  for (let index = 0; index < values.length; index += 1) {
    buffer.writeFloatLE(values[index] ?? 0, index * 4);
  }
  writeFileSync(path, buffer);
}

describe.skipIf(!ENABLED)("real collection cost for one batch configuration", () => {
  it("measures wall time, throughput, memory, CPU and bytes per group", () => {
    rmSync(OUT_DIR, { recursive: true, force: true });
    mkdirSync(OUT_DIR, { recursive: true });
    const config = batchOneConfig();

    const rssStart = process.memoryUsage().rss;
    const cpuStart = process.cpuUsage();
    const started = Date.now();
    const episodes: EpisodeResult[] = [];

    for (let offset = 0; offset < GROUPS; offset += 1) {
      for (const scenario of groupScenarios()) {
        episodes.push(collectEpisode(config, START + offset, scenario));
      }
    }
    const collectMs = Date.now() - started;
    const cpu = process.cpuUsage(cpuStart);
    const rssPeak = process.memoryUsage().rss;

    const splits = rowsOfEpisodes(episodes);
    const allRows: DatasetRow[] = [...splits.train, ...splits.dev];
    const stats = statsOf(allRows);

    // The real path writes one float32 blob per split per role per batch. Here
    // the same writer runs over this window's rows so the byte count is
    // measured rather than multiplied out by hand.
    let rowBytes = 0;
    for (const split of ["train", "dev"] as const) {
      for (const role of ["landlord", "farmer-next", "farmer-previous"]) {
        const rows = allRows.filter(
          (row) => row.provenance.role === role && row.provenance.dealIndex % 2 === (split === "train" ? 0 : 1),
        );
        const path = join(OUT_DIR, `${split}.${role}.x.f32`);
        writeFloat32(path, rows.flatMap((row) => [...row.features]));
        writeFloat32(
          join(OUT_DIR, `${split}.${role}.y.f32`),
          rows.map((row) => row.reward),
        );
        rowBytes += rows.length * (SELFPLAY_FEATURE_COUNT * 4 + 4);
      }
    }

    const plies = episodes.reduce((sum, episode) => sum + episode.audit.plies, 0);
    const decisions = episodes.reduce((sum, episode) => sum + episode.audit.learningDecisions, 0);
    const patternKinds = new Map<string, number>();
    const attachmentKinds = new Map<string, number>();
    let outsideC3 = 0;
    let outsideC5 = 0;
    let withProposal = 0;
    for (const episode of episodes) {
      for (const [kind, count] of Object.entries(episode.audit.patternKindCounts)) {
        patternKinds.set(kind, (patternKinds.get(kind) ?? 0) + count);
      }
      for (const [kind, count] of Object.entries(episode.audit.attachmentKindCounts)) {
        attachmentKinds.set(kind, (attachmentKinds.get(kind) ?? 0) + count);
      }
    }
    for (const row of allRows) {
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

    const groupsPerMinute = (GROUPS / collectMs) * 60_000;
    const scenariosPerMinute = (episodes.length / collectMs) * 60_000;
    const minutesFor = (groupCount: number): number => (groupCount / groupsPerMinute) * 1;
    const cpuSeconds = (cpu.user + cpu.system) / 1e6;

    const lines = [
      `[runtime] batch-1 configuration, ${GROUPS} deal groups / ${episodes.length} games`,
      `  wall              ${(collectMs / 1000).toFixed(1)} s  (${(collectMs / GROUPS).toFixed(1)} ms/group)`,
      `  throughput        ${groupsPerMinute.toFixed(2)} groups/min   ${scenariosPerMinute.toFixed(2)} games/min`,
      `  cpu               ${cpuSeconds.toFixed(1)} s cpu over ${(collectMs / 1000).toFixed(1)} s wall ` +
        `= ${((100 * cpuSeconds) / (collectMs / 1000)).toFixed(1)}% of one core`,
      `  rss               start ${(rssStart / 1e6).toFixed(0)} MB  end ${(rssPeak / 1e6).toFixed(0)} MB`,
      `  plies/game        ${(plies / episodes.length).toFixed(2)}`,
      `  decisions/group   ${(decisions / GROUPS).toFixed(2)} learning decisions`,
      `  rows/group        ${(stats.rows / GROUPS).toFixed(2)}   rows/batch(7500) ${((stats.rows / GROUPS) * 7500).toFixed(0)}`,
      `  rows bytes        ${(rowBytes / 1e6).toFixed(1)} MB for this window ` +
        `= ${(rowBytes / GROUPS).toFixed(0)} B/group  ->  ${((rowBytes / GROUPS) * 7500 / 1e9).toFixed(3)} GB/batch`,
      `  positive rate     ${(100 * stats.positiveRate).toFixed(2)}%   explored ${(100 * stats.exploredRate).toFixed(2)}%`,
      `  C3/C5 outside     ${outsideC3}/${withProposal} executed outside C3, ${outsideC5}/${withProposal} outside C5`,
      `  action families   ${[...patternKinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k}:${c}`).join(" ")}`,
      `  attachment fams   ${[...attachmentKinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k}:${c}`).join(" ")}`,
      `  PROJECTION  7500-group batch ${minutesFor(7500).toFixed(0)} min = ${(minutesFor(7500) / 60).toFixed(2)} h`,
      `              3 batches       ${(minutesFor(7500) * 3 / 60).toFixed(1)} h`,
      `              600-group dev   ${minutesFor(600).toFixed(0)} min = ${(minutesFor(600) / 60).toFixed(2)} h`,
    ];

    report(lines.join("\n"));
    writeFileSync(join(OUT_DIR, "runtime-report.txt"), `${lines.join("\n")}\n`);
    writeFileSync(
      join(OUT_DIR, "runtime-summary.json"),
      JSON.stringify(
        {
          groups: GROUPS,
          games: episodes.length,
          collectSeconds: collectMs / 1000,
          msPerGroup: collectMs / GROUPS,
          groupsPerMinute,
          cpuSeconds,
          cpuUtilisation: cpuSeconds / (collectMs / 1000),
          rssStartBytes: rssStart,
          rssEndBytes: rssPeak,
          rowsPerGroup: stats.rows / GROUPS,
          rowBytesPerGroup: rowBytes / GROUPS,
          projections: {
            batch7500Minutes: minutesFor(7500),
            threeBatchesHours: (minutesFor(7500) * 3) / 60,
            dev600Minutes: minutesFor(600),
          },
          coverage: Object.fromEntries(patternKinds),
          attachments: Object.fromEntries(attachmentKinds),
        },
        null,
        2,
      ),
    );
    expect(stats.rows).toBeGreaterThan(0);
  }, 3_600_000);
});
