#!/usr/bin/env node
/**
 * Shard and merge the powered development counterfactual diagnostic.
 *
 * The diagnostic is one paired comparison per initial deal group, and the
 * deal group is the statistical unit, so a contiguous window of groups is a
 * complete and independent piece of the estimate. That makes sharding exact
 * rather than approximate: the merged number is the same number the unsharded
 * run would have produced, because it is a mean over the same per-deal deltas.
 *
 *   AI_SELFPLAY_JOBS=8 node scripts/selfplay-powered.mjs            # 6000 groups
 *   AI_SELFPLAY_POWERED_GROUPS=200 AI_SELFPLAY_JOBS=4 node scripts/selfplay-powered.mjs
 *
 * Wall-clock timings from a sharded run are NOT usable as cost measurements:
 * the shards share the CPU. The runtime numbers come from the isolated
 * single-process run in `benchmarks/selfplay-runtime.test.ts`.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUT_ROOT = join(ROOT, ".local", "selfplay-powered");
const DEV_START = Number(process.env.AI_SELFPLAY_POWERED_START ?? 900_001);
const TOTAL = Number(process.env.AI_SELFPLAY_POWERED_GROUPS ?? 6_000);
const TOTAL_C = Number(process.env.AI_SELFPLAY_POWERED_C ?? 1_000);
const JOBS = Math.max(1, Number(process.env.AI_SELFPLAY_JOBS ?? 8));

/** Contiguous, balanced windows that tile `[0, TOTAL)` exactly. */
function shardWindows(total, jobs) {
  const windows = [];
  const base = Math.floor(total / jobs);
  const extra = total % jobs;
  let start = 0;
  for (let index = 0; index < jobs; index += 1) {
    const size = base + (index < extra ? 1 : 0);
    windows.push({ offset: start, size });
    start += size;
  }
  return windows;
}

function runShard(window, index) {
  const outDir = join(OUT_ROOT, `shard-${index}`);
  // Clear the shard before writing: a stale summary from an earlier, smaller
  // run is indistinguishable from a fresh one by filename, and merging one
  // would silently mix two runs' deal groups.
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  // The third arm covers the first TOTAL_C groups overall; a shard takes the
  // part of that prefix which falls inside its own window.
  const cCount = Math.max(
    0,
    Math.min(window.offset + window.size, TOTAL_C) - window.offset,
  );
  const env = {
    ...process.env,
    AI_SELFPLAY_POWERED: "1",
    AI_SELFPLAY_POWERED_START: String(DEV_START + window.offset),
    AI_SELFPLAY_POWERED_GROUPS: String(window.size),
    AI_SELFPLAY_POWERED_C: String(cCount),
    AI_SELFPLAY_POWERED_OUT: outDir,
  };
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        join(ROOT, "node_modules", "vitest", "vitest.mjs"),
        "run",
        "--config",
        "vitest.benchmark.config.ts",
        "benchmarks/selfplay-powered-diagnostic.test.ts",
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
      resolve({ index, code, window, cCount, outDir });
    });
  });
}

const windows = shardWindows(TOTAL, JOBS);
console.log(
  `[selfplay-powered] ${TOTAL} groups in ${JOBS} shards from ${DEV_START}, ` +
    `third arm on the first ${TOTAL_C}`,
);

const started = Date.now();
const results = await Promise.all(windows.map((window, index) => runShard(window, index)));
const failed = results.filter((result) => result.code !== 0);
for (const result of results) {
  console.log(
    `  shard ${result.index}: offset ${result.window.offset} size ${result.window.size} ` +
      `(C arm ${result.cCount}) exit ${result.code}`,
  );
}
if (failed.length > 0) {
  console.error(`[selfplay-powered] ${failed.length} shard(s) failed; refusing to merge.`);
  process.exit(1);
}

// ---- merge -----------------------------------------------------------------
const perGroup = [];
const modelDigests = {};
let excluded = 0;
for (const result of results) {
  const expectedStart = DEV_START + result.window.offset;
  const summary = JSON.parse(
    readFileSync(join(result.outDir, "powered-summary.json"), "utf8"),
  );
  if (summary.devRange?.[0] !== expectedStart) {
    console.error(
      `[selfplay-powered] shard ${result.index} reports range ${summary.devRange?.[0]}, ` +
        `expected ${expectedStart}; refusing to merge a summary from another run.`,
    );
    process.exit(1);
  }
  perGroup.push(...summary.perGroup);
  Object.assign(modelDigests, summary.modelDigests);
  excluded += summary.excluded;
}

perGroup.sort((left, right) => left.dealIndex - right.dealIndex);
const seen = new Set(perGroup.map((row) => row.dealIndex));
if (seen.size !== perGroup.length) {
  console.error("[selfplay-powered] shards overlap: the same deal group appears twice.");
  process.exit(1);
}

const n = perGroup.length;
const deltas = perGroup.map((row) => (row.modelWon ? 1 : 0) - (row.parentWon ? 1 : 0));
const mean = deltas.reduce((sum, value) => sum + value, 0) / n;
const variance =
  deltas.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, n - 1);
const se = Math.sqrt(variance / n);
const better = deltas.filter((value) => value > 0).length;
const worse = deltas.filter((value) => value < 0).length;
const ties = n - better - worse;

