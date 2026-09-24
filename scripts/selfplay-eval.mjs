#!/usr/bin/env node
/**
 * Shard and merge evaluation A and evaluation B.
 *
 * Both are one paired comparison per initial deal group, so a contiguous window
 * of groups is a complete and independent piece of the estimate and sharding is
 * exact. The merge re-derives every reported statistic from the per-group rows,
 * so a merged number is computed the same way an unsharded one would be.
 *
 *   node scripts/selfplay-eval.mjs a 12
 *   node scripts/selfplay-eval.mjs b 12
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const WHICH = (process.argv[2] ?? "a").toLowerCase();
const WORKERS = Math.max(1, Number(process.argv[3] ?? 12));

const SPEC = {
  a: {
    test: "benchmarks/selfplay-eval-a.test.ts",
    dir: join(ROOT, ".local", "selfplay-eval-a"),
    start: 900_001,
    groups: 6_000,
    flag: "AI_SELFPLAY_EVAL_A",
    outVar: "AI_SELFPLAY_EVAL_A_OUT",
    startVar: "AI_SELFPLAY_EVAL_A_START",
    groupsVar: "AI_SELFPLAY_EVAL_A_GROUPS",
    summary: "eval-a-summary.json",
    roles: ["landlord", "farmer-next", "farmer-previous"],
    keys: [
      ["TARGET - CHEAP", "cheapWon", "targetWon"],
      ["TARGET - pi1", "parentWon", "targetWon"],
      ["CHEAP - pi1", "parentWon", "cheapWon"],
    ],
  },
  b: {
    test: "benchmarks/selfplay-eval-b.test.ts",
    dir: join(ROOT, ".local", "selfplay-eval-b"),
    start: 915_001,
    groups: 1_200,
    flag: "AI_SELFPLAY_EVAL_B",
    outVar: "AI_SELFPLAY_EVAL_B_OUT",
    startVar: "AI_SELFPLAY_EVAL_B_START",
    groupsVar: "AI_SELFPLAY_EVAL_B_GROUPS",
    summary: "eval-b-summary.json",
    roles: ["landlord", "farmer-next", "farmer-previous"],
    keys: [
      ["CHEAP - pi1", "parentWon", "CHEAPWon"],
      ["TARGET - pi1", "parentWon", "TARGETWon"],
      ["TARGET - CHEAP", "CHEAPWon", "TARGETWon"],
    ],
  },
};

const spec = SPEC[WHICH];
if (spec === undefined) {
  console.error(`unknown evaluation: ${WHICH}`);
  process.exit(2);
}

function windows(total, jobs) {
  const out = [];
  const base = Math.floor(total / jobs);
  const extra = total % jobs;
  let offset = 0;
  for (let index = 0; index < jobs; index += 1) {
    const size = base + (index < extra ? 1 : 0);
    if (size > 0) {
      out.push({ offset, size, index });
    }
    offset += size;
  }
  return out;
}

function runShard(window) {
  const outDir = join(spec.dir, `shard-${window.index}`);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const env = {
    ...process.env,
    [spec.flag]: "1",
    [spec.startVar]: String(spec.start + window.offset),
    [spec.groupsVar]: String(window.size),
    [spec.outVar]: outDir,
  };
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", "--config", "vitest.benchmark.config.ts", spec.test],
      { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => {
      writeFileSync(join(outDir, "shard.log"), output);
      resolve({ ...window, code, outDir });
    });
  });
}

function paired(rows, left, right) {
  const d = rows.map((row) => (row[right] ? 1 : 0) - (row[left] ? 1 : 0));
  const n = Math.max(1, d.length);
  const mean = d.reduce((sum, value) => sum + value, 0) / n;
  const variance = d.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, n - 1);
  const se = Math.sqrt(variance / n);
  return {
    groups: d.length,
    mean,
    se,
    low: mean - 1.96 * se,
    high: mean + 1.96 * se,
    better: d.filter((value) => value > 0).length,
    worse: d.filter((value) => value < 0).length,
    ties: d.filter((value) => value === 0).length,
  };
}

const plan = windows(spec.groups, WORKERS);
console.log(`[eval-${WHICH}] ${spec.groups} groups from ${spec.start} in ${plan.length} shards`);
const started = Date.now();
const results = [];
for (let index = 0; index < plan.length; index += WORKERS) {
  results.push(...(await Promise.all(plan.slice(index, index + WORKERS).map(runShard))));
}
for (const result of results.filter((entry) => entry.code !== 0)) {
  process.stderr.write(readFileSync(join(result.outDir, "shard.log"), "utf8"));
}
if (results.some((entry) => entry.code !== 0)) {
  console.error(`[eval-${WHICH}] a shard failed; refusing to merge.`);
  process.exit(1);
}

const rows = [];
let excluded = 0;
const modelDigests = {};
for (const result of results.sort((left, right) => left.offset - right.offset)) {
  const summary = JSON.parse(readFileSync(join(result.outDir, spec.summary), "utf8"));
  rows.push(...summary.rows);
  excluded += summary.excluded ?? 0;
  Object.assign(modelDigests, summary.modelDigests ?? {});
}
rows.sort((left, right) =>
  left.dealIndex - right.dealIndex || String(left.role).localeCompare(String(right.role)),
);
const seen = new Set(rows.map((row) => `${row.dealIndex}:${row.role}`));
if (seen.size !== rows.length) {
  console.error(`[eval-${WHICH}] duplicate (group, role) cells after merge.`);
  process.exit(1);
}

const fmt = (label, value) =>
  `  ${label.padEnd(16)} Δ ${(100 * value.mean).toFixed(3)}pp  SE ${(100 * value.se).toFixed(3)}pp  ` +
  `95% CI [${(100 * value.low).toFixed(3)}, ${(100 * value.high).toFixed(3)}]pp  ` +
  `${value.better} better / ${value.worse} worse / ${value.ties} tie  (n=${value.groups})`;

const lines = [
  `[eval-${WHICH}] ${rows.length} cells over ${new Set(rows.map((r) => r.dealIndex)).size} deal groups ` +
    `(${excluded} excluded), ${((Date.now() - started) / 60000).toFixed(1)} min wall`,
];
const summary = { modelDigests, overall: {}, byRole: {} };
for (const [label, left, right] of spec.keys) {
  const value = paired(rows, left, right);
  summary.overall[label] = value;
  lines.push(fmt(label, value));
}
for (const role of spec.roles) {
  const subset = rows.filter((row) => row.role === role);
  lines.push(`  -- ${role} (${subset.length} cells)`);
  summary.byRole[role] = {};
  for (const [label, left, right] of spec.keys) {
    const value = paired(subset, left, right);
    summary.byRole[role][label] = value;
    lines.push(fmt(`   ${label}`, value));
  }
}

const out = join(spec.dir, `merged-eval-${WHICH}.json`);
writeFileSync(out, JSON.stringify({ label: "DEVELOPMENT_ONLY", evaluation: `eval-${WHICH}`, spec: { start: spec.start, groups: spec.groups }, rows, summary, contentDigest: createHash("sha256").update(JSON.stringify(rows)).digest("hex") }, null, 2));
writeFileSync(join(spec.dir, `merged-eval-${WHICH}.txt`), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
console.log(`[eval-${WHICH}] wrote ${out}`);
