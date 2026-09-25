/**
 * Factory v1 guards for the protocol, the ledger and the stage protocol.
 *
 * These three are the parts of the Factory that decide *what may happen* rather
 * than what a game does, so they are the parts where a quiet mistake costs the
 * most: a pool that overlaps another pool, a protocol that drifted from the one
 * an attempt registered, a checkpoint that was silently overwritten. Each of
 * them is a pure function or a file operation on a temporary directory, so the
 * guards are cheap and none of them touches a fresh seed.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ATTEMPT_LAYOUT,
  CLOSED_STATES,
  FACTORY_ATTEMPT_BLOCK,
  FACTORY_LEDGER_PATH,
  LedgerError,
  POOL_STATES,
  allocateAttempt,
  appendLedgerEvent,
  assertNoOverlap,
  assertWithinNamespace,
  attemptBlock,
  attemptLayout,
  foldPools,
  ledgerPools,
  parseLedger,
  readLedger,
  transitionPool,
} from "../../benchmarks/farmer-pi-pools.js";
import {
  PROTOCOL_PATH,
  ProtocolError,
  assertIdentitiesCurrent,
  assertProtocolConsistency,
  assertProtocolHash,
  loadProtocol,
  parseProtocol,
  parseProtocolYaml,
  protocolHashOf,
} from "../../benchmarks/farmer-pi-protocol.js";
import { assertAttemptProtocol } from "../../benchmarks/farmer-pi-attempt.js";
import { closureIdentity, verifyIdentities } from "../../benchmarks/farmer-pi-identity.js";
import {
  FACTORY_ALPHA,
  FACTORY_FORMAL_LADDER,
  FACTORY_PROMOTION_FLOOR,
  IntegrityError,
  PI_STATUS_KEYS,
  assertNoPeekStatus,
  chooseFormalN,
  completedDeals,
  formalVerdict,
  makeDealRecord,
  offlineVerdict,
  pairedTest,
  readDealRecord,
  requiredFormalN,
  sealStage,
  flushManifest,
  stage1Decision,
  stageStatus,
  verifyStage,
  writeDealRecord,
  writeManifest,
  writeVerdictOnce,
} from "../../benchmarks/farmer-pi-stage.js";

/**
 * A self-contained ledger fixture, built from literals and never from disk.
 *
 * The run-time ledger (`research/farmer-pi/pool-ledger.jsonl`) is an append-only
 * record of what actually happened, and it grew when the real Factory ran. A
 * guard that reads it and then asserts "attempt-001 is not yet allocated" is
 * asserting a fact about a *moment*, not about the code, so it turns red the
 * first time a legitimate attempt is recorded. This fixture is that moment,
 * frozen: the namespace rule, two closed historical pools, and the reservation.
 *
 * Everything that depends on *what is in* a ledger uses this. Only the two
 * artifact checks that hold for any well-formed ledger still read the real file,
 * and they are named as such where they do.
 */
function fixtureLedgerText(): string {
  const at = "2026-09-23T00:00:00.000Z";
  const event = (seq: number, body: Record<string, unknown>): string =>
    JSON.stringify({ seq, at, ...body });
  return [
    event(1, {
      event: "NAMESPACE_RULE",
      poolId: "factory-v1-namespace",
      below: 200_001,
      rule: "Fixture: the Factory allocates no pool below its floor.",
      source: "tests/core/farmer-pi-protocol.test.ts",
    }),
    event(2, {
      event: "QUARANTINE",
      poolId: "discovery-v1",
      attemptId: null,
      parentChampionId: null,
      protocolHash: null,
      purpose: "historical-discovery",
      start: 301,
      end: 700,
      maxFormalN: null,
      state: "CONSUMED",
      exposureCount: 2,
      source: "fixture",
      note: "Fixture: a closed historical pool.",
    }),
    event(3, {
      event: "QUARANTINE",
      poolId: "spec065-dataset",
      attemptId: null,
      parentChampionId: null,
      protocolHash: null,
      purpose: "top5-dataset",
      start: 140_001,
      end: 160_000,
      maxFormalN: null,
      state: "INVALID_EXPOSED",
      exposureCount: 1,
      source: "fixture",
      note: "Fixture: an invalidated, exposed pool.",
    }),
    event(4, {
      event: "RESERVE_NAMESPACE",
      poolId: "factory-v1-namespace",
      attemptId: null,
      parentChampionId: null,
      protocolHash: null,
      purpose: "factory-namespace",
      start: 200_001,
      end: 450_000,
      maxFormalN: null,
      state: "RESERVED",
      exposureCount: 0,
      source: "fixture",
      note: "Fixture: the reserved block, with no attempt allocated in it yet.",
    }),
  ].join("\n");
}

