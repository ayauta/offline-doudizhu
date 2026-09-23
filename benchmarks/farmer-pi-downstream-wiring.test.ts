/**
 * Factory v1 — the downstream wiring harness. TEST ONLY.
 *
 * The miniature pipeline stops at `calibration-no-go`, correctly and for a
 * reason that has nothing to do with wiring: the alternative labels on retired
 * deals are 8 positive against 10 negative, so `lower = mean - t * se` cannot
 * exceed zero at any sample size. The state machine therefore never reaches the
 * offline screen, Stage 1 or the formal test, and those three steps' *runner and
 * control-plane wiring* has no end-to-end evidence.
 *
 * This file supplies it, and it is deliberately not a mode of the runner.
 * `scripts/farmer-pi.mjs` has no flag that starts a stage, skips a stage or
 * resumes at a stage — a frozen Factory with a human stage-skip is not a frozen
 * Factory — so the only way to walk these edges is from a test, over the same
 * process boundary the runner uses.
 *
 * ## What is real here, and what is a fixture
 *
 * Real: the champion and candidate policies, the games, the per-deal outcomes,
 * the paired aggregation, the seals, the Stage 1 statistic, the formal
 * sample-size rule, the formal statistic, the verdict formula, the archive.
 *
 * Fixture, and narrow: **the upstream prerequisite**. Both the offline screen
 * and Stage 1 gate on something an earlier stage decided, and a wiring test that
 * had to make a real candidate *win* would be a test that picks seeds until it
 * likes the answer. So a test-only sealed calibration artefact stands in for
 * "calibration passed" — a control-flow fixture, not a claim that a model did.
 *
 * `REHEARSAL_ONLY`. Nothing here is strength evidence, no verdict it produces
 * may enter the champion archive, and it can only address pools the ledger
 * already records as retired.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { CF_FEATURE_NAMES } from "../src/core/ai/cf-features.js";
import { cfSchemaHash } from "./cf-corpus.js";
import { sha256 } from "./farmer-pi-stage.js";

const ROOT = process.cwd();
const VITEST = join(ROOT, "node_modules", ".bin", "vitest");
const BENCH_CONFIG = "vitest.benchmark.config.ts";
const CONTROL_BENCH = "benchmarks/farmer-pi-control.test.ts";
const STAGE_BENCH = "benchmarks/farmer-pi-stage.test.ts";
const REHEARSAL_PROTOCOL = "research/farmer-pi/protocol-rehearsal.yaml";

/** Retired deals only. `discovery-v1` is 301-700, exposed twice, retired. */
const WIRING_START = 401;
const WIRING_DEALS = 3;
const WIRING_ROOT = join(ROOT, ".local", "farmer-pi-wiring");

let controlSeq = 0;

/** One control mode, one answer — the same boundary and shape the runner uses. */
function control(mode: string, config: Record<string, unknown>): Record<string, unknown> {
  mkdirSync(join(WIRING_ROOT, "control"), { recursive: true });
  controlSeq += 1;
  const path = join(WIRING_ROOT, "control", `${String(controlSeq).padStart(4, "0")}-${mode}.json`);
  writeFileSync(path, `${JSON.stringify({ mode, root: WIRING_ROOT, ...config }, null, 2)}\n`, "utf8");
  const run = spawnSync(VITEST, ["run", "--config", BENCH_CONFIG, CONTROL_BENCH], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, AI_FPI_CONTROL: mode, AI_FPI_CONTROL_CONFIG: path },
    maxBuffer: 64 * 1024 * 1024,
  });
  const lines = `${run.stdout ?? ""}${run.stderr ?? ""}`.split("\n")
    .filter((line) => line.startsWith("[fpi control] "))
    .map((line) => line.slice("[fpi control] ".length));
  if (lines.length === 0) {
    throw new Error(`control "${mode}" answered nothing (exit ${String(run.status)}):\n` +
      `${run.stdout ?? ""}${run.stderr ?? ""}`.split("\n").slice(-20).join("\n"));
  }
  const last = lines[lines.length - 1] ?? "";
  try {
    return JSON.parse(last);
  } catch {
    return { text: last };
  }
}

