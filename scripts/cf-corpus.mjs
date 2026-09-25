#!/usr/bin/env node
/**
 * Drives the Gate A v1 corpus: generate every shard in parallel, then merge.
 *
 *   source scripts/activate-toolchain.sh
 *   AI_CF_JOBS=16 node scripts/cf-corpus.mjs generate
 *   node scripts/cf-corpus.mjs merge
 *   node scripts/cf-corpus.mjs audit
 *
 * Sharding only parallelises. A group's seed is its absolute deal index, so a
 * shard plays exactly the groups the unsharded run would have played, from the
 * same starting state, and the merged corpus does not depend on the shard
 * count. `verify` below checks that by regenerating one window twice.
 *
 * The held-out split is generated like any other and written to a sealed file.
 * Nothing here prints an outcome for it.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VITEST = join(ROOT, "node_modules", ".bin", "vitest");
const CONFIG = "vitest.benchmark.config.ts";
const CORPUS_BENCH = "benchmarks/cf-corpus.test.ts";
const GATE_A_BENCH = "benchmarks/cf-gate-a.test.ts";
const BENCH = CORPUS_BENCH;

const SHARD_DIR = process.env.AI_CF_SHARD_DIR ?? join(ROOT, ".local", "cf-shards");
const CORPUS_DIR = process.env.AI_CF_CORPUS_DIR ?? join(ROOT, ".local", "cf-corpus");
const ROWS_DIR = process.env.AI_CF_ROWS_DIR ?? join(ROOT, ".local", "cf-rows");
const UNIVERSE_START = 50_001;
const UNIVERSE_END = 70_000;
const UNIVERSE_SIZE = UNIVERSE_END - UNIVERSE_START + 1;

const mode = process.argv[2] ?? "generate";
const jobs = Number.parseInt(process.env.AI_CF_JOBS ?? "1", 10);

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
  return process.env.AI_CF_POLICY_COMMIT ?? "uncommitted";
}

function shardPath(window) {
  return join(SHARD_DIR, `shard-${String(window.start).padStart(6, "0")}.json`);
}

/**
 * A shard file counts as done when it parses, covers the window it claims, and
 * carries one group per requested deal. A half-written file from a killed
 * process fails that and is regenerated.
 */
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

async function generate() {
  mkdirSync(SHARD_DIR, { recursive: true });
  if (process.env.AI_CF_FRESH === "1") {
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
      AI_CF_GENERATE: shardPath(window),
      AI_CF_DEAL_START: String(window.start),
      AI_CF_DEALS: String(window.count),
      AI_CF_JOBS: String(jobs),
      AI_CF_POLICY_COMMIT: policyCommit(),
    },
  )));
  const failed = codes.filter((code) => code !== 0).length;
  console.log(`shards done in ${((Date.now() - started) / 1000 / 60).toFixed(1)} min, ${failed} failed`);
  return failed === 0 ? 0 : 1;
}

async function verify() {
  // Two processes, two job counts, one window: the outputs must be identical
  // byte for byte. Comparing only the final winner would miss a divergence that
  // happened after the last shared decision.
  const window = { start: UNIVERSE_START, count: positiveInt("AI_CF_VERIFY_DEALS", 12) };
  const first = join(SHARD_DIR, "verify-a.json");
  const second = join(SHARD_DIR, "verify-b.json");
  const args = ["run", "--config", CONFIG, BENCH];
  const base = {
    AI_CF_DEAL_START: String(window.start),
    AI_CF_DEALS: String(window.count),
    AI_CF_POLICY_COMMIT: policyCommit(),
  };
  const codeA = await run(args, { ...base, AI_CF_GENERATE: first, AI_CF_JOBS: "1" });
  const codeB = await run(args, { ...base, AI_CF_GENERATE: second, AI_CF_JOBS: "16" });
  if (codeA !== 0 || codeB !== 0) return 1;
  const a = readFileSync(first);
  const b = readFileSync(second);
  if (a.equals(b)) {
    console.log(`verify: jobs=1 and jobs=16 outputs are byte-identical (${a.length} bytes)`);
    return 0;
  }
  console.log("verify: OUTPUTS DIFFER — the corpus is not shard-independent");
  return 1;
}

async function merge() {
  return run(["run", "--config", CONFIG, BENCH], {
    AI_CF_MERGE: SHARD_DIR,
    AI_CF_CORPUS_DIR: CORPUS_DIR,
    AI_CF_POLICY_COMMIT: policyCommit(),
  });
}

async function audit() {
  return run(["run", "--config", CONFIG, BENCH], {
    AI_CF_AUDIT: CORPUS_DIR,
    AI_CF_CORPUS_DIR: CORPUS_DIR,
  });
}

async function rows() {
  return run(["run", "--config", CONFIG, GATE_A_BENCH], {
    AI_CF_DUMP_ROWS: ROWS_DIR,
    AI_CF_CORPUS_DIR: CORPUS_DIR,
  });
}

async function calibrate() {
  return run(["run", "--config", CONFIG, GATE_A_BENCH], {
    AI_CF_CALIBRATE: ROWS_DIR,
    AI_CF_CORPUS_DIR: CORPUS_DIR,
  });
}

const modes = { generate, merge, audit, verify, rows, calibrate };
const handler = modes[mode];
if (handler === undefined) {
  console.error(`unknown mode "${mode}"; expected one of ${Object.keys(modes).join(", ")}`);
  process.exit(2);
}
process.exit(await handler());