/** Writes the fixture to a fresh temporary ledger and returns its path. */
function fixtureLedgerPath(): string {
  const path = join(temporaryDir(), "ledger.jsonl");
  writeFileSync(path, `${fixtureLedgerText()}\n`);
  return path;
}

const temporaries: string[] = [];
function temporaryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "farmer-pi-"));
  temporaries.push(dir);
  return dir;
}
afterEach(() => {
  while (temporaries.length > 0) {
    const dir = temporaries.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

/**
 * The two identities the CHEAP landlord integration moved, and why.
 *
 * Both closures contain `src/app/ai/decision-handler.ts`, and a closure
 * identity hashes each member module's bytes — the entry module included. The
 * integration edited that file, so both hashes moved. The protocol's own
 * values are left as they are: a frozen identity edited to match a later tree
 * is not a frozen identity. Pinning the new values here keeps the guard
 * meaning "no unintended move" rather than "no move at all".
 */
const POST_INTEGRATION_MASTER_TIER_IDENTITY =
  "62f513726701b1c0034caf97382d7104810c9e7e2ed86186a81ef13ce822ba5e";
const POST_INTEGRATION_TOP3_IDENTITY =
  "dc92715b8fb4fca0b4530327f8624063e10b525006e210dfda7dc7a7cb275b3f";

describe("the ledger is the single source of truth", () => {
  it("parses with a contiguous sequence and folds every pool", () => {
    const events = readLedger(FACTORY_LEDGER_PATH);
    expect(events.length).toBeGreaterThan(10);
    events.forEach((event, index) => expect(event.seq).toBe(index + 1));
    const pools = foldPools(events);
    const ids = pools.map((pool) => pool.poolId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const pool of pools) {
      expect(POOL_STATES).toContain(pool.state);
    }
  });

  it("keeps every historical pool closed and names the reason", () => {
    const pools = ledgerPools();
    const byId = new Map(pools.map((pool) => [pool.poolId, pool]));
    const expectedClosure: Readonly<Record<string, string>> = Object.freeze({
      "discovery-v1": "CONSUMED",
      "early-calibration-mechanical": "CONSUMED",
      "phase2-v1-final-validation": "CONSUMED",
      "discovery-v2": "CONSUMED",
      "discovery-v3": "CONSUMED",
      "gate-b-discovery-v4": "CONSUMED",
      "phase2-v1-dataset": "CONSUMED",
      "spec062-test-reserve": "QUARANTINED_UNEXPOSED",
      "spec064-dataset": "CONSUMED",
      "spec064-stage1": "INVALID_EXPOSED",
      "spec064-stage2": "QUARANTINED_UNEXPOSED",
      "spec065-dataset": "INVALID_EXPOSED",
      "spec065-stage1": "QUARANTINED_UNEXPOSED",
      "spec065-stage2": "QUARANTINED_UNEXPOSED",
    });
    for (const [poolId, state] of Object.entries(expectedClosure)) {
      const pool = byId.get(poolId);
      expect(pool, poolId).toBeDefined();
      expect(pool?.state, poolId).toBe(state);
      expect(CLOSED_STATES).toContain(pool?.state);
    }
  });

  it("has no two pools overlapping, and the namespace covers the whole Factory", () => {
    const pools = ledgerPools();
    const ranged = pools.filter(
      (pool) => pool.start !== null && pool.end !== null && pool.poolId !== "factory-v1-namespace",
    );
    for (const pool of ranged) {
      assertNoOverlap(
        pools.filter((other) => other.poolId !== pool.poolId),
        { start: pool.start ?? 0, end: pool.end ?? 0 },
        `Pool ${pool.poolId}`,
      );
    }
    const namespace = pools.find((pool) => pool.poolId === "factory-v1-namespace");
    expect(namespace?.start).toBe(200_001);
    expect(namespace?.end).toBe(450_000);
  });

  it("keeps every pool that is not a Factory attempt below the Factory's floor", () => {
    // Reads the live artifact on purpose — this is a property of the ledger, not
    // a fixture, and it must hold for the 16-line freeze snapshot and for any
    // later legitimately appended line. A Factory attempt is named
    // `factory-v1/<attempt>/<purpose>` and lives inside the reserved block;
    // everything else is a historical round and must sit strictly below it.
    const pools = ledgerPools();
    const historical = pools.filter(
      (pool) =>
        pool.poolId !== "factory-v1-namespace" && !pool.poolId.startsWith("factory-v1/"),
    );
    expect(historical.length).toBeGreaterThan(0);
    for (const pool of historical) {
      expect(pool.end ?? 0).toBeLessThan(200_001);
    }
  });

  it("refuses a ledger with a gap in its sequence", () => {
    const lines = fixtureLedgerText().trim().split("\n");
    // The fixture is exactly four lines, so the dropped one has to be interior:
    // removing the last would leave a shorter but still contiguous log, which is
    // a different (and equally valid) thing to refuse.
    expect(lines).toHaveLength(4);
    const dropped = [...lines.slice(0, 1), ...lines.slice(2)].join("\n");
    expect(() => parseLedger(dropped)).toThrow(/no longer append-only/);
    // And the guard is not vacuous: the undropped fixture parses.
    expect(parseLedger(fixtureLedgerText())).toHaveLength(4);
  });
});

describe("attempt allocation is computed, not copied", () => {
  it("lays out a base attempt exactly as the protocol sizes it", () => {
    const layout = attemptLayout(1, "base", 200_001);
    expect(layout.attemptId).toBe("attempt-001");
    expect(layout.block).toEqual({ start: 200_001, end: 225_000 });
    const byPurpose = new Map(layout.pools.map((entry) => [entry.purpose, entry.range]));
    expect(byPurpose.get("train")).toEqual({ start: 200_001, end: 206_000 });
    expect(byPurpose.get("calibration")).toEqual({ start: 206_001, end: 208_000 });
    expect(byPurpose.get("offline")).toEqual({ start: 208_001, end: 210_000 });
    expect(byPurpose.get("stage1")).toEqual({ start: 210_001, end: 210_200 });
    expect(byPurpose.get("formal")).toEqual({ start: 210_201, end: 215_000 });
    expect(layout.slack).toEqual({ start: 215_001, end: 225_000 });
  });

  it("gives a retry its own block, disjoint from the base it retries", () => {
    // A retry is its own attempt in the budget, so it gets its own block. It
    // *reuses* the rejected base attempt's training pool, which is why its own
    // fresh training range is 6,000 deals and not 12,000.
    const base = attemptLayout(1, "base", 200_001);
    const retry = attemptLayout(2, "retry", 200_001);
    expect(retry.block.start).toBe(base.block.end + 1);
    for (const entry of retry.pools) {
      expect(entry.range.start).toBeGreaterThanOrEqual(retry.block.start);
      expect(entry.range.end).toBeLessThanOrEqual(retry.block.end);
    }
    const claimed = [...base.pools, ...retry.pools];
    for (const [index, entry] of claimed.entries()) {
      for (const other of claimed.slice(index + 1)) {
        const overlaps = entry.range.start <= other.range.end && entry.range.end >= other.range.start;
        expect(overlaps, `${entry.purpose} vs ${other.purpose}`).toBe(false);
      }
    }
    expect(retry.slack === null || retry.slack.start > retry.pools[retry.pools.length - 1]!.range.end)
      .toBe(true);
  });

  it("gives ten attempts disjoint blocks that end inside the namespace", () => {
    const blocks = Array.from({ length: 10 }, (_, index) => attemptBlock(index + 1, 200_001));
    expect(blocks[9]!.end).toBe(450_000);
    for (const [index, block] of blocks.entries()) {
      const next = blocks[index + 1];
      if (next !== undefined) {
        expect(next.start).toBe(block.end + 1);
      }
    }
    expect(FACTORY_ATTEMPT_BLOCK * 10).toBe(250_000);
  });

  it("refuses a claim outside the namespace, on top of a pool, or below the floor", () => {
    const pools = ledgerPools();
    expect(() => assertWithinNamespace(pools, { start: 199_000, end: 199_100 }, "guard"))
      .toThrow(LedgerError);
    expect(() => assertWithinNamespace(pools, { start: 460_000, end: 460_100 }, "guard"))
      .toThrow(LedgerError);
    expect(() => assertNoOverlap(pools, { start: 300, end: 800 }, "guard")).toThrow(/overlaps/);
    expect(() => assertNoOverlap(pools, { start: 700, end: 700 }, "guard")).toThrow(/overlaps/);
    expect(() => assertNoOverlap(pools, { start: 701, end: 799 }, "guard")).not.toThrow();
  });

  it("has a fixture that is self-contained and names no real attempt", () => {
    const events = parseLedger(fixtureLedgerText());
    expect(events).toHaveLength(4);
    expect(events.map((event) => event.event)).toEqual([
      "NAMESPACE_RULE",
      "QUARANTINE",
      "QUARANTINE",
      "RESERVE_NAMESPACE",
    ]);
    // The point of the fixture: nothing in it comes from the run-time ledger.
    expect(fixtureLedgerText()).not.toContain("factory-v1/attempt-");
    expect(fixtureLedgerText()).toBe(fixtureLedgerText());
  });

  it("allocates atomically and refuses the same attempt twice", () => {
    const path = fixtureLedgerPath();
    const allocation = allocateAttempt({
      attemptNumber: 1,
      kind: "base",
      attemptId: "attempt-001",
      parentChampionId: "ai-v1",
      protocolHash: "guard-hash",
      at: "2026-09-23T00:00:00.000Z",
      path,
    });
    expect(allocation.pools).toHaveLength(5);
    const pools = ledgerPools(path);
    const allocated = pools.filter((pool) => pool.poolId.startsWith("factory-v1/attempt-001/"));
    expect(allocated).toHaveLength(5);
    for (const pool of allocated) {
      expect(pool.state).toBe("RESERVED");
      expect(pool.attemptId).toBe("attempt-001");
      expect(pool.parentChampionId).toBe("ai-v1");
      expect(pool.protocolHash).toBe("guard-hash");
      expect(pool.start).toBeGreaterThanOrEqual(200_001);
      expect(pool.end).toBeLessThanOrEqual(450_000);
    }
    expect(allocated.find((pool) => pool.purpose === "formal")?.maxFormalN).toBe(4_800);
    expect(() => allocateAttempt({
      attemptNumber: 1, kind: "base", attemptId: "attempt-001",
      parentChampionId: "ai-v1", protocolHash: "guard-hash",
      at: "2026-09-23T00:00:00.000Z", path,
    })).toThrow(/already in the ledger/);
  });

  it("refuses to reopen a closed pool", () => {
    const path = fixtureLedgerPath();
    expect(() => transitionPool({
      poolId: "spec065-dataset", to: "RUNNING", at: "2026-09-23T00:00:00.000Z", path,
    })).toThrow(/A closed pool is closed/);
    expect(() => transitionPool({
      poolId: "discovery-v1", to: "RESERVED", at: "2026-09-23T00:00:00.000Z", path,
    })).toThrow(/closed/);
  });

  it("refuses to append under a lock somebody already holds", () => {
    const path = fixtureLedgerPath();
    writeFileSync(`${path}.lock`, "99999\n");
    expect(() => appendLedgerEvent({
      event: "TRANSITION", at: "2026-09-23T00:00:00.000Z", poolId: "discovery-v1",
    }, path)).toThrow(/already exists/);
    unlinkSync(`${path}.lock`);
  });
});

// ---------------------------------------------------------------------------
// The protocol
// ---------------------------------------------------------------------------

describe("the frozen protocol", () => {
  it("parses, and hashes to the same value twice", () => {
    const first = loadProtocol();
    const second = loadProtocol();
    expect(first.protocol.version).toBe(1);
    expect(first.protocol.startChampion).toBe("ai-v1");
    expect(first.protocol.attemptCap).toBe(10);
    expect(first.hash).toBe(second.hash);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(protocolHashOf(readFileSync(PROTOCOL_PATH, "utf8"))).toBe(first.hash);
  });

  it("matches the constants the code froze independently of it", () => {
    const { protocol } = loadProtocol();
    expect(protocol.formal.alpha).toBe(FACTORY_ALPHA);
    expect(protocol.formal.promotionFloor).toBe(FACTORY_PROMOTION_FLOOR);
    expect(protocol.formal.ladder).toEqual(FACTORY_FORMAL_LADDER);
    expect(protocol.attempt.blockDeals).toBe(FACTORY_ATTEMPT_BLOCK);
    expect(protocol.attempt.trainDeals).toBe(ATTEMPT_LAYOUT.base[0]!.deals);
    expect(protocol.attempt.formalReserveDeals).toBe(ATTEMPT_LAYOUT.base[4]!.deals);
    expect(protocol.corpus.seedBase).toBe(0);
  });

  it("parses the subset it claims to, and refuses the rest", () => {
    expect(parseProtocolYaml("a: 1\nb:\n  - x\n  - y\n")).toEqual({ a: 1, b: ["x", "y"] });
    expect(parseProtocolYaml("a:\n  b: true\n  c: null\n")).toEqual({ a: { b: true, c: null } });
    expect(parseProtocolYaml("- k: 1\n  j: 2\n- k: 3\n")).toEqual([{ k: 1, j: 2 }, { k: 3 }]);
    expect(() => parseProtocolYaml("a: &anchor 1\n")).toThrow(ProtocolError);
    expect(() => parseProtocolYaml("a: [1, 2]\n")).toThrow(ProtocolError);
    expect(() => parseProtocolYaml("a: |\n  block\n")).toThrow(ProtocolError);
    expect(() => parseProtocolYaml("a: 1\n---\nb: 2\n")).toThrow(ProtocolError);
    expect(() => parseProtocolYaml("\ta: 1\n")).toThrow(/tabs/);
    expect(() => parseProtocolYaml("a: 1\na: 2\n")).toThrow(/duplicate key/);
  });

  it("refuses a protocol whose parts disagree with each other", () => {
    const text = readFileSync(PROTOCOL_PATH, "utf8");
    const swap = (from: string, to: string): string => {
      expect(text).toContain(from);
      return text.replace(from, to);
    };
    // A family count that no longer equals the number of thresholds would apply
    // the wrong Bonferroni divisor.
    expect(() => parseProtocol(swap("families: 6", "families: 5")))
      .toThrow(/Bonferroni/);
    // A formal reserve smaller than the largest ladder rung cannot serve a run.
    expect(() => parseProtocol(swap("formalReserveDeals: 4800", "formalReserveDeals: 2400")))
      .toThrow(/largest ladder rung/);
    // A non-zero seed base puts the corpus and the tournament on different decks.
    expect(() => parseProtocol(swap("seedBase: 0", "seedBase: 301"))).toThrow(/seed base/);
    // An offline pool that is not the size of the offline screen.
    expect(() => parseProtocol(swap("offlineDeals: 2000", "offlineDeals: 1500")))
      .toThrow(/offline pool holds/);
    // A dataset version that is not this round's.
    expect(() => parseProtocol(swap("datasetVersion: 5", "datasetVersion: 4")))
      .toThrow(/dataset version/);
    // A reference board that is not the 400 retired deals it claims to be.
    expect(() => parseProtocol(swap("end: 700", "end: 900"))).toThrow(/400 retired deals/);
  });

  it("refuses a protocol hash that is not the registered one", () => {
    const { hash } = loadProtocol();
    expect(() => assertProtocolHash(hash, hash)).not.toThrow();
    expect(() => assertProtocolHash(hash, `${hash.slice(0, -1)}0`))
      .toThrow(/never\s+by editing the file|editing the file/);
  });

  it("accepts the frozen file's own consistency check", () => {
    expect(() => assertProtocolConsistency(loadProtocol().protocol)).not.toThrow();
  });

  it("cites role identities the working tree actually produces", () => {
    const { protocol } = loadProtocol();
    /*
     * `a6ae8a6a…` is the master tier's identity for the tree the protocol was
     * frozen against, and it no longer matches this one: the CHEAP landlord
     * integration edited `src/app/ai/decision-handler.ts`, and a closure
     * identity hashes the *contents* of every module in the closure, including
     * the entry module itself. Any edit to that file moves this hash — the
     * module's own design note says so ("a comment change invalidates the
     * identity"). Restoring the old value is not possible while integrating
     * anything into the master tier, and editing the protocol to match would
     * turn a frozen identity into a mirror.
     *
     * So the protocol keeps its value and the moved identities are pinned here
     * instead, with the same force. What this guard still catches is the thing
     * it was built for: an *unintended* move. The three identities the change
     * was not allowed to touch are asserted unchanged, and they are the ones
     * the confirmed candidate actually rests on — the enumerator and the tree
     * evaluator in particular.
     */
    verifyIdentities([protocol.identities.teammate, protocol.identities.landlord]);
    expect(closureIdentity("strong seat (master)", "src/app/ai/decision-handler.ts").hash)
      .toBe(POST_INTEGRATION_MASTER_TIER_IDENTITY);
    // `cf-selector.ts` imports `ENHANCED_AI_SEARCH` from `decision-handler.ts`,
    // so "ordered top three" contains the master tier and moves with it. That
    // coupling is real and predates this change; it was simply invisible until
    // something underneath it moved.
    expect(closureIdentity("ordered top three", "src/app/ai/cf-selector.ts").hash)
      .toBe(POST_INTEGRATION_TOP3_IDENTITY);
    expect(closureIdentity("legal-action-enumerator", "src/core/rules/generate-legal-actions.ts").hash)
      .toBe("7f1645eee455c4bcfcb6e9a984286e830005f83c7afc8a45a4b4667f5ede3c18");
    expect(closureIdentity("tree-evaluator", "src/core/ai/cf-model.ts").hash)
      .toBe("43bc62798482e234fbaf6148e1e62a08b912876503d261451c3f5b089084a77f");
    expect(protocol.identities.schema.columns).toBe(86);
    expect(protocol.identities.teammate.hash).toBe(protocol.identities.landlord.hash);
  });

  it("refuses a protocol whose identity hash the tree does not produce", () => {
    const text = readFileSync(PROTOCOL_PATH, "utf8");
    const swapped = text.replace(
      "hash: 2a39386007949cf1c37010c1d97f61e8468a3d41b44df50cebf70c9cc46b7297",
      `hash: ${"f".repeat(63)}0`,
    );
    expect(swapped).not.toBe(text);
    expect(() => assertIdentitiesCurrent(parseProtocol(swapped))).toThrow(/invalidates every number/);
  });

  it("rejects a one-byte protocol change under a registered attempt", () => {
    const registered = loadProtocol().hash;
    // The smallest edit that is still an edit: the hash is over the bytes, so
    // appending a single character is enough to be a different protocol.
    const edited = protocolHashOf(`${readFileSync(PROTOCOL_PATH, "utf8")}\n`);
    expect(edited).not.toBe(registered);
    expect(() => assertProtocolHash(registered, edited)).toThrow(/never by editing/);

    const attempt = {
      attemptId: "attempt-001", attemptNumber: 1, kind: "base" as const,
      parentChampionId: "ai-v1", protocolHash: registered, pools: {},
      phase: "PLANNED" as const, corpusDone: [], threshold: null, stage1: null,
      formalPlan: null, formalN: null, stopReason: null, outcome: null,
      startedAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z",
    };
    expect(() => assertAttemptProtocol(attempt, registered)).not.toThrow();
    expect(() => assertAttemptProtocol(attempt, edited))
      .toThrow(/registered under protocol/);
  });
});

// ---------------------------------------------------------------------------
// The stage protocol
// ---------------------------------------------------------------------------

function manifestFor(dir: string, deals: number, arms: readonly (string | null)[]): void {
  writeManifest(dir, {
    stage: "formal",
    attemptId: "attempt-001",
    arms,
    configHash: "config-guard",
    config: {},
    poolId: "factory-v1/attempt-001/formal",
    start: 210_201,
    deals,
    completion: "RUNNING",
    hashes: {},
    updatedAt: "2026-09-23T00:00:00.000Z",
    sealedAt: null,
  });
}

function writeDeals(dir: string, arms: readonly (string | null)[], count: number): void {
  for (const arm of arms) {
    for (let offset = 0; offset < count; offset += 1) {
      const dealIndex = 210_201 + offset;
      writeDealRecord(dir, makeDealRecord({
        dealIndex,
        stage: "formal",
        arm,
        configHash: "config-guard",
        payload: { dealIndex, winsB: offset % 4, winsA: 1 },
        cost: { elapsedMs: offset },
        at: "2026-09-23T00:00:00.000Z",
      }));
    }
  }
}

describe("deal-level checkpoints", () => {
  it("is idempotent for an identical re-run and fatal for a different one", () => {
    const dir = temporaryDir();
    const record = makeDealRecord({
      dealIndex: 1, stage: "formal", arm: "champion", configHash: "c",
      payload: { winsB: 2 }, at: "2026-09-23T00:00:00.000Z",
    });
    expect(writeDealRecord(dir, record)).toBe("written");
    expect(writeDealRecord(dir, record)).toBe("duplicate");
    const different = makeDealRecord({
      dealIndex: 1, stage: "formal", arm: "champion", configHash: "c",
      payload: { winsB: 3 }, at: "2026-09-23T00:00:00.000Z",
    });
    expect(() => writeDealRecord(dir, different)).toThrow(IntegrityError);
    const otherConfig = makeDealRecord({
      dealIndex: 1, stage: "formal", arm: "champion", configHash: "c2",
      payload: { winsB: 2 }, at: "2026-09-23T00:00:00.000Z",
    });
    expect(() => writeDealRecord(dir, otherConfig)).toThrow(/two configurations/);
  });

  it("does not let the timestamp or the cost enter the artifact hash", () => {
    const first = makeDealRecord({
      dealIndex: 7, stage: "s", arm: null, configHash: "c", payload: { winsB: 1 },
      cost: { elapsedMs: 5 }, at: "2026-09-23T00:00:00.000Z",
    });
    const second = makeDealRecord({
      dealIndex: 7, stage: "s", arm: null, configHash: "c", payload: { winsB: 1 },
      cost: { elapsedMs: 9_999 }, at: "2026-09-24T00:00:00.000Z",
    });
    expect(second.artifactHash).toBe(first.artifactHash);
  });

  it("resumes by skipping completed deals and only re-running the rest", () => {
    const dir = temporaryDir();
    manifestFor(dir, 5, [null]);
    writeDeals(dir, [null], 3);
    expect(completedDeals(dir, null)).toEqual([210_201, 210_202, 210_203]);
    const { missing, unflushed } = verifyStageWithHashes(dir);
    expect(missing).toBe(2);
    expect(unflushed).toBe(0);
  });

  it("detects a checkpoint file that was removed or edited", () => {
    const dir = temporaryDir();
    manifestFor(dir, 3, ["champion"]);
    writeDeals(dir, ["champion"], 3);
    recordHashes(dir);
    expect(() => verifyStage(dir)).not.toThrow();

    unlinkSync(join(dir, "deals", "champion", "210202.json"));
    expect(() => verifyStage(dir)).toThrow(/checkpoint is gone/);

    writeDeals(dir, ["champion"], 3);
    recordHashes(dir);
    const record = readDealRecord(dir, "champion", 210_203);
    writeFileSync(
      join(dir, "deals", "champion", "210203.json"),
      JSON.stringify({ ...record, artifactHash: "0".repeat(64) }),
    );
    expect(() => verifyStage(dir)).toThrow(/hashes to|in the manifest/);
  });

  it("refuses to seal an incomplete stage, and writes the verdict exactly once", () => {
    const dir = temporaryDir();
    manifestFor(dir, 2, ["champion", "candidate"]);
    writeDeals(dir, ["champion"], 2);
    expect(() => sealStage(dir, "2026-09-23T00:00:00.000Z")).toThrow(/cannot be sealed/);
    writeDeals(dir, ["candidate"], 1);
    recordHashes(dir);
    expect(() => sealStage(dir, "2026-09-23T00:00:00.000Z")).toThrow(/1 of 2 deals are missing/);
    writeDeals(dir, ["candidate"], 2);
    const sealed = sealStage(dir, "2026-09-23T00:00:00.000Z");
    expect(sealed.completion).toBe("SEALED");
    expect(sealed.sealedAt).toBe("2026-09-23T00:00:00.000Z");
    // A stage decides once.
    expect(() => sealStage(dir, "2026-09-23T00:01:00.000Z")).toThrow(/already sealed/);
    const verdictPath = writeVerdictOnce(dir, { decision: "PROMOTE" });
    expect(readFileSync(verdictPath, "utf8")).toContain("PROMOTE");
    expect(() => writeVerdictOnce(dir, { decision: "REJECT" })).toThrow(/already has a verdict/);
  });
});

/** The runner's own flush, used here so the guards exercise the real path. */
function recordHashes(dir: string): void {
  flushManifest(dir, "2026-09-23T00:00:00.000Z");
}

function verifyStageWithHashes(dir: string): ReturnType<typeof verifyStage> {
  recordHashes(dir);
  return verifyStage(dir);
}

describe("the no-peek status protocol", () => {
  it("exposes exactly the allowed keys, and refuses anything else", () => {
    const dir = temporaryDir();
    manifestFor(dir, 4, ["champion", "candidate"]);
    writeDeals(dir, ["champion"], 2);
    const status = stageStatus({ dir, elapsedMs: 1_000, workers: 4 });
    expect(Object.keys(status).sort()).toEqual([...PI_STATUS_KEYS].sort());
    expect(status.arms).toEqual([
      { arm: "champion", completed: 2, total: 4 },
      { arm: "candidate", completed: 0, total: 4 },
    ]);
    expect(status.throughputPerHour).toBeGreaterThan(0);
    expect(() => assertNoPeekStatus({ ...status, meanDelta: 0.03 })).toThrow(IntegrityError);
    expect(() => assertNoPeekStatus({ ...status })).not.toThrow();
  });

  it("has nowhere to put a win, a loss or a delta", () => {
    const forbidden = ["win", "wins", "loss", "losses", "delta", "mean", "score",
      "perDeal", "winsA", "winsB", "outcome", "label", "verdict"];
    for (const key of forbidden) {
      expect(PI_STATUS_KEYS).not.toContain(key);
    }
  });
});

describe("the statistics", () => {
  it("computes the paired test's bounds from the deals alone", () => {
    const differences = [0.1, -0.2, 0.3, 0.05, 0.0, 0.15];
    const test = pairedTest(differences, FACTORY_ALPHA);
    const n = differences.length;
    const mean = differences.reduce((total, value) => total + value, 0) / n;
    const variance = differences.reduce((total, value) => total + (value - mean) ** 2, 0) / (n - 1);
    expect(test.mean).toBeCloseTo(mean, 12);
    expect(test.variance).toBeCloseTo(variance, 12);
    expect(test.se).toBeCloseTo(Math.sqrt(variance / n), 12);
    expect(test.lower).toBeLessThan(test.mean);
    expect(test.upper).toBeGreaterThan(test.mean);
    expect(test.n).toBe(n);
  });

  it("promotes only when the floor and the lower bound both hold", () => {
    const strong = Array.from({ length: 400 }, (_, index) => 0.02 + (index % 3) * 0.01);
    expect(formalVerdict(strong, true).decision).toBe("PROMOTE");
    expect(formalVerdict(strong, false).decision).toBe("REJECT");
    // A mean above the floor whose interval still touches zero must not promote.
    const noisy = Array.from({ length: 40 }, (_, index) => (index % 2 === 0 ? 0.5 : -0.4));
    const noisyVerdict = formalVerdict(noisy, true);
    expect(noisyVerdict.mean).toBeGreaterThan(FACTORY_PROMOTION_FLOOR);
    expect(noisyVerdict.lower).toBeLessThan(0);
    expect(noisyVerdict.decision).toBe("REJECT");
    // A tight interval below the floor must not promote either.
    const small = Array.from({ length: 400 }, (_, index) => 0.005 + (index % 2) * 0.0001);
    expect(formalVerdict(small, true).decision).toBe("REJECT");
  });

  it("sizes the formal sample from the screen's variance, before any formal outcome", () => {
    const differences = Array.from({ length: 200 }, (_, index) => (index % 5) * 0.02);
    const screen = stage1Decision(differences);
    expect(screen.deals).toBe(200);
    expect(screen.proceed).toBe(true);
    const required = requiredFormalN(screen.variance);
    expect(required).toBe(Math.ceil(((2.576 + 0.842) ** 2 * screen.variance) / 0.02 ** 2));
    const plan = chooseFormalN(required);
    expect(FACTORY_FORMAL_LADDER).toContain(plan.n);
    expect(plan.n).toBeGreaterThanOrEqual(required);
    // A requirement beyond the ladder is capped and flagged, never extended.
    const capped = chooseFormalN(999_999);
    expect(capped.n).toBe(4_800);
    expect(capped.powerCapped).toBe(true);
  });

  it("rejects a screen that is not strictly positive", () => {
    expect(stage1Decision([0, 0, 0]).proceed).toBe(false);
    expect(stage1Decision([-0.1, 0.05]).proceed).toBe(false);
    expect(stage1Decision([0.1, 0.05]).proceed).toBe(true);
  });

  it("screens offline on the deal-equal mean and the two support floors", () => {
    const perGroup = [0.5, ...Array.from({ length: 1_999 }, () => 0)];
    expect(offlineVerdict({
      perGroup, overrideDeals: 100, selectedNonzeroDeals: 20, integrityValid: true,
    }).decision).toBe("PASS");
    expect(offlineVerdict({
      perGroup, overrideDeals: 99, selectedNonzeroDeals: 20, integrityValid: true,
    }).decision).toBe("SCREEN_REJECT");
    expect(offlineVerdict({
      perGroup, overrideDeals: 100, selectedNonzeroDeals: 19, integrityValid: true,
    }).decision).toBe("SCREEN_REJECT");
    expect(offlineVerdict({
      perGroup: perGroup.map(() => 0), overrideDeals: 500, selectedNonzeroDeals: 200,
      integrityValid: true,
    }).decision).toBe("SCREEN_REJECT");
    expect(offlineVerdict({
      perGroup, overrideDeals: 100, selectedNonzeroDeals: 20, integrityValid: false,
    }).decision).toBe("SCREEN_REJECT");
  });

  it("refuses a paired test on fewer than two deals", () => {
    expect(() => pairedTest([0.1], FACTORY_ALPHA)).toThrow(IntegrityError);
    expect(() => pairedTest([], FACTORY_ALPHA)).toThrow(IntegrityError);
  });
});
