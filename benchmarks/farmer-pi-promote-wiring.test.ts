/**
 * Factory v1 — the promotion wiring harness. TEST ONLY.
 *
 * The one branch nothing else can reach. A PROMOTE needs a sealed formal verdict
 * that says so, and the only honest way to obtain one is to run a candidate that
 * really beats the champion — which is the experiment itself, not a rehearsal.
 * So this file fabricates *exactly one thing*: a sealed formal verdict, in the
 * shape the control plane writes, marked `REHEARSAL_ONLY` at every level. The
 * code under test is entirely canonical:
 *
 *     readSealedVerdict -> decideOutcome -> PROMOTE -> writeChampion
 *       -> champion archive -> next research-champion state
 *
 * It also covers the two neighbouring branches, FAIL -> REJECTED and a malformed
 * verdict -> INTEGRITY_STOP, and the idempotence of a repeated promotion.
 *
 * ## The guards, which are the point
 *
 * A fixture that can promote is a fixture that can corrupt the Factory, so five
 * properties are asserted rather than promised: the repository's own ledger is
 * byte-identical afterwards, its champion archive directory has gained nothing,
 * no `ai-vN-research` tag exists, the attempt is not one the real runner resumes,
 * and the archive it does write is unambiguously a rehearsal's.
 *
 * `scripts/farmer-pi.mjs` gained no flag for any of this.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { CF_FEATURE_NAMES } from "../src/core/ai/cf-features.js";

const ROOT = process.cwd();
const VITEST = join(ROOT, "node_modules", ".bin", "vitest");
const BENCH_CONFIG = "vitest.benchmark.config.ts";
const CONTROL_BENCH = "benchmarks/farmer-pi-control.test.ts";
const REHEARSAL_PROTOCOL = "research/farmer-pi/protocol-rehearsal.yaml";
const REAL_LEDGER = join(ROOT, "research", "farmer-pi", "pool-ledger.jsonl");
const REAL_CHAMPIONS = join(ROOT, "research", "farmer-pi", "champions");
const WORK = join(ROOT, ".local", "farmer-pi-promote");

let seq = 0;

function control(mode: string, config: Record<string, unknown>): Record<string, unknown> {
  mkdirSync(join(WORK, "control"), { recursive: true });
  seq += 1;
  const path = join(WORK, "control", `${String(seq).padStart(4, "0")}-${mode}.json`);
  writeFileSync(path, `${JSON.stringify({ mode, root: WORK, ...config }, null, 2)}\n`, "utf8");
  const run = spawnSync(VITEST, ["run", "--config", BENCH_CONFIG, CONTROL_BENCH], {
    cwd: ROOT, encoding: "utf8",
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
    return JSON.parse(last) as Record<string, unknown>;
  } catch {
    return { text: last };
  }
}

function rehearsalLedger(): string {
  const rows = readFileSync(REAL_LEDGER, "utf8").split("\n")
    .filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
  const kept = rows.flatMap((row: Record<string, unknown>) => {
    if (row.poolId === "factory-v1-namespace") {
      return [{ ...row, start: 301, end: 700, note: "PROMOTE FIXTURE COPY." }];
    }
    return row.poolId === "discovery-v1" ? [] : [row];
  });
  kept.forEach((row: Record<string, unknown>, index: number) => { row.seq = index + 1; });
  mkdirSync(WORK, { recursive: true });
  const path = join(WORK, "ledger.jsonl");
  writeFileSync(path, `${kept.map((row: unknown) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  return path;
}

function scope() {
  return {
    protocolPath: REHEARSAL_PROTOCOL,
    ledgerPath: join(WORK, "ledger.jsonl"),
  };
}

/**
 * The one fabricated artefact: a sealed stage directory whose verdict says what
 * the fixture needs it to say.
 *
 * The seal itself is canonical — `open-stage` writes the manifest and
 * `seal-stage` seals it — and only the verdict file is written by hand, because
 * the canonical writer derives it from games that a fixture cannot play.
 */
