#!/usr/bin/env node
/**
 * Drives the Phase 2 Night Lab π1→π2 corpus (spec 064): generate every shard in
 * parallel, then merge, then audit. Mirrors `cf-corpus.mjs`, pointed at this
 * round's universe, policy and salts.
 *
 *   source scripts/activate-toolchain.sh
 *   AI_CF_PI_JOBS=16 AI_CF_PI_POLICY_COMMIT=<sha> node scripts/cf-pi-corpus.mjs generate
 *   node scripts/cf-pi-corpus.mjs merge
 *   node scripts/cf-pi-corpus.mjs audit
 *
 * Sharding only parallelises. A group's seed is its absolute deal index, so a
 * shard plays exactly the groups the unsharded run would have played and the
 * merged corpus does not depend on the shard count.
 *
 * **Resume.** A shard counts as done only when it parses, covers the window it
 * claims, and carries one group per requested deal. A half-written file from a
 * killed process fails that and is regenerated; every finished shard is kept.
 * The 08:30 CST hard stop (spec §14) can therefore cut the run at any moment
 * without losing completed work — but a stopped run is INCOMPLETE and is never
 * interpreted, so `status` says plainly how much of the universe is on disk.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VITEST = join(ROOT, "node_modules", ".bin", "vitest");
const CONFIG = "vitest.benchmark.config.ts";
const BENCH = "benchmarks/cf-pi-corpus.test.ts";

const SHARD_DIR = process.env.AI_CF_PI_SHARD_DIR ?? join(ROOT, ".local", "cf-pi-shards");
const CORPUS_DIR = process.env.AI_CF_PI_CORPUS_DIR ?? join(ROOT, ".local", "cf-pi-corpus");
const ROWS_DIR = process.env.AI_CF_PI_ROWS_DIR ?? join(ROOT, ".local", "cf-pi-rows");

// Spec 064 §8. Written out here so a typo in an env var cannot silently move
// the round onto another pool.
const UNIVERSE_START = 100_001;
const UNIVERSE_END = 120_000;
const UNIVERSE_SIZE = UNIVERSE_END - UNIVERSE_START + 1;

const mode = process.argv[2] ?? "status";
const jobs = positiveInt("AI_CF_PI_JOBS", 1);

function positiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, received "${raw}".`);
  }
  return parsed;
}

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(VITEST, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", (error) => {
      process.stderr.write(`vitest could not start: ${error.message}\n`);
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function shardWindows(total, count) {
  const windows = [];
  let start = 0;
  for (let index = 0; index < count; index += 1) {
    const end = Math.floor(((index + 1) * total) / count);
    if (end > start) windows.push({ start: start + UNIVERSE_START, count: end - start });
    start = end;
  }
  return windows;
}

function policyCommit() {
  const commit = process.env.AI_CF_PI_POLICY_COMMIT;
  if (commit === undefined || commit === "") {
    // Provenance is part of the corpus. "uncommitted" would make every shard
    // claim a pipeline that cannot be re-run.
    throw new Error("AI_CF_PI_POLICY_COMMIT must name the driver commit.");
  }
  return commit;
}

function shardPath(window) {
  return join(SHARD_DIR, `shard-${String(window.start).padStart(6, "0")}.json`);
}

function shardIsComplete(path, window) {
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed?.shard?.dealStart === window.start &&
      parsed?.shard?.deals === window.count &&
      Array.isArray(parsed?.groups) &&
      parsed.groups.length === window.count;
  } catch {
    return false;
  }
}

function status(windows) {
  const done = windows.filter((window) => shardIsComplete(shardPath(window), window));
  const deals = done.reduce((sum, window) => sum + window.count, 0);
  console.log(
    `${done.length}/${windows.length} shards complete — ${deals}/${UNIVERSE_SIZE} deals ` +
    `(${((deals / UNIVERSE_SIZE) * 100).toFixed(1)}%)`,
  );
  return done.length === windows.length ? 0 : 1;
}

async function generate() {
  mkdirSync(SHARD_DIR, { recursive: true });
  if (process.env.AI_CF_PI_FRESH === "1") {
    for (const name of readdirSync(SHARD_DIR).filter((entry) => entry.endsWith(".json"))) {
      rmSync(join(SHARD_DIR, name));
    }
  }
  const windows = shardWindows(UNIVERSE_SIZE, jobs);
  const pending = windows.filter((window) => !shardIsComplete(shardPath(window), window));
  const reused = windows.length - pending.length;
  console.log(
    `generating ${UNIVERSE_SIZE} groups across ${windows.length} shard(s)` +
    (reused > 0 ? ` — ${reused} already complete and kept` : ""),
  );
  if (pending.length === 0) {
    console.log("nothing to do");
    return 0;
  }
  const started = Date.now();
  const codes = await Promise.all(pending.map((window) => run(
    ["run", "--config", CONFIG, BENCH],
    {
      AI_CF_PI_GENERATE: shardPath(window),
      AI_CF_PI_DEAL_START: String(window.start),
      AI_CF_PI_DEALS: String(window.count),
      AI_CF_PI_POLICY_COMMIT: policyCommit(),
    },
  )));
  const failed = codes.filter((code) => code !== 0).length;
  const minutes = (Date.now() - started) / 1000 / 60;
  console.log(`shards done in ${minutes.toFixed(1)} min, ${failed} failed`);
  status(windows);
  return failed === 0 ? 0 : 1;
}

async function merge() {
  return run(["run", "--config", CONFIG, BENCH], {
    AI_CF_PI_MERGE: SHARD_DIR,
    AI_CF_PI_CORPUS_DIR: CORPUS_DIR,
    AI_CF_PI_POLICY_COMMIT: policyCommit(),
  });
}

async function audit() {
  return run(["run", "--config", CONFIG, BENCH], {
    AI_CF_PI_AUDIT: CORPUS_DIR,
    AI_CF_PI_CORPUS_DIR: CORPUS_DIR,
    AI_CF_PI_POLICY_COMMIT: policyCommit(),
  });
}

/**
 * Rows are exported by v1's own exporter (`cf-gate-a.test.ts`), pointed at this
 * round's corpus directory. That is deliberate rather than lazy: §7.18 claims a
 * π2 corpus is readable by the frozen v1 reader *without a change*, and the
 * cheapest way to keep that claim honest is to have no π2-specific reader at
 * all for it to quietly drift away from.
 */
async function rows() {
  return run(["run", "--config", CONFIG, "benchmarks/cf-gate-a.test.ts"], {
    AI_CF_DUMP_ROWS: ROWS_DIR,
    AI_CF_CORPUS_DIR: CORPUS_DIR,
  });
}

const modes = { generate, merge, audit, rows, status };
const handler = modes[mode];
if (handler === undefined) {
  console.error(`unknown mode "${mode}"; expected one of ${Object.keys(modes).join(", ")}`);
  process.exit(2);
}
if (mode === "status") {
  process.exit(status(shardWindows(UNIVERSE_SIZE, jobs)));
}
process.exit(await handler());
