#!/usr/bin/env node
/**
 * Runs one Spec 065 stage — both arms, in parallel, with §14 intact.
 *
 *   source scripts/activate-toolchain.sh
 *   AI_CF_T5_MODEL=.local/cf-top5-rows/model.json \
 *     node scripts/cf-top5-stage-run.mjs .local/cf-top5-stage1/result.json 200 160001
 *
 * Why this exists rather than just the runner's own combined mode: running both
 * arms sequentially in one process takes about twice as long, and measured on
 * the real machine that put Stage 2 — the round's only formal decision, which
 * cannot be half-run — uncomfortably close to the 08:30 hard stop.
 *
 * Parallelising normally means two processes each writing their own file, which
 * is precisely the violation Spec 064 died of: once the first arm finishes, a
 * complete one-armed result exists on disk. So the arms are run as children
 * that **write nothing at all** — they print their result to stdout, this
 * process holds both in memory, and only when both have exited does it write
 * the single combined document, atomically.
 *
 * There is therefore no moment at which any result exists on disk except the
 * complete one. `--serial` is kept for reproducing the sequential timing.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VITEST = join(ROOT, "node_modules", ".bin", "vitest");
const CONFIG = "vitest.benchmark.config.ts";
const BENCH = "benchmarks/cf-top5-stage1.test.ts";
const MARKER = "CF_TOP5_ARM_RESULT=";

const [outPath, dealsArg, startArg] = process.argv.slice(2);
if (outPath === undefined) {
  console.error(
    "usage: cf-top5-stage-run.mjs <out.json> [deals] [dealStart]\n" +
    "   or: cf-top5-stage-run.mjs <out.json> --serial [deals] [dealStart]",
  );
  process.exit(2);
}
const serial = process.argv.includes("--serial");
const positional = process.argv.slice(2).filter((entry) => !entry.startsWith("--"));
const deals = Number.parseInt(positional[1] ?? "200", 10);
const dealStart = Number.parseInt(positional[2] ?? "160001", 10);

function policyCommit() {
  const commit = process.env.AI_CF_T5_POLICY_COMMIT;
  if (commit === undefined || commit === "") {
    throw new Error("AI_CF_T5_POLICY_COMMIT must name the runner commit.");
  }
  return commit;
}

/** Runs one arm and resolves with its parsed result. The child writes no file. */
function runArm(arm) {
  return new Promise((resolve, reject) => {
    const child = spawn(VITEST, ["run", "--config", CONFIG, BENCH], {
      cwd: ROOT,
      env: {
        ...process.env,
        AI_CF_T5_POLICY_COMMIT: policyCommit(),
        AI_CF_T5_S1_ARM_STDOUT: arm,
        AI_BENCH_DEAL_START: String(dealStart),
        AI_BENCH_DEALS: String(deals),
        AI_BENCH_DESIGNED: "1",
        AI_BENCH_SEED: "0",
      },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let buffered = "";
    child.stdout.on("data", (chunk) => {
      buffered += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`arm ${arm} exited ${code}`));
        return;
      }
      const line = buffered.split("\n").find((entry) => entry.includes(MARKER));
      if (line === undefined) {
        reject(new Error(`arm ${arm} produced no result line`));
        return;
      }
      const payload = JSON.parse(line.slice(line.indexOf(MARKER) + MARKER.length));
      resolve({ arm, payload });
    });
  });
}

console.log(
  `stage ${dealStart}..${dealStart + deals - 1}  ${deals} deals  ` +
  `${serial ? "sequential" : "parallel"} arms  -> ${outPath}`,
);
const started = Date.now();

// Both children are started before either is awaited, so the arms overlap. On
// failure the already-collected numbers are discarded: nothing has been written
// and nothing will be.
let arms;
if (serial) {
  const baseline = await runArm("baseline");
  const challenger = await runArm("challenger");
  arms = [baseline, challenger];
} else {
  arms = await Promise.all([runArm("baseline"), runArm("challenger")]);
}

const byArm = Object.fromEntries(arms.map(({ arm, payload }) => [arm, payload]));
const minutes = (Date.now() - started) / 60000;

const combined = {
  label: "spec065-top5-combined",
  config: { deals, seedBase: 0, dealStart, designed: true },
  arms: {
    baseline: { perDealA: byArm.baseline.perDealA, perDealB: byArm.baseline.perDealB, cost: byArm.baseline.cost },
    challenger: { perDealA: byArm.challenger.perDealA, perDealB: byArm.challenger.perDealB, cost: byArm.challenger.cost },
  },
  completedAt: new Date().toISOString(),
};

// The one and only write, after both arms are in hand.
mkdirSync(dirname(outPath), { recursive: true });
const temporary = `${outPath}.partial`;
writeFileSync(temporary, `${JSON.stringify(combined, null, 2)}\n`, "utf8");
renameSync(temporary, outPath);

console.log(
  `both arms done in ${minutes.toFixed(1)} min; wrote ${outPath} once, atomically`,
);
if (existsSync(`${outPath}.partial`)) {
  console.error("a .partial file survived the rename — investigate before reading the result");
  process.exit(1);
}
