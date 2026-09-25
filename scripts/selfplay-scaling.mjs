#!/usr/bin/env node
/**
 * Worker-count scaling test for a batch-shaped collection.
 *
 * Runs the *same* deal ids, role assignment, policy configuration and keyed RNG
 * identities at 1, 4 and 8 workers, then checks that the merged scientific
 * content is identical across all three. Worker count is a scheduling decision,
 * and the only thing it is allowed to change is wall time.
 *
 * The determinism guard is the point of the exercise, not a bonus: a shard
 * offset that leaked into a deal seed, a scenario assignment or an RNG key would
 * show up here as two collections that disagree about a game.
 *
 *   node scripts/selfplay-scaling.mjs
 *   AI_SELFPLAY_SCALING_GROUPS=200 AI_SELFPLAY_SCALING_WORKERS=1,4,8 node scripts/selfplay-scaling.mjs
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUT_ROOT = join(ROOT, ".local", "selfplay-scaling");
/** Already-exposed development reserve slice; no new scientific pool. */
const START = Number(process.env.AI_SELFPLAY_SCALING_START ?? 919_001);
const GROUPS = Number(process.env.AI_SELFPLAY_SCALING_GROUPS ?? 200);
const WORKERS = (process.env.AI_SELFPLAY_SCALING_WORKERS ?? "1,4,8")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);

function windows(total, jobs) {
  const out = [];
  const base = Math.floor(total / jobs);
  const extra = total % jobs;
  let offset = 0;
  for (let index = 0; index < jobs; index += 1) {
    const size = base + (index < extra ? 1 : 0);
    out.push({ offset, size });
    offset += size;
  }
  return out;
}

function runShard({ workerCount, index, window }) {
  const outDir = join(OUT_ROOT, `w${workerCount}`, `shard-${index}`);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const env = {
    ...process.env,
    AI_SELFPLAY_COLLECT: "1",
    AI_SELFPLAY_COLLECT_START: String(START + window.offset),
    AI_SELFPLAY_COLLECT_GROUPS: String(window.size),
    AI_SELFPLAY_COLLECT_OUT: outDir,
  };
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        join(ROOT, "node_modules", "vitest", "vitest.mjs"),
        "run",
        "--config",
        "vitest.benchmark.config.ts",
        "benchmarks/selfplay-collect-shard.test.ts",
      ],
      { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("close", (code) => {
      writeFileSync(join(outDir, "shard.log"), output);
      resolve({ workerCount, index, window, code, outDir });
    });
  });
}

async function measure(workerCount) {
  const started = Date.now();
  const shards = await Promise.all(
    windows(GROUPS, workerCount).map((window, index) => runShard({ workerCount, index, window })),
  );
  const wallMs = Date.now() - started;
  const failed = shards.filter((shard) => shard.code !== 0);
  if (failed.length > 0) {
    console.error(`[scaling] w${workerCount}: ${failed.length} shard(s) failed`);
    for (const shard of failed) {
      process.stderr.write(readFileSync(join(shard.outDir, "shard.log"), "utf8"));
    }
    process.exit(1);
  }
  const headers = shards.map((shard) =>
    JSON.parse(readFileSync(join(shard.outDir, "shard.json"), "utf8")),
  );
  const digests = [];
  for (const header of headers) {
    for (const entry of header.digests) {
      digests.push({ dealIndex: entry.dealIndex, digest: entry.digest });
    }
  }
  digests.sort((left, right) => left.dealIndex - right.dealIndex);
  const seen = new Set(digests.map((entry) => entry.dealIndex));
  if (seen.size !== digests.length) {
    console.error(`[scaling] w${workerCount}: overlapping shards`);
    process.exit(1);
  }
  return {
    workers: workerCount,
    wallSeconds: wallMs / 1000,
    groupsPerMinute: (GROUPS / wallMs) * 60_000,
    gamesPerMinute: (headers.reduce((sum, h) => sum + h.games, 0) / wallMs) * 60_000,
    // Sum of each worker's own CPU accounting is the honest utilisation figure
    // under parallelism; per-process wall-based percentages would understate it.
    cpuSeconds: headers.reduce((sum, h) => sum + h.cpuSeconds, 0),
    peakRssPerWorkerBytes: Math.max(...headers.map((h) => h.rssMaxBytes)),
    peakRssTotalBytes: headers.reduce((sum, h) => sum + h.rssMaxBytes, 0),
    rows: headers.reduce((sum, h) => sum + h.rows, 0),
    writtenBytes: headers.reduce((sum, h) => sum + h.writtenBytes, 0),
    groups: digests.length,
    collectionDigest: createHash("sha256")
      .update(digests.map((entry) => `${entry.dealIndex}:${entry.digest}`).join("\n"))
      .digest("hex"),
    digests,
  };
}