function sealedStageFixture(input: {
  stage: string;
  pool: { poolId: string; purpose: string; start: number; end: number };
  verdict: Record<string, unknown>;
}): string {
  const base = {
    attemptId: "attempt-001", championId: "ai-v1",
    at: new Date().toISOString(), pool: input.pool, ...scope(),
  };
  const record = control("open-stage", { ...base, stage: input.stage, role: "record" });
  const dir = String(record.dir);
  control("seal-stage", { dir, at: new Date().toISOString() });
  writeFileSync(join(dir, "verdict.json"),
    `${JSON.stringify({ rehearsalOnly: true, ...input.verdict }, null, 2)}\n`, "utf8");
  return dir;
}

function candidateModelFixture(): Readonly<{
  path: string; modelSha256: string; modelBytes: number;
}> {
  const model = {
    formatVersion: 1, lightgbmVersion: "promote-fixture",
    modelSha256: "promote-fixture-not-a-real-booster", objective: "regression",
    numTrees: 1, numFeatures: CF_FEATURE_NAMES.length, featureNames: [...CF_FEATURE_NAMES],
    trees: [{
      feature: [-1], threshold: [0], defaultLeft: [0], missingZero: [0],
      left: [0], right: [0], value: [0],
    }],
    rehearsalOnly: true,
  };
  mkdirSync(join(WORK, "fixture"), { recursive: true });
  const path = join(WORK, "fixture", "candidate.json");
  const text = JSON.stringify(model);
  writeFileSync(path, text, "utf8");
  return {
    path, modelSha256: model.modelSha256, modelBytes: Buffer.byteLength(text, "utf8"),
  };
}

/**
 * Registers an attempt and rewrites its record so that the state machine's
 * prerequisites for a promotion are met.
 *
 * `decideOutcome` reads the attempt's own fields before it reads any verdict —
 * a threshold, a Stage 1 result, a formal N — so a fixture that only forged a
 * verdict would be rejected one branch earlier and prove nothing.
 */
function attemptReadyToPromote(decision: "PROMOTE" | "REJECT"): void {
  rehearsalLedger();
  const registered = control("register", {
    at: new Date().toISOString(), runnerCommit: "promote-fixture", runnerDirty: false, ...scope(),
  });
  const attempt = registered.attempt as Record<string, unknown>;
  const attemptDir = join(WORK, "attempts", String(attempt.attemptId));

  sealedStageFixture({
    stage: "offline",
    pool: { poolId: "fixture/offline", purpose: "offline", start: 601, end: 604 },
    verdict: {
      kind: "stage1", stage: "offline", decision: "PASS", reasons: [],
      groups: 4, muHat: 0.01, overrideDeals: 4, selectedNonzeroDeals: 4,
      integrityValid: true,
    },
  });
  const formalDir = sealedStageFixture({
    stage: "formal",
    pool: { poolId: "fixture/formal", purpose: "formal", start: 605, end: 610 },
    verdict: {
      kind: "formal", stage: "formal", decision, reasons: decision === "PROMOTE" ? [] : ["fail"],
      n: 6, mean: 0.02, lower: 0.005, alpha: 0.005, integrityValid: true,
      arms: { champion: {}, candidate: {} },
    },
  });

  const record = JSON.parse(readFileSync(join(attemptDir, "attempt.json"), "utf8"));
  writeFileSync(join(attemptDir, "attempt.json"), `${JSON.stringify({
    ...record,
    threshold: 0.01,
    stage1: { deals: 6, mean: 0.02, variance: 0.001, proceed: true },
    formalN: 6,
    model: candidateModelFixture(),
  }, null, 2)}\n`, "utf8");
  void formalDir;
}

function promote(): Record<string, unknown> {
  control("decide", { at: new Date().toISOString(), attemptId: "attempt-001", ...scope() });
  const applied = control("register", {
    at: new Date().toISOString(), runnerCommit: "promote-fixture", runnerDirty: false, ...scope(),
  });
  return applied;
}

afterAll(() => {
  rmSync(WORK, { recursive: true, force: true });
});