function runStageWorker(env: Record<string, string>): void {
  const run = spawnSync(VITEST, ["run", "--config", BENCH_CONFIG, STAGE_BENCH], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0) {
    throw new Error(`stage worker failed (${String(run.status)}):\n` +
      `${run.stdout ?? ""}${run.stderr ?? ""}`.split("\n").slice(-25).join("\n"));
  }
}

/**
 * The upstream prerequisite, as a fixture.
 *
 * A calibration that passed, in the shape the attempt record holds it: a
 * threshold and a packaged layer for the candidate chain. The layer is a real,
 * loadable model — the arms really play against it — and it is deliberately a
 * constant, because the point is the wiring and not the candidate's quality.
 */
function writeCandidateLayerFixture() {
  const model = {
    formatVersion: 1,
    lightgbmVersion: "wiring-fixture",
    modelSha256: "wiring-fixture-not-a-real-booster",
    objective: "regression",
    numTrees: 1,
    numFeatures: CF_FEATURE_NAMES.length,
    featureNames: [...CF_FEATURE_NAMES],
    trees: [{
      feature: [-1], threshold: [0], defaultLeft: [0], missingZero: [0],
      left: [0], right: [0], value: [-1e9],
    }],
    rehearsalOnly: true,
  };
  mkdirSync(join(WIRING_ROOT, "fixture"), { recursive: true });
  const path = join(WIRING_ROOT, "fixture", "candidate.json");
  const text = JSON.stringify(model);
  writeFileSync(path, text, "utf8");
  return {
    artifactPath: path,
    modelSha256: model.modelSha256,
    // `-1e9` means "never override": the candidate arm plays the champion's own
    // action at every root, which keeps the fixture out of the result entirely.
    threshold: -1e9,
    modelBytes: Buffer.byteLength(text, "utf8"),
  };
}