mkdirSync(OUT_ROOT, { recursive: true });
console.log(`[scaling] ${GROUPS} groups from ${START}, workers ${WORKERS.join("/")}`);
const results = [];
for (const workerCount of WORKERS) {
  const result = await measure(workerCount);
  results.push(result);
  console.log(
    `[scaling] w${workerCount}: ${result.wallSeconds.toFixed(1)} s  ` +
      `${result.groupsPerMinute.toFixed(2)} groups/min  ` +
      `cpu ${result.cpuSeconds.toFixed(1)} s  ` +
      `rss/worker ${(result.peakRssPerWorkerBytes / 1e6).toFixed(0)} MB  ` +
      `digest ${result.collectionDigest.slice(0, 16)}…`,
  );
}

const base = results[0];
const identical = results.every((result) => result.collectionDigest === base.collectionDigest);
const rowsIdentical = results.every((result) => result.rows === base.rows);

const lines = [
  `[scaling] ${GROUPS} deal groups from ${START}, batch-1 configuration`,
  `  determinism  merged collection digest identical across all worker counts: ${identical}`,
  `               training rows identical: ${rowsIdentical} (${base.rows})`,
  `  digest       ${base.collectionDigest}`,
  "",
  "  workers   wall_s   groups/min   games/min   cpu_s   eff%   rss/worker_MB   rss_total_MB   speedup   efficiency",
];
for (const result of results) {
  const speedup = base.wallSeconds / result.wallSeconds;
  lines.push(
    `  ${String(result.workers).padStart(7)}   ${result.wallSeconds.toFixed(1).padStart(6)}   ` +
      `${result.groupsPerMinute.toFixed(2).padStart(10)}   ${result.gamesPerMinute.toFixed(2).padStart(9)}   ` +
      `${result.cpuSeconds.toFixed(0).padStart(5)}   ${((100 * result.cpuSeconds) / result.wallSeconds).toFixed(0).padStart(4)}   ` +
      `${(result.peakRssPerWorkerBytes / 1e6).toFixed(0).padStart(13)}   ` +
      `${(result.peakRssTotalBytes / 1e6).toFixed(0).padStart(12)}   ` +
      `${speedup.toFixed(2).padStart(7)}   ${(speedup / result.workers).toFixed(3).padStart(10)}`,
  );
}

writeFileSync(join(OUT_ROOT, "scaling-report.txt"), `${lines.join("\n")}\n`);
writeFileSync(
  join(OUT_ROOT, "scaling-summary.json"),
  JSON.stringify(
    {
      start: START,
      groups: GROUPS,
      deterministic: identical && rowsIdentical,
      baseDigest: base.collectionDigest,
      results: results.map(({ digests, ...rest }) => rest),
    },
    null,
    2,
  ),
);
console.log(lines.join("\n"));
if (!identical || !rowsIdentical) {
  console.error("[scaling] worker count changed the scientific content; that is a bug.");
  process.exit(1);
}
console.log(`[scaling] wrote ${join(OUT_ROOT, "scaling-summary.json")}`);
