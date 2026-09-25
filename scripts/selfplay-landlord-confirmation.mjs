#!/usr/bin/env node
/**
 * Drive the CHEAP joint confirmation: run (blind), verify, seal, reveal once.
 *
 *   node scripts/selfplay-landlord-confirmation.mjs run 8
 *   node scripts/selfplay-landlord-confirmation.mjs verify
 *   node scripts/selfplay-landlord-confirmation.mjs reveal
 *
 * Verdicts are the ones frozen in the protocol, applied mechanically. The
 * console stays blind until both environments are sealed.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DIR = join(ROOT, ".local", "landlord-robust");
const RUN = join(DIR, "run");
const CHECKPOINTS = join(RUN, "checkpoints");
const SEAL = join(DIR, "seal.json");
const PROTOCOL = join(ROOT, "research/full-action-selfplay-v1/landlord-robust-confirmation-protocol.md");

// Frozen in the protocol.
const START = 952_401;
const GROUPS = 6_000;
const CHEAP_SHA = "070f5b0b728176a8fb11d6a79e585b1315b847e053a23821830e17394faac26b";
const A_TARGET_PP = 2.0;
const B_NI_MARGIN_PP = -1.0;

const command = process.argv[2] ?? "run";
const WORKERS = Math.max(1, Number(process.argv[3] ?? 8));

const sha256Of = (text) => createHash("sha256").update(text).digest("hex");

function windows(total, jobs) {
  const out = [];
  const base = Math.floor(total / jobs);
  const extra = total % jobs;
  let offset = 0;
  for (let index = 0; index < jobs; index += 1) {
    const size = base + (index < extra ? 1 : 0);
    if (size > 0) out.push({ offset, size, index });
    offset += size;
  }
  return out;
}

function runShard(window) {
  const env = {
    ...process.env,
    AI_SELFPLAY_LRC: "1",
    AI_SELFPLAY_LRC_START: String(START + window.offset),
    AI_SELFPLAY_LRC_GROUPS: String(window.size),
    AI_SELFPLAY_LRC_OUT: RUN,
  };
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", "--config", "vitest.benchmark.config.ts", "benchmarks/selfplay-landlord-confirmation.test.ts"],
      { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let blind = "";
    const forward = (chunk) => {
      const text = chunk.toString();
      blind += text;
      for (const line of text.split("\n")) {
        if (line.startsWith("[lrc]")) process.stdout.write(`${line}\n`);
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
  return readdirSync(CHECKPOINTS)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(CHECKPOINTS, name), "utf8")))
    .sort((left, right) => left.dealIndex - right.dealIndex);
}

/** Order-independent: over the sorted per-group records. */
function digestOf(records) {
  return sha256Of(
    records
      .map((r) => `${r.dealIndex}:${r.aBaseline ? 1 : 0}:${r.aCheap ? 1 : 0}:${r.bBaseline ? 1 : 0}:${r.bCheap ? 1 : 0}`)
      .join("\n"),
  );
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
  console.log(`[lrc] ${GROUPS} groups from ${START} in ${plan.length} shards, candidate ${CHEAP_SHA.slice(0, 16)}…`);
  const results = [];
  for (let index = 0; index < plan.length; index += WORKERS) {
    results.push(...(await Promise.all(plan.slice(index, index + WORKERS).map(runShard))));
  }
  if (results.some((r) => r.code !== 0)) {
    console.error("[lrc] a shard failed; refusing to seal.");
    process.exit(1);
  }
  const records = readCheckpoints();
  const expected = Array.from({ length: GROUPS }, (_, i) => START + i);
  const present = new Set(records.map((r) => r.dealIndex));
  const missing = expected.filter((d) => !present.has(d));
  const extra = [...present].filter((d) => d < START || d >= START + GROUPS);

  const seal = {
    candidateSha256: CHEAP_SHA,
    poolNamespace: "landlord-robust-confirmation-v1",
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
    `[lrc] sealed: ${seal.records}/${GROUPS}, missing ${missing.length}, extra ${extra.length}, ` +
      `digest ${seal.contentDigest.slice(0, 16)}…, wall ${(seal.wallSeconds / 60).toFixed(1)} min`,
  );
  if (missing.length > 0 || extra.length > 0) process.exit(1);
}

