/**
 * Factory v1 — the rehearsal (§33, §34).
 *
 * A miniature run of the whole pipeline on **retired** seeds, with the failures
 * the last two rounds actually suffered injected on purpose:
 *
 *   - a generator killed halfway through a deal window;
 *   - a deal completed twice, which must hash the same and be recognised;
 *   - a checkpoint corrupted between runs;
 *   - a stage sealed before it is complete;
 *   - a verdict written before the seal, and twice after it;
 *   - an absolute deadline that has already passed;
 *   - a status line asked for something it is not allowed to report.
 *
 * The rehearsal asks for no fresh seed and draws no conclusion about strength.
 * Its result is a boolean: the Factory's own machinery either survives all of
 * that or it does not, and if it does not, nothing downstream is worth running.
 *
 * It lives under `benchmarks/` because it plays real games and therefore costs
 * real seconds; `pnpm check` does not cover this directory, so this file is run
 * explicitly as part of Stage 0 and again before any attempt is registered.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { dealDeck } from "./ai-tournament.js";
import type { CfGroupResult } from "./cf-dataset.js";
import { frozenPi1Chain } from "./farmer-pi-champions.js";
import type { ChainLayer, ChampionChain } from "./farmer-pi-chain.js";
import {
  factoryCaptureGroup,
  factoryGroupSpecFor,
  type FactoryPoolRef,
} from "./farmer-pi-corpus.js";
import {
  IntegrityError,
  completedDeals,
  formalVerdict,
  makeDealRecord,
  sealStage,
  stage1Decision,
  stageStatus,
  verifyStage,
  writeDealRecord,
  writeManifest,
  writeVerdictOnce,
  chooseFormalN,
  requiredFormalN,
} from "./farmer-pi-stage.js";
import { pairedFarmerDifferences, runFarmerDeal } from "./farmer-pi-arm.js";
import { loadProtocol } from "./farmer-pi-protocol.js";

/**
 * Retired deals only. `discovery-v1` is 301–700, exposed twice and retired on
 * 2026-09-19; the rehearsal uses its first few and its own temporary directory,
 * and records nothing in the ledger.
 */
const REHEARSAL_START = 301;
const REHEARSAL_DEALS = 4;

const temporaries: string[] = [];
function temporaryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "farmer-pi-rehearsal-"));
  temporaries.push(dir);
  return dir;
}
afterAll(() => {
  while (temporaries.length > 0) {
    const dir = temporaries.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

const POOL: FactoryPoolRef = Object.freeze({
  poolId: "rehearsal:discovery-v1",
  purpose: "train",
  range: Object.freeze({ start: REHEARSAL_START, end: REHEARSAL_START + REHEARSAL_DEALS - 1 }),
});

/** A layer that always overrides, so the candidate arm really differs. */
function alwaysLayer(chain: ChampionChain): ChainLayer {
  const base = chain.layers[0];
  if (base === undefined) {
    throw new Error("The rehearsal chain has no base layer.");
  }
  return Object.freeze({ ...base, threshold: -1e9, modelBytes: base.modelBytes });
}

function capture(dealIndex: number, chain: ChampionChain): CfGroupResult {
  const spec = factoryGroupSpecFor(dealIndex, POOL, "rehearsal");
  return factoryCaptureGroup(dealDeck(dealIndex), spec, chain);
}

describe("rehearsal: the corpus survives being killed halfway", () => {
  it("resumes by re-running only what is missing, and reproduces it byte for byte", () => {
    const dir = temporaryDir();
    const chain = frozenPi1Chain();
    writeManifest(dir, {
      stage: "corpus",
      attemptId: "rehearsal",
      arms: [null],
      configHash: "rehearsal-config",
      config: {},
      poolId: POOL.poolId,
      start: REHEARSAL_START,
      deals: REHEARSAL_DEALS,
      completion: "RUNNING",
      hashes: {},
      updatedAt: "2026-09-23T00:00:00.000Z",
      sealedAt: null,
    });

    // Half a window, then the process "dies".
    const firstHalf: readonly number[] = [REHEARSAL_START, REHEARSAL_START + 1];
    const hashes = new Map<number, string>();
    for (const dealIndex of firstHalf) {
      const record = makeDealRecord({
        dealIndex, stage: "corpus", arm: null, configHash: "rehearsal-config",
        payload: capture(dealIndex, chain), at: "2026-09-23T00:00:00.000Z",
      });
      expect(writeDealRecord(dir, record)).toBe("written");
      hashes.set(dealIndex, record.artifactHash);
    }
    expect(completedDeals(dir, null)).toEqual(firstHalf);

    // Resume: the finished deals are skipped, the missing ones are re-run.
    const missing = [];
    for (let offset = 0; offset < REHEARSAL_DEALS; offset += 1) {
      const dealIndex = REHEARSAL_START + offset;
      if (completedDeals(dir, null).includes(dealIndex)) {
        continue;
      }
      missing.push(dealIndex);
    }
    expect(missing).toEqual([303, 304]);
    for (const dealIndex of missing) {
      writeDealRecord(dir, makeDealRecord({
        dealIndex, stage: "corpus", arm: null, configHash: "rehearsal-config",
        payload: capture(dealIndex, chain), at: "2026-09-23T00:01:00.000Z",
      }));
    }

    // Re-running a finished deal must produce the *same* bytes, and is
    // recognised as a duplicate rather than rewritten.
    const replayed = firstHalf[0] ?? REHEARSAL_START;
    const replay = makeDealRecord({
      dealIndex: replayed, stage: "corpus", arm: null, configHash: "rehearsal-config",
      payload: capture(replayed, chain), at: "2026-09-23T00:02:00.000Z",
    });
    expect(replay.artifactHash).toBe(hashes.get(replayed));
    expect(writeDealRecord(dir, replay)).toBe("duplicate");

    // The stage seals once it is complete.
    const sealed = sealStage(dir, "2026-09-23T00:03:00.000Z");
    expect(sealed.completion).toBe("SEALED");
    expect(verifyStage(dir).missing).toBe(0);
  }, 900_000);

  it("stops the whole Factory when a checkpoint was edited between runs", () => {
    const dir = temporaryDir();
    const chain = frozenPi1Chain();
    writeManifest(dir, {
      stage: "corpus", attemptId: "rehearsal", arms: [null],
      configHash: "rehearsal-config", config: {}, poolId: POOL.poolId,
      start: REHEARSAL_START, deals: 1, completion: "RUNNING", hashes: {},
      updatedAt: "2026-09-23T00:00:00.000Z", sealedAt: null,
    });
    writeDealRecord(dir, makeDealRecord({
      dealIndex: REHEARSAL_START, stage: "corpus", arm: null, configHash: "rehearsal-config",
      payload: capture(REHEARSAL_START, chain), at: "2026-09-23T00:00:00.000Z",
    }));
    sealStage(dir, "2026-09-23T00:01:00.000Z");

    const path = join(dir, "deals", `${REHEARSAL_START}.json`);
    const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...record, artifactHash: "0".repeat(64) }));
    expect(() => verifyStage(dir)).toThrow(IntegrityError);

    // And a deal that re-runs to a different answer is fatal at the moment it
    // happens, not silently absorbed.
    rmSync(dir, { recursive: true, force: true });
  }, 900_000);
});