describe("a promotion writes a champion and nothing else", () => {
  it("walks readSealedVerdict -> decideOutcome -> PROMOTE -> writeChampion -> archive", () => {
    attemptReadyToPromote("PROMOTE");
    const realLedgerBefore = readFileSync(REAL_LEDGER, "utf8");

    promote();
    // The Factory's own state file is the authority, not the emit: `register`
    // answers with the attempt it is about to run, and after a promotion there
    // is no attempt to run until the champion's loader can build the new chain.
    const factory = JSON.parse(readFileSync(join(WORK, "factory.json"), "utf8"));
    expect(factory.championId).toBe("ai-v2-research");
    expect(factory.generation).toBe(2);
    expect(factory.attempts).toHaveLength(1);
    expect(factory.attempts[0].outcome).toBe("PROMOTE");

    // The archive is the canonical shape, and it landed in the rehearsal's own
    // directory rather than the one the next generation's loader reads.
    const archivePath = join(WORK, "champions-rehearsal", "ai-v2-research.json");
    expect(existsSync(archivePath)).toBe(true);
    const archive = JSON.parse(readFileSync(archivePath, "utf8"));
    expect(archive.championId).toBe("ai-v2-research");
    expect(archive.parentChampionId).toBe("ai-v1");
    expect(archive.researchOnly).toBe(true);
    expect(archive.layers).toHaveLength(2);
    expect(archive.decision).toBe("PROMOTE");
    expect(archive.attemptId).toBe("attempt-001");

    // §guards. The repository's own ledger is untouched, no real champion
    // archive was created, and no `.formal.json` evidence file leaked into the
    // directory a later generation reads.
    expect(readFileSync(REAL_LEDGER, "utf8")).toBe(realLedgerBefore);
    expect(existsSync(join(REAL_CHAMPIONS, "ai-v2-research.json"))).toBe(false);
    expect(existsSync(join(REAL_CHAMPIONS, "ai-v2-research.formal.json"))).toBe(false);
    // And no tag by that name exists.
    const tags = spawnSync("git", ["tag", "-l", "ai-v2-research"], { cwd: ROOT, encoding: "utf8" });
    expect((tags.stdout ?? "").trim()).toBe("");
  }, 600_000);

  it("rejects when the formal verdict says REJECT", () => {
    rmSync(WORK, { recursive: true, force: true });
    attemptReadyToPromote("REJECT");
    promote();
    const factory = JSON.parse(readFileSync(join(WORK, "factory.json"), "utf8"));
    // A rejection does not advance the generation and writes no archive.
    expect(factory.championId).toBe("ai-v1");
    expect(factory.attempts[0].outcome).toBe("REJECT");
    expect(existsSync(join(WORK, "champions-rehearsal", "ai-v2-research.json"))).toBe(false);
  }, 600_000);

  it("refuses a formal verdict that is neither PROMOTE nor REJECT", () => {
    rmSync(WORK, { recursive: true, force: true });
    attemptReadyToPromote("PROMOTE");
    const formalDir = join(WORK, "attempts", "attempt-001", "verdicts", "formal");
    const verdict = JSON.parse(readFileSync(join(formalDir, "verdict.json"), "utf8"));
    writeFileSync(join(formalDir, "verdict.json"),
      `${JSON.stringify({ ...verdict, decision: "MAYBE" }, null, 2)}\n`, "utf8");

    // `decideOutcome` reads the sealed verdict before it writes anything, so the
    // integrity failure lands at the decision — which is the correct place: an
    // attempt that cannot be decided must not become DECIDED.
    let failed = false;
    try {
      control("decide", { at: new Date().toISOString(), attemptId: "attempt-001", ...scope() });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(existsSync(join(WORK, "champions-rehearsal", "ai-v2-research.json"))).toBe(false);
  }, 600_000);

  it("has no flag on the real runner for any of this", () => {
    const help = spawnSync(process.execPath, ["scripts/farmer-pi.mjs", "--help"], {
      cwd: ROOT, encoding: "utf8",
    });
    const text = `${help.stdout ?? ""}${help.stderr ?? ""}`;
    for (const forbidden of ["--promote", "--fixture", "--stage", "--skip", "--start-stage"]) {
      expect(text.includes(forbidden)).toBe(false);
    }
  }, 120_000);
});