function verify() {
  if (!existsSync(SEAL)) {
    console.error("[lrc] no seal to verify.");
    process.exit(1);
  }
  const seal = JSON.parse(readFileSync(SEAL, "utf8"));
  const records = readCheckpoints();
  const ok = digestOf(records) === seal.contentDigest && records.length === seal.groups;
  console.log(
    `[lrc] verify: records ${records.length}/${seal.groups}, digest ${ok ? "MATCHES" : "DIFFERS"}, ` +
      `candidate ${seal.candidateSha256.slice(0, 16)}…, protocol ${seal.protocolSha256.slice(0, 16)}…`,
  );
  if (!ok) process.exit(1);
}

function reveal() {
  if (!existsSync(SEAL)) {
    console.error("[lrc] refusing to reveal before the seal exists.");
    process.exit(1);
  }
  const seal = JSON.parse(readFileSync(SEAL, "utf8"));
  const records = readCheckpoints();
  if (digestOf(records) !== seal.contentDigest) {
    console.error("[lrc] checkpoints do not match the seal; refusing to reveal.");
    process.exit(1);
  }

  const A = paired(records, "aBaseline", "aCheap");
  const B = paired(records, "bBaseline", "bCheap");
  const pp = (v) => `${(100 * v).toFixed(3)}pp`;
  const block = (label, s) =>
    `  ${label}\n     N ${s.N}  baseline ${(100 * s.baselineWinRate).toFixed(3)}%  CHEAP ${(100 * s.candidateWinRate).toFixed(3)}%\n` +
    `     delta ${pp(s.mean)}  sd ${pp(s.sd)}  SE ${pp(s.se)}  95% CI [${pp(s.low)}, ${pp(s.high)}]\n` +
    `     better ${s.better}  worse ${s.worse}  tie ${s.tie}`;

  const aVerdict =
    A.mean >= A_TARGET_PP / 100 && A.low > 0
      ? "A_PASS"
      : A.high < A_TARGET_PP / 100
        ? "A_BELOW_ENGINEERING_TARGET"
        : "A_INCONCLUSIVE";
  const bVerdict =
    B.low > B_NI_MARGIN_PP / 100 ? "B_NI_PASS" : B.high < B_NI_MARGIN_PP / 100 ? "B_INFERIOR" : "B_INCONCLUSIVE";
  const joint =
    aVerdict === "A_PASS" && bVerdict === "B_NI_PASS"
      ? "JOINT RESEARCH PASS"
      : aVerdict === "A_BELOW_ENGINEERING_TARGET" || bVerdict === "B_INFERIOR"
        ? "JOINT NO-GO"
        : "JOINT INCONCLUSIVE";

  console.log(
    [
      "[lrc] REVEAL — CHEAP joint dual-environment confirmation",
      block("Environment A (pi1 / pi1 farmers)   target: point >= +2.00pp and CI lower > 0", A),
      `     VERDICT ${aVerdict}`,
      block("Environment B (default / default farmers)   non-inferiority margin: -1.00pp", B),
      `     VERDICT ${bVerdict}`,
      `  JOINT  ${joint}`,
    ].join("\n"),
  );
  writeFileSync(
    join(DIR, "result.json"),
    JSON.stringify({ A, B, aVerdict, bVerdict, joint, seal }, null, 2),
  );
}

if (command === "run") await run();
else if (command === "verify") verify();
else if (command === "reveal") reveal();
else {
  console.error(`unknown command: ${command}`);
  process.exit(2);
}