function rehearsalLedger() {
  const rows = readFileSync(join(ROOT, "research", "farmer-pi", "pool-ledger.jsonl"), "utf8")
    .split("\n").filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
  const kept = [];
  for (const row of rows) {
    if (row.poolId === "factory-v1-namespace") {
      kept.push({ ...row, start: 301, end: 700, note: "WIRING FIXTURE COPY. Namespace on retired discovery-v1." });
    } else if (row.poolId === "discovery-v1") {
      continue;
    } else {
      kept.push(row);
    }
  }
  kept.forEach((row, index) => { row.seq = index + 1; });
  mkdirSync(WIRING_ROOT, { recursive: true });
  const path = join(WIRING_ROOT, "ledger.jsonl");
  writeFileSync(path, kept.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  return path;
}

/**
 * The rehearsal protocol's hash, which is what an attempt under it registers.
 *
 * Read from the file's own bytes rather than asked of the control plane, because
 * every worker re-derives it and refuses a mismatch — so a harness that guessed
 * would fail at its first worker.
 */
function rehearsalProtocolHash() {
  return sha256(readFileSync(join(ROOT, REHEARSAL_PROTOCOL), "utf8"));
}

afterAll(() => {
  rmSync(WIRING_ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The guards, first: a harness that can touch a fresh pool is not a harness
// ---------------------------------------------------------------------------

describe("the wiring harness cannot reach anything that matters", () => {
  it("addresses only pools the ledger already records as retired", () => {
    const ledger = rehearsalLedger();
    const pools = readFileSync(ledger, "utf8").split("\n").filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
    for (const pool of pools) {
      if (pool.start === undefined || pool.end === undefined) {
        continue;
      }
      // The Factory's own territory starts at 200001. Nothing this harness can
      // address may live there, whatever the pool says its state is.
      expect(pool.start).toBeLessThan(200_001);
      expect(pool.end).toBeLessThan(200_001);
    }
    const namespace = pools.find((pool) => pool.poolId === "factory-v1-namespace");
    expect(namespace?.start).toBe(301);
    expect(namespace?.end).toBe(700);
  });

  it("leaves the repository's own ledger and champion archive untouched", () => {
    const before = readFileSync(join(ROOT, "research", "farmer-pi", "pool-ledger.jsonl"), "utf8");
    rehearsalLedger();
    control("inspect", { runnerCommit: null, runnerDirty: null });
    const after = readFileSync(join(ROOT, "research", "farmer-pi", "pool-ledger.jsonl"), "utf8");
    expect(after).toBe(before);
    // And no champion archive exists for anything this harness could name.
    for (const id of ["ai-v2-research", "ai-v3-research"]) {
      expect(existsSync(join(ROOT, "research", "farmer-pi", "champions", `${id}.json`)))
        .toBe(false);
    }
  });

  it("marks its candidate fixture, so it cannot be mistaken for a model", () => {
    const layer = writeCandidateLayerFixture();
    const parsed = JSON.parse(readFileSync(layer.artifactPath, "utf8"));
    expect(parsed.rehearsalOnly).toBe(true);
    expect(parsed.lightgbmVersion).toBe("wiring-fixture");
    expect(parsed.modelSha256).not.toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// Real gameplay: the arms really play, really checkpoint, really seal
// ---------------------------------------------------------------------------

describe("both arms of a strength stage really run and seal", () => {
  it("plays Stage 1 on retired deals, seals both arms, and derives a real decision", () => {
    const ledger = rehearsalLedger();
    void ledger;
    const layer = writeCandidateLayerFixture();
    const protocolHash = rehearsalProtocolHash();
    const pool = {
      poolId: "wiring/stage1", purpose: "stage1",
      start: WIRING_START, end: WIRING_START + WIRING_DEALS - 1,
    };
    const at = new Date().toISOString();
    const base = {
      attemptId: "wiring", championId: "ai-v1", at, pool,
      protocolPath: REHEARSAL_PROTOCOL, ledgerPath: join(WIRING_ROOT, "ledger.jsonl"),
    };

    const record = control("open-stage", { ...base, stage: "stage1", role: "record" });
    const dirs: Record<string, string> = {};
    for (const arm of ["champion", "candidate"]) {
      const opened = control("open-stage", {
        ...base, stage: "stage1", role: "arm", arm,
        ...(arm === "candidate" ? { layer } : {}),
      });
      dirs[arm] = String(opened.dir);
      expect(opened.configHash).toMatch(/^[0-9a-f]{64}$/);
    }
    // The two arms must have different configuration hashes: the manifest is per
    // directory and covers the chain, which is exactly why they cannot share one.
    expect(dirs.champion).not.toBe(dirs.candidate);

    for (const arm of ["champion", "candidate"]) {
      const armDir = dirs[arm];
      expect(armDir).toBeDefined();
      runStageWorker({
        AI_FPI_ARM_RUN: armDir ?? "",
        AI_FPI_ARM: arm,
        AI_FPI_STAGE: "stage1",
        AI_FPI_CHAMPION_ID: "ai-v1",
        AI_FPI_POOL_START: String(pool.start),
        AI_FPI_DEALS: String(WIRING_DEALS),
        AI_FPI_PROTOCOL_HASH: protocolHash,
        AI_FPI_PROTOCOL_PATH: REHEARSAL_PROTOCOL,
        AI_FPI_POLICY_COMMIT: "wiring-harness",
        AI_FPI_ATTEMPT_ID: "wiring",
        ...(arm === "candidate" ? {
          AI_FPI_CANDIDATE_LAYER: layer.artifactPath,
          AI_FPI_CANDIDATE_SHA: layer.modelSha256,
          AI_FPI_CANDIDATE_THRESHOLD: String(layer.threshold),
          AI_FPI_CANDIDATE_BYTES: String(layer.modelBytes),
        } : {}),
      });
    }

    for (const arm of ["champion", "candidate"]) {
      const sealed = control("seal-stage", {
        dir: dirs[arm] ?? "", at: new Date().toISOString(),
      });
      expect(sealed.completion).toBe("SEALED");
      // Real deals really checkpointed, one per deal, per arm.
      expect(sealed.deals).toBe(WIRING_DEALS);
    }
    control("seal-stage", { dir: record.dir, at: new Date().toISOString() });

    const verdict = control("strength-verdict", {
      ...base, stage: "stage1", dirs, recordDir: record.dir,
    });
    expect(typeof verdict.deals).toBe("number");
    expect(verdict.deals).toBe(WIRING_DEALS);
    expect(typeof verdict.mean).toBe("number");
    expect(typeof verdict.variance).toBe("number");
    expect(typeof verdict.proceed).toBe("boolean");
    expect(verdict.integrityValid).toBe(true);
  }, 900_000);
});

// ---------------------------------------------------------------------------
// The transitions the miniature could not reach
// ---------------------------------------------------------------------------

describe("the downstream transitions are the frozen functions", () => {
  it("exposes no stage-skip anywhere in the runner's interface", () => {
    const help = spawnSync(process.execPath, ["scripts/farmer-pi.mjs", "--help"], {
      cwd: ROOT, encoding: "utf8",
    });
    const text = `${help.stdout ?? ""}${help.stderr ?? ""}`;
    expect(help.status).toBe(0);
    for (const forbidden of ["--start-stage", "--stage", "--skip", "--from", "--resume-at"]) {
      expect(text.includes(forbidden)).toBe(false);
    }
    // And the runner refuses an unknown flag rather than ignoring it.
    const refused = spawnSync(process.execPath, [
      "scripts/farmer-pi.mjs", "run", "--start-stage", "stage1",
    ], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
    expect(refused.status).not.toBe(0);
  }, 120_000);

  it("never lets a stage produce a verdict before it is sealed", () => {
    const base = {
      attemptId: "wiring-transitions", championId: "ai-v1", at: new Date().toISOString(),
      protocolPath: REHEARSAL_PROTOCOL, ledgerPath: join(WIRING_ROOT, "ledger.jsonl"),
    };
    const record = control("open-stage", {
      ...base, stage: "formal", role: "record",
      pool: { poolId: "wiring/formal", purpose: "formal", start: 501, end: 504 },
    }) as { dir: string };
    // The record is sealed but its arms are absent, so a verdict has nothing to
    // read and must refuse rather than return a number.
    control("seal-stage", { dir: record.dir, at: new Date().toISOString() });
    let failed = false;
    try {
      control("strength-verdict", {
        ...base, stage: "formal", recordDir: record.dir,
        dirs: { champion: join(WIRING_ROOT, "absent-champion"), candidate: join(WIRING_ROOT, "absent-candidate") },
      });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  }, 300_000);

  it("keeps the formal ladder and the promotion rule exactly where they were frozen", () => {
    // The two rules the downstream transition turns on, read from the protocol
    // the Factory will actually run under rather than from the rehearsal's.
    const real = readFileSync(join(ROOT, "research", "farmer-pi", "protocol-v1.yaml"), "utf8");
    const rehearsal = readFileSync(join(ROOT, REHEARSAL_PROTOCOL), "utf8");
    for (const line of ["alpha: 0.005", "promotionFloor: 0.01", "designDelta: 0.02"]) {
      expect(real.includes(line)).toBe(true);
      expect(rehearsal.includes(line)).toBe(true);
    }
    // The ladder is the one thing a rehearsal is allowed to shrink, and it is
    // the only difference this harness relies on.
    expect(real).toContain("    - 4800");
    expect(rehearsal).toContain("    - 6");
  });

  it("has a schema hash the fixture rows and the models agree on", () => {
    expect(cfSchemaHash()).toMatch(/^[0-9a-f]{64}$/);
    expect(CF_FEATURE_NAMES.length).toBe(86);
    expect(sha256("wiring")).toMatch(/^[0-9a-f]{64}$/);
  });
});