const ROLES = ["landlord", "farmer-next", "farmer-previous"];
const byRole = ROLES.map((role) => {
  const subset = perGroup.filter((row) => row.role === role);
  const values = subset.map((row) => (row.modelWon ? 1 : 0) - (row.parentWon ? 1 : 0));
  const m = values.reduce((sum, value) => sum + value, 0) / Math.max(1, subset.length);
  const v =
    values.reduce((sum, value) => sum + (value - m) ** 2, 0) /
    Math.max(1, subset.length - 1);
  return {
    role,
    groups: subset.length,
    parentRate: subset.filter((row) => row.parentWon).length / Math.max(1, subset.length),
    modelRate: subset.filter((row) => row.modelWon).length / Math.max(1, subset.length),
    delta: m,
    se: Math.sqrt(v / Math.max(1, subset.length)),
    changed: subset.filter((row) => row.modelChangedAction).length,
  };
});

const third = perGroup.filter((row) => row.thirdWon !== null && row.thirdWon !== undefined);
const thirdValues = third.map((row) => (row.thirdWon ? 1 : 0) - (row.parentWon ? 1 : 0));
const thirdMean = thirdValues.reduce((sum, value) => sum + value, 0) / Math.max(1, third.length);
const thirdVariance =
  thirdValues.reduce((sum, value) => sum + (value - thirdMean) ** 2, 0) /
  Math.max(1, third.length - 1);
const distinctThird = third.filter(
  (row) => row.thirdIndex !== row.parentIndex && row.thirdIndex !== row.modelIndex,
).length;

const first = perGroup[0];
const last = perGroup[n - 1];
const lines = [
  `[selfplay-powered] greedy deployment counterfactual, pi1 environment`,
  `  groups          ${n} kept, ${excluded} excluded, shards ${JOBS}`,
  `  deal range      ${first.dealIndex}..${last.dealIndex}  (${DEV_START}..${DEV_START + TOTAL - 1} requested)`,
  `  root rule       ${perGroup[0].rootRule ?? "first-learning-decision-with-at-least-two-legal-actions-v1"}`,
  `  mean legal      ${(perGroup.reduce((sum, row) => sum + row.legalActionCount, 0) / n).toFixed(2)}`,
  `  A pi1 win rate  ${((100 * perGroup.filter((row) => row.parentWon).length) / n).toFixed(3)}%`,
  `  B model win     ${((100 * perGroup.filter((row) => row.modelWon).length) / n).toFixed(3)}%`,
  `  PRIMARY delta   ${(100 * mean).toFixed(3)}pp  SE ${(100 * se).toFixed(3)}pp  ` +
    `95% CI [${(100 * (mean - 1.96 * se)).toFixed(3)}, ${(100 * (mean + 1.96 * se)).toFixed(3)}]pp`,
  `  discordance     ${better} better / ${worse} worse / ${ties} tied ` +
    `(${((100 * (better + worse)) / n).toFixed(2)}% discordant)`,
  `  deviation       model left pi1 at ${perGroup.filter((row) => row.modelChangedAction).length}/${n} roots`,
  `  C arm           ${third.length} groups, ${distinctThird} with three distinct actions, ` +
    `delta ${(100 * thirdMean).toFixed(3)}pp SE ${(100 * Math.sqrt(thirdVariance / Math.max(1, third.length))).toFixed(3)}pp`,
  ...byRole.map(
    (entry) =>
      `  role ${entry.role.padEnd(16)} ${String(entry.groups).padStart(4)} groups  ` +
      `pi1 ${(100 * entry.parentRate).toFixed(2)}%  model ${(100 * entry.modelRate).toFixed(2)}%  ` +
      `delta ${(100 * entry.delta).toFixed(3)}pp +- ${(100 * 1.96 * entry.se).toFixed(3)}pp  ` +
      `changed ${entry.changed}`,
  ),
];
console.log(lines.join("\n"));

const summary = {
  label: "DEVELOPMENT_ONLY",
  continuum: "greedy-deployment-counterfactual",
  rootRule: "first-learning-decision-with-at-least-two-legal-actions-v1",
  dealRange: [first.dealIndex, last.dealIndex],
  groups: n,
  excluded,
  shards: JOBS,
  modelDigests,
  primary: {
    parentWins: perGroup.filter((row) => row.parentWon).length,
    modelWins: perGroup.filter((row) => row.modelWon).length,
    delta: mean,
    se,
    ci95: [mean - 1.96 * se, mean + 1.96 * se],
    better,
    worse,
    ties,
  },
  thirdArm: { groups: third.length, distinct: distinctThird, delta: thirdMean },
  byRole,
  perGroup,
};
mkdirSync(OUT_ROOT, { recursive: true });
writeFileSync(join(OUT_ROOT, "merged-summary.json"), JSON.stringify(summary, null, 2));
writeFileSync(join(OUT_ROOT, "merged-report.txt"), `${lines.join("\n")}\n`);
console.log(
  `[selfplay-powered] wrote ${join(OUT_ROOT, "merged-summary.json")} ` +
    `after ${((Date.now() - started) / 60000).toFixed(1)} min`,
);
