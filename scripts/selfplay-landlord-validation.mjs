#!/usr/bin/env node
/**
 * Drive the landlord independent validation: shard, merge, seal, then reveal.
 *
 * `run`   — collect PRIMARY and SECONDARY over the frozen pool, printing only
 *           blind progress. Writes a sealed, order-independent digest.
 * `verify`— re-derive the digest from the checkpoints without printing anything
 *           about outcomes, so a reviewer can confirm the seal before revealing.
 * `reveal`— print the verdict once, after the seal is verified.
 *
 *   node scripts/selfplay-landlord-validation.mjs run 8
 *   node scripts/selfplay-landlord-validation.mjs verify
 *   node scripts/selfplay-landlord-validation.mjs reveal
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DIR = join(ROOT, ".local", "landlord-validation");
const RUN = join(DIR, "run");
const CHECKPOINTS = join(RUN, "checkpoints");
const SEAL = join(DIR, "seal.json");
const PROTOCOL = join(ROOT, "research/full-action-selfplay-v1/landlord-validation-protocol.md");

// Frozen in the protocol. Changing any of these invalidates the run.
const START = 950_001;
const GROUPS = 2_400;
const CANDIDATE_SHA = "7ad463175b54d632c1d3e7ad1b15af3cfd0c454b96b39f73f636254a964b98a9";
const ENGINEERING_THRESHOLD_PP = 2.0;

const command = process.argv[2] ?? "run";
const WORKERS = Math.max(1, Number(process.argv[3] ?? 8));

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
  const env = {
    ...process.env,
    AI_SELFPLAY_LV: "1",
    AI_SELFPLAY_LV_START: String(START + window.offset),
    AI_SELFPLAY_LV_GROUPS: String(window.size),
    AI_SELFPLAY_LV_OUT: RUN,
  };
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        join(ROOT, "node_modules", "vitest", "vitest.mjs"),
        "run",
        "--config",
        "vitest.benchmark.config.ts",
        "benchmarks/selfplay-landlord-validation.test.ts",
      ],
      { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let blind = "";
    const forward = (chunk) => {
      const text = chunk.toString();
      blind += text;
      // Only `[lv]` lines reach the console: they carry progress, never outcomes.
      for (const line of text.split("\n")) {
        if (line.startsWith("[lv]")) {
          process.stdout.write(`${line}\n`);
        }
      }
    };
    child.stdout.on("data", forward);
    child.stderr.on("data", (chunk) => {
      blind += chunk.toString();
    });
    child.on("close", (code) => {
      writeFileSync(join(RUN, `shard-${START + window.offset}.log`), blind);
      resolve({ ...window, code });
    });
  });
}

function readCheckpoints() {
  const files = readdirSync(CHECKPOINTS).filter((name) => name.endsWith(".json"));
  return files
    .map((name) => JSON.parse(readFileSync(join(CHECKPOINTS, name), "utf8")))
    .sort((left, right) => left.dealIndex - right.dealIndex);
}

/** Order-independent: the digest is over the sorted per-group records. */
function digestOf(records) {
  return createHash("sha256")
    .update(
      records
        .map(
          (r) =>
            `${r.dealIndex}:${r.primaryBaselineWon ? 1 : 0}:${r.primaryCandidateWon ? 1 : 0}:` +
            `${r.secondaryBaselineWon ? 1 : 0}:${r.secondaryCandidateWon ? 1 : 0}`,
        )
        .join("\n"),
    )
    .digest("hex");
}

function paired(records, baselineKey, candidateKey) {
  const d = records.map((r) => (r[candidateKey] ? 1 : 0) - (r[baselineKey] ? 1 : 0));
  const n = d.length;
  const mean = d.reduce((sum, value) => sum + value, 0) / n;
  const variance = d.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1);
  const se = Math.sqrt(variance / n);
  return {
    N: n,
    baselineWinRate: records.filter((r) => r[baselineKey]).length / n,
    candidateWinRate: records.filter((r) => r[candidateKey]).length / n,
    mean,
    sd: Math.sqrt(variance),
    se,
    low: mean - 1.96 * se,
    high: mean + 1.96 * se,
    better: d.filter((v) => v > 0).length,
    worse: d.filter((v) => v < 0).length,
    tie: d.filter((v) => v === 0).length,
  };
}