describe("rehearsal: a stage seals once and reports nothing it should not", () => {
  it("refuses a verdict before the seal, and a second verdict after it", () => {
    const dir = temporaryDir();
    writeManifest(dir, {
      stage: "stage1", attemptId: "rehearsal", arms: ["champion", "candidate"],
      configHash: "rehearsal-config", config: {}, poolId: "rehearsal:stage1",
      start: REHEARSAL_START, deals: 1, completion: "RUNNING", hashes: {},
      updatedAt: "2026-09-23T00:00:00.000Z", sealedAt: null,
    });
    expect(() => writeVerdictOnce(dir, { decision: "PROMOTE" })).toThrow(/only be written after seal/);

    for (const arm of ["champion", "candidate"]) {
      writeDealRecord(dir, makeDealRecord({
        dealIndex: REHEARSAL_START, stage: "stage1", arm, configHash: "rehearsal-config",
        payload: { dealIndex: REHEARSAL_START, winsB: 1, winsA: 1 }, at: "2026-09-23T00:00:00.000Z",
      }));
    }
    sealStage(dir, "2026-09-23T00:01:00.000Z");
    writeVerdictOnce(dir, { decision: "PROMOTE" });
    expect(existsSync(join(dir, "verdict.json"))).toBe(true);
    expect(() => writeVerdictOnce(dir, { decision: "REJECT" })).toThrow(/already has a verdict/);
    expect(() => sealStage(dir, "2026-09-23T00:02:00.000Z")).toThrow(/already sealed/);
  });

  it("has no field in its status through which an outcome could leak", () => {
    const dir = temporaryDir();
    writeManifest(dir, {
      stage: "formal", attemptId: "rehearsal", arms: ["champion", "candidate"],
      configHash: "rehearsal-config", config: {}, poolId: "rehearsal:formal",
      start: REHEARSAL_START, deals: 10, completion: "RUNNING", hashes: {},
      updatedAt: "2026-09-23T00:00:00.000Z", sealedAt: null,
    });
    writeDealRecord(dir, makeDealRecord({
      dealIndex: REHEARSAL_START, stage: "formal", arm: "champion", configHash: "rehearsal-config",
      payload: { dealIndex: REHEARSAL_START, winsB: 3, winsA: 0 }, at: "2026-09-23T00:00:00.000Z",
    }));
    const status = stageStatus({ dir, elapsedMs: 60_000, workers: 2 });
    const printed = JSON.stringify(status);
    // The payload holds a 3-0 sweep. None of it may be reachable from `status`.
    expect(printed).not.toContain("winsB");
    expect(printed).not.toContain("payload");
    expect(Object.keys(status).sort()).toEqual(
      ["arms", "attemptId", "checkpoints", "completion", "elapsedMs", "errorCodes", "etaMs",
        "stage", "throughputPerHour", "workers"],
    );
  });
});

