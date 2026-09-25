#!/usr/bin/env node
/**
 * Runs the AI benchmark, optionally sharding it across processes.
 *
 * `AI_BENCH_JOBS=1` (the default) is a straight hand-off to the same vitest
 * command this script replaces — identical output, identical exit code.
 *
 * `AI_BENCH_JOBS=N` splits the deal range into N contiguous windows and runs
 * each in its own process, then joins the dumps by absolute deal index. This
 * is the only acceleration that provably does not touch AI behaviour: a deal's
 * seed is `AI_BENCH_SEED + <absolute deal index>`, so a shard plays exactly the
 * deals the unsharded run would have played, in the same order, from the same
 * starting state. Nothing inside a deal changes.
 *
 * That distinction matters because the shipped master path reads the clock: an
 * *internal* speed-up can let a previously truncated rollout finish and change
 * the move. Sharding cannot, because no deal's work changes.
 *
 *   source scripts/activate-toolchain.sh
 *   AI_BENCH_JOBS=8 AI_BENCH_DEALS=400 pnpm bench:ai
 *
 * Timing rules (see the E0 note in docs/research/ai-experiment-results.md):
 *   - Designed / no-deadline runs may use any shard count.
 *   - Shipped strength re-checks should stay at low concurrency.
 *   - Shipped *performance* numbers (p50/p95/max, cutoff rate, deadline
 *     behaviour, timeout/fallback) MUST be measured with AI_BENCH_JOBS=1.
 *     A machine under parallel load is not a phone, and its latencies are not
 *     product evidence.
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VITEST = join(ROOT, "node_modules", ".bin", "vitest");
const CONFIG = "vitest.benchmark.config.ts";
const BENCH_FILE = "benchmarks/ai-benchmark.test.ts";
const MERGE_FILE = "benchmarks/ai-merge.test.ts";
const SHARD_DIR = process.env.AI_BENCH_SHARD_DIR ?? join(ROOT, ".local", "bench-shards");

/** Extra CLI arguments are forwarded to vitest, as they were before. */
const forwarded = process.argv.slice(2);

function positiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, received "${raw}".`);
  }
  return parsed;
}

function run(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, ...options });
    // A failed spawn emits `error` and never `close`; without this the promise
    // would hang instead of reporting the failure.
    child.on("error", (error) => {
      process.stderr.write(`${command} could not start: ${error.message}\n`);
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** Contiguous, balanced windows; remainders fall on the later shards. */
function shardWindows(total, count) {
  const windows = [];
  let start = 0;
  for (let index = 0; index < count; index += 1) {
    const end = Math.floor(((index + 1) * total) / count);
    windows.push({ start, count: end - start });
    start = end;
  }
  return windows.filter((window) => window.count > 0);
}

/** Streams a child's output with a `[sN]` prefix and tees it to its own log. */
function pump(child, tag, logPath) {
  const chunks = [];
  const handle = (stream) => {
    let pending = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      chunks.push(chunk);
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() !== "") {
          process.stdout.write(`${tag} ${line}\n`);
        }
      }
    });
    stream.on("end", () => {
      if (pending.trim() !== "") {
        process.stdout.write(`${tag} ${pending}\n`);
      }
    });
  };
  handle(child.stdout);
  handle(child.stderr);
  child.on("close", () => {
    try {
      writeFileSync(logPath, chunks.join(""), "utf8");
    } catch {
      // A missing log must never fail the run; the dump is the real artifact.
    }
  });
}

const jobs = positiveInt("AI_BENCH_JOBS", 1);
const totalDeals = positiveInt("AI_BENCH_DEALS", 20);
const dealBase = positiveInt("AI_BENCH_DEAL_START", 0);
const label = process.env.AI_BENCH_LABEL ?? "bench";

if (jobs <= 1) {
  process.exitCode = await run(
    VITEST,
    ["run", "--config", CONFIG, "--reporter=verbose", ...forwarded],
    { stdio: "inherit" },
  );
} else {
  const windows = shardWindows(totalDeals, jobs);
  if (windows.length < jobs) {
    process.stdout.write(
      `AI_BENCH_JOBS=${jobs} but only ${totalDeals} deal(s): running ${windows.length} shard(s).\n`,
    );
  }
  rmSync(SHARD_DIR, { recursive: true, force: true });
  mkdirSync(SHARD_DIR, { recursive: true });

  process.stdout.write(
    `sharding ${totalDeals} deal(s) from index ${dealBase} into ${windows.length} process(es); ` +
    `dumps in ${SHARD_DIR}\n`,
  );

  const started = Date.now();
  const children = windows.map((window, index) => {
    const tag = `[s${index}]`;
    const out = join(SHARD_DIR, `shard-${String(index).padStart(3, "0")}.json`);
    const log = join(SHARD_DIR, `shard-${String(index).padStart(3, "0")}.log`);
    const child = spawn(
      VITEST,
      ["run", "--config", CONFIG, "--reporter=verbose", BENCH_FILE, "-t", "over mirrored deals", ...forwarded],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          AI_BENCH_DEAL_START: String(dealBase + window.start),
          AI_BENCH_DEALS: String(window.count),
          AI_BENCH_OUT: out,
          AI_BENCH_LABEL: `${label}-s${index}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    pump(child, tag, log);
    return new Promise((resolve) => {
      const finish = (code) => {
        process.stdout.write(
          `${tag} done: deals ${dealBase + window.start}..${dealBase + window.start + window.count - 1} ` +
          `exit=${code} in ${((Date.now() - started) / 1000).toFixed(0)}s\n`,
        );
        resolve(code);
      };
      child.on("error", (error) => {
        process.stderr.write(`${tag} could not start: ${error.message}\n`);
        finish(1);
      });
      child.on("close", (code) => finish(code ?? 1));
    });
  });

  const codes = await Promise.all(children);
  const failed = codes.filter((code) => code !== 0).length;
  if (failed > 0) {
    process.stdout.write(`${failed} shard(s) failed; not merging a partial run.\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `\nall shards finished in ${((Date.now() - started) / 1000).toFixed(0)}s; merging\n`,
    );
    // The merge is a single process, so its report goes straight to this
    // terminal — the aggregate the unsharded run would have printed.
    const mergeEnv = { ...process.env, AI_BENCH_MERGE: SHARD_DIR };
    delete mergeEnv.AI_BENCH_OUT;
    delete mergeEnv.AI_BENCH_DEAL_START;
    delete mergeEnv.AI_BENCH_DEALS;
    process.exitCode = await run(
      VITEST,
      ["run", "--config", CONFIG, "--reporter=verbose", MERGE_FILE, ...forwarded],
      { env: mergeEnv, stdio: "inherit" },
    );
  }
}