async function run() {
  mkdirSync(CHECKPOINTS, { recursive: true });
  const started = Date.now();
  const plan = windows(GROUPS, WORKERS);
  console.log(`[lv] ${GROUPS} groups from ${START} in ${plan.length} shards, candidate ${CANDIDATE_SHA.slice(0, 16)}…`);
  const results = [];
  for (let index = 0; index < plan.length; index += WORKERS) {
    results.push(...(await Promise.all(plan.slice(index, index + WORKERS).map(runShard))));
  }
  const failed = results.filter((r) => r.code !== 0);
  if (failed.length > 0) {
    console.error(`[lv] ${failed.length} shard(s) failed; refusing to seal.`);
    process.exit(1);
  }

  const records = readCheckpoints();
  const expected = Array.from({ length: GROUPS }, (_, i) => START + i);
  const present = new Set(records.map((r) => r.dealIndex));
  const missing = expected.filter((dealIndex) => !present.has(dealIndex));
  const extra = [...present].filter((dealIndex) => dealIndex < START || dealIndex >= START + GROUPS);

  const seal = {
    candidateSha256: CANDIDATE_SHA,
    poolNamespace: "landlord-independent-validation-v1",
    range: [START, START + GROUPS - 1],
    groups: GROUPS,
    records: records.length,
    missing,
    extra,
    wallSeconds: (Date.now() - started) / 1000,
    workers: WORKERS,
    contentDigest: digestOf(records),
    protocolSha256: sha256Of(readFileSync(PROTOCOL, "utf8")),
    sealedAt: new Date().toISOString(),
  };
  writeFileSync(SEAL, JSON.stringify(seal, null, 2));
  console.log(
    `[lv] sealed: ${seal.records}/${GROUPS} records, missing ${missing.length}, extra ${extra.length}, ` +
      `digest ${seal.contentDigest.slice(0, 16)}…, wall ${(seal.wallSeconds / 60).toFixed(1)} min`,
  );
  if (missing.length > 0 || extra.length > 0) {
    console.error("[lv] the pool is not fully covered; the seal records the gap.");
    process.exit(1);
  }
}

function sha256Of(text) {
  return createHash("sha256").update(text).digest("hex");
}

function verify() {
  if (!existsSync(SEAL)) {
    console.error("[lv] no seal to verify.");
    process.exit(1);
  }
  const seal = JSON.parse(readFileSync(SEAL, "utf8"));
  const records = readCheckpoints();
  const digest = digestOf(records);
  const ok = digest === seal.contentDigest && records.length === seal.groups;
  console.log(
    `[lv] verify: records ${records.length}/${seal.groups}, digest ${ok ? "MATCHES" : "DIFFERS"}, ` +
      `candidate ${seal.candidateSha256.slice(0, 16)}…, protocol ${seal.protocolSha256.slice(0, 16)}…`,
  );
  if (!ok) {
    process.exit(1);
  }
}

function reveal() {
  if (!existsSync(SEAL)) {
    console.error("[lv] refusing to reveal before the seal exists.");
    process.exit(1);
  }
  const seal = JSON.parse(readFileSync(SEAL, "utf8"));
  const records = readCheckpoints();
  if (digestOf(records) !== seal.contentDigest) {
    console.error("[lv] the checkpoints do not match the seal; refusing to reveal.");
    process.exit(1);
  }

  const primary = paired(records, "primaryBaselineWon", "primaryCandidateWon");
  const secondary = paired(records, "secondaryBaselineWon", "secondaryCandidateWon");
  const pp = (value) => `${(100 * value).toFixed(3)}pp`;
  const line = (label, s) =>
    `  ${label}  N ${s.N}  baseline ${(100 * s.baselineWinRate).toFixed(3)}%  candidate ${(100 * s.candidateWinRate).toFixed(3)}%\n` +
    `     delta ${pp(s.mean)}  sd ${pp(s.sd)}  SE ${pp(s.se)}  95% CI [${pp(s.low)}, ${pp(s.high)}]\n` +
    `     better ${s.better}  worse ${s.worse}  tie ${s.tie}`;

  const decision =
    primary.mean >= ENGINEERING_THRESHOLD_PP / 100 && primary.low > 0
      ? "RESEARCH PASS"
      : primary.high < ENGINEERING_THRESHOLD_PP / 100
        ? "BELOW ENGINEERING TARGET"
        : "INCONCLUSIVE";

  console.log(
    [
      "[lv] REVEAL — landlord independent validation",
      line("PRIMARY  ", primary),
      line("SECONDARY", secondary),
      `  threshold  point estimate >= +${ENGINEERING_THRESHOLD_PP.toFixed(2)}pp and CI lower bound > 0`,
      `  VERDICT    ${decision}`,
    ].join("\n"),
  );
}

if (command === "run") {
  await run();
} else if (command === "verify") {
  verify();
} else if (command === "reveal") {
  reveal();
} else {
  console.error(`unknown command: ${command}`);
  process.exit(2);
}