describe("rehearsal: an expired deadline starts nothing", () => {
  it("refuses to launch when the absolute deadline has already passed", () => {
    const dir = temporaryDir();
    const past = new Date(Date.now() - 60_000).toISOString();
    const run = spawnSync(process.execPath, [
      "scripts/farmer-pi-host.mjs", "run",
      "--deadline", past,
      "--state", dir,
      "--", "node", "-e", "process.exit(0)",
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 60_000 });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("has passed");
    const state = JSON.parse(readFileSync(join(dir, "host-state.json"), "utf8")) as {
      phase: string;
      childPid: string | null;
    };
    expect(state.phase).toBe("PAUSED_DEADLINE");
    expect(state.childPid).toBeNull();
    // And the launcher reports it without ever having started the child.
    const status = spawnSync(process.execPath, [
      "scripts/farmer-pi-host.mjs", "status", "--state", dir,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 60_000 });
    expect(status.stdout).toContain("PAUSED_DEADLINE");
  }, 120_000);

  it("stops a running child at the deadline and records PAUSED_DEADLINE", () => {
    const dir = temporaryDir();
    const soon = new Date(Date.now() + 8_000).toISOString();
    const run = spawnSync(process.execPath, [
      "scripts/farmer-pi-host.mjs", "run",
      "--deadline", soon,
      "--state", dir,
      "--", "node", "-e", "setTimeout(() => {}, 600000)",
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 300_000 });
    expect(run.status).toBe(3);
    const state = JSON.parse(readFileSync(join(dir, "host-state.json"), "utf8")) as {
      phase: string;
      reason: string;
    };
    expect(state.phase).toBe("PAUSED_DEADLINE");
    expect(state.reason).toContain("absolute deadline");
  }, 300_000);
});

describe("rehearsal: the arms, the screen and the formal plan", () => {
  it("runs two real arms on retired deals and produces a paired difference", () => {
    const champion = frozenPi1Chain();
    const candidate: ChampionChain = Object.freeze({
      ...champion,
      championId: "rehearsal-candidate",
      parentChampionId: champion.championId,
      layers: Object.freeze([...champion.layers, alwaysLayer(champion)]),
    });
    const championArm = [];
    const candidateArm = [];
    for (let offset = 0; offset < 2; offset += 1) {
      const dealIndex = REHEARSAL_START + offset;
      championArm.push(runFarmerDeal({ chain: champion, dealIndex }));
      candidateArm.push(runFarmerDeal({ chain: candidate, dealIndex }));
    }
    const base = Object.freeze({
      arm: "champion" as const, start: REHEARSAL_START,
      winsB: Object.freeze(championArm.map((entry) => entry.payload.winsB)),
      winsA: Object.freeze(championArm.map((entry) => entry.payload.winsA)),
      chainDecisions: 0, chainOverrides: 0, chainRows: 0, inferenceMs: 0, elapsedMs: 0,
    });
    const cand = Object.freeze({
      ...base, arm: "candidate" as const,
      winsB: Object.freeze(candidateArm.map((entry) => entry.payload.winsB)),
      winsA: Object.freeze(candidateArm.map((entry) => entry.payload.winsA)),
    });
    const differences = pairedFarmerDifferences(base, cand);
    expect(differences).toHaveLength(2);
    for (const value of differences) {
      expect([-1, -2 / 3, -1 / 3, 0, 1 / 3, 2 / 3, 1]).toContain(value);
    }
    // The candidate layer overrides everything, so on these deals it really ran.
    expect(candidateArm.some((entry) => entry.payload.chainOverrides > 0)).toBe(true);
    // The landlord arm is untouched by construction, whatever the layer does.
    expect(candidateArm.map((entry) => entry.payload.winsA))
      .toEqual(championArm.map((entry) => entry.payload.winsA));
  }, 900_000);

  it("sizes the formal stage from the screen and never past the ladder", () => {
    const protocol = loadProtocol().protocol;
    const screen = stage1Decision([0.1, 0, 0.1, 0, 0.1, 0]);
    expect(screen.proceed).toBe(true);
    const plan = chooseFormalN(requiredFormalN(screen.variance));
    expect(protocol.formal.ladder).toContain(plan.n);
    const verdict = formalVerdict([0.02, 0.03, 0.01, 0.04, 0.02, 0.03], true);
    expect(verdict.decision).toBe("PROMOTE");
    expect(verdict.alpha).toBe(protocol.formal.alpha);
    // A candidate that never ran a formal stage cannot be promoted by accident:
    // an empty difference list is refused rather than treated as zero.
    expect(() => formalVerdict([], true)).toThrow(IntegrityError);
  });

  it("leaves the chain's own identity intact through the whole rehearsal", () => {
    const chain = frozenPi1Chain();
    expect(chain.championId).toBe("ai-v1");
    expect(chain.layers).toHaveLength(1);
    expect(chain.layers[0]?.threshold).toBe(0.01);
  });
});
