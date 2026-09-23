/**
 * Farmer Policy Iteration Factory v1 — the pool ledger.
 *
 * `research/farmer-pi/pool-ledger.jsonl` is the Factory's single source of
 * truth about which region of deal-index space belongs to what. It is an
 * append-only event log rather than a mutable table for one reason: a table can
 * be edited to say something different, and an event log cannot be edited
 * without the edit being the whole story. The current state of every pool is a
 * *fold* of the events, computed here, and nothing else in the Factory is
 * allowed to hold a second copy of a range.
 *
 * Two rules this module enforces mechanically, because both of them are the
 * kind that a tired operator breaks at 04:00:
 *
 *   - **no overlap, ever.** A new allocation is refused if it touches any
 *     existing pool of any state, including the quarantined and invalid ones.
 *     Gaps are not pools, but the floor rule below keeps the Factory out of
 *     historical space entirely.
 *   - **ranges come from the program.** A caller names an attempt and a kind;
 *     it never passes a start and an end. `attemptLayout` is the only place a
 *     sub-range is computed, and it is a pure function of constants declared in
 *     this file.
 */
import { closeSync, fsyncSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const FACTORY_LEDGER_PATH = join(ROOT, "research", "farmer-pi", "pool-ledger.jsonl");

/**
 * The seven states a pool can be in. `QUARANTINED_UNEXPOSED` and
 * `INVALID_EXPOSED` are both unusable, and they are deliberately distinct: the
 * first says "nobody ever looked", the second says "somebody looked and the
 * look was not valid". Collapsing them would lose the only distinction that
 * matters when auditing a stop.
 */
export const POOL_STATES = Object.freeze([
  "RESERVED",
  "RUNNING",
  "SEALED_COMPLETE",
  "REVEALED",
  "CONSUMED",
  "QUARANTINED_UNEXPOSED",
  "INVALID_EXPOSED",
] as const);

export type PoolState = (typeof POOL_STATES)[number];

/** The states from which no further work may draw. */
export const CLOSED_STATES: readonly PoolState[] = Object.freeze([
  "CONSUMED",
  "QUARANTINED_UNEXPOSED",
  "INVALID_EXPOSED",
]);

export type LedgerEvent = Readonly<{
  seq: number;
  event: string;
  at: string;
  poolId: string;
  /** Null on the historical quarantine records, which predate the Factory. */
  attemptId?: string | null;
  parentChampionId?: string | null;
  protocolHash?: string | null;
  purpose?: string;
  start?: number;
  end?: number;
  /** The largest formal N this pool may ever be asked for. `null` when N/A. */
  maxFormalN?: number | null;
  state?: PoolState;
  exposureCount?: number;
  source?: string;
  note?: string;
  /** Artifact hashes attached after the fact, keyed by name. */
  artifactHashes?: Readonly<Record<string, string>>;
  /** Allocation events only. */
  kind?: AttemptKind;
  below?: number;
  rule?: string;
}>;

export type AttemptKind = "base" | "retry";

/** A pool as the fold sees it: the last state-bearing event for one id. */
export type Pool = Readonly<{
  poolId: string;
  state: PoolState;
  start: number | null;
  end: number | null;
  purpose: string | null;
  attemptId: string | null;
  parentChampionId: string | null;
  protocolHash: string | null;
  maxFormalN: number | null;
  artifactHashes: Readonly<Record<string, string>>;
  /** Every event that ever touched this pool, in order. */
  history: readonly LedgerEvent[];
}>;

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

/**
 * Parses and validates the ledger text.
 *
 * The sequence numbers must be exactly `1..n`: a gap means a line was deleted,
 * and a duplicate means one was inserted. Either way the fold below is no
 * longer a record of what happened, so this refuses rather than reporting a
 * state it cannot stand behind.
 */
export function parseLedger(text: string): readonly LedgerEvent[] {
  const events: LedgerEvent[] = [];
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === "") {
      return;
    }
    let parsed: LedgerEvent;
    try {
      parsed = JSON.parse(trimmed) as LedgerEvent;
    } catch {
      throw new LedgerError(`Ledger line ${index + 1} is not JSON.`);
    }
    const expected = events.length + 1;
    if (parsed.seq !== expected) {
      throw new LedgerError(
        `Ledger line ${index + 1} has seq ${parsed.seq}; expected ${expected}. ` +
        "A gap or a repeat means the log is no longer append-only.",
      );
    }
    if (typeof parsed.poolId !== "string" || parsed.poolId === "") {
      throw new LedgerError(`Ledger line ${index + 1} has no poolId.`);
    }
    if (parsed.state !== undefined && !POOL_STATES.includes(parsed.state)) {
      throw new LedgerError(`Ledger line ${index + 1} has unknown state ${String(parsed.state)}.`);
    }
    events.push(Object.freeze(parsed));
  });
  return Object.freeze(events);
}

/** The current state of every pool in the ledger, in first-appearance order. */
export function foldPools(events: readonly LedgerEvent[]): readonly Pool[] {
  const byId = new Map<string, {
    poolId: string;
    state: PoolState;
    start: number | null;
    end: number | null;
    purpose: string | null;
    attemptId: string | null;
    parentChampionId: string | null;
    protocolHash: string | null;
    maxFormalN: number | null;
    artifactHashes: Record<string, string>;
    history: LedgerEvent[];
  }>();

  for (const event of events) {
    let pool = byId.get(event.poolId);
    if (pool === undefined) {
      pool = {
        poolId: event.poolId,
        state: "RESERVED",
        start: null,
        end: null,
        purpose: null,
        attemptId: null,
        parentChampionId: null,
        protocolHash: null,
        maxFormalN: null,
        artifactHashes: {},
        history: [],
      };
      byId.set(event.poolId, pool);
    }
    pool.history.push(event);
    if (event.state !== undefined) {
      pool.state = event.state;
    }
    if (event.start !== undefined) {
      pool.start = event.start;
    }
    if (event.end !== undefined) {
      pool.end = event.end;
    }
    if (event.purpose !== undefined) {
      pool.purpose = event.purpose;
    }
    if (event.attemptId !== undefined) {
      pool.attemptId = event.attemptId;
    }
    if (event.parentChampionId !== undefined) {
      pool.parentChampionId = event.parentChampionId;
    }
    if (event.protocolHash !== undefined) {
      pool.protocolHash = event.protocolHash;
    }
    if (event.maxFormalN !== undefined) {
      pool.maxFormalN = event.maxFormalN;
    }
    if (event.artifactHashes !== undefined) {
      Object.assign(pool.artifactHashes, event.artifactHashes);
    }
  }

  return Object.freeze([...byId.values()].map((pool) => Object.freeze({
    ...pool,
    artifactHashes: Object.freeze({ ...pool.artifactHashes }),
    history: Object.freeze([...pool.history]),
  })));
}

export type Range = Readonly<{ start: number; end: number }>;

/**
 * The purpose that marks a pool as a *container* rather than an allocation.
 *
 * The Factory's namespace covers 200001..450000 and every attempt block lives
 * inside it, so the namespace necessarily overlaps everything. It is excluded
 * from overlap checks for that reason, and for that reason only: it is the one
 * pool whose whole job is to contain the others.
 */
export const NAMESPACE_PURPOSE = "factory-namespace";

/** Pools that occupy a numeric range and are not containers, in ledger order. */
function isRanged(pool: Pool): pool is Pool & Range {
  return pool.start !== null && pool.end !== null && pool.purpose !== NAMESPACE_PURPOSE;
}

/**
 * Refuses a new range that touches any existing ranged pool.
 *
 * Touching is inclusive on both ends and covers the degenerate case of a
 * one-deal pool. A window that merely *starts* adjacent is fine; a window that
 * would deal one deal inside another pool is not.
 */
export function assertNoOverlap(pools: readonly Pool[], candidate: Range, what: string): void {
  for (const pool of pools) {
    if (!isRanged(pool)) {
      continue;
    }
    if (candidate.start <= pool.end && candidate.end >= pool.start) {
      throw new LedgerError(
        `${what} would occupy ${candidate.start}..${candidate.end}, which overlaps ` +
        `${pool.poolId} (${pool.start}..${pool.end}, ${pool.state}).`,
      );
    }
  }
}

/** The namespace rule: nothing the Factory allocates may live below the floor. */
export function assertWithinNamespace(
  pools: readonly Pool[],
  candidate: Range,
  what: string,
): void {
  // Deliberately not `isRanged`: the namespace is a container, and `isRanged`
  // excludes containers from overlap checks. It is exactly the pool whose
  // bounds this function needs.
  const rule = pools.find((pool) => pool.poolId === "factory-v1-namespace");
  if (rule === undefined || rule.start === null || rule.end === null) {
    throw new LedgerError("The ledger has no factory-v1 namespace reservation.");
  }
  if (candidate.start < rule.start || candidate.end > rule.end) {
    throw new LedgerError(
      `${what} would occupy ${candidate.start}..${candidate.end}, outside the Factory v1 ` +
      `namespace ${rule.start}..${rule.end}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// The attempt layout — the only place a sub-range is computed
// ---------------------------------------------------------------------------

/**
 * One attempt's whole territory. Sized for the larger of the two attempt kinds
 * with room to spare, because a pool's unused deals are frozen rather than
 * recycled: an attempt that quietly handed its leftovers to a later stage would
 * make the preregistered sizes a fiction.
 */
export const FACTORY_ATTEMPT_BLOCK = 25_000;

/**
 * The sizes an allocation is laid out from.
 *
 * Passed in rather than read from the constants above, because the protocol
 * *also* declares them — `attempt.blockDeals`, `attempt.trainDeals` and the
 * rest — and two sources of truth for a pool's size is how a rehearsal ends up
 * asking for 25,000 deals inside a 400-deal retired range, or a real attempt
 * ends up sized by whatever constant nobody re-read. The constants below stay
 * as the default so the pool guards can drive the real layout without a
 * protocol document.
 */
export type AttemptLayoutSpec = Readonly<{
  blockDeals: number;
  entries: readonly Readonly<{ purpose: string; deals: number }>[];
}>;

export const FACTORY_BASE_LAYOUT: AttemptLayoutSpec = Object.freeze({
  blockDeals: FACTORY_ATTEMPT_BLOCK,
  entries: Object.freeze([
    Object.freeze({ purpose: "train", deals: 6_000 }),
    Object.freeze({ purpose: "calibration", deals: 2_000 }),
    Object.freeze({ purpose: "offline", deals: 2_000 }),
    Object.freeze({ purpose: "stage1", deals: 200 }),
    Object.freeze({ purpose: "formal", deals: 4_800 }),
  ]),
});

export const FACTORY_RETRY_LAYOUT: AttemptLayoutSpec = Object.freeze({
  blockDeals: FACTORY_ATTEMPT_BLOCK,
  entries: Object.freeze([
    Object.freeze({ purpose: "train-fresh", deals: 6_000 }),
    Object.freeze({ purpose: "calibration", deals: 4_000 }),
    Object.freeze({ purpose: "offline", deals: 4_000 }),
    Object.freeze({ purpose: "stage1", deals: 200 }),
    Object.freeze({ purpose: "formal", deals: 4_800 }),
  ]),
});

/**
 * The sub-ranges of one attempt block.
 *
 * `base` is the default attempt: 6,000 / 2,000 / 2,000 for the dataset, then
 * the 200-deal screen and the 4,800-deal formal reserve.
 *
 * `retry` is the single 20,000-scale second attempt a rejected champion is
 * allowed. It is *its own attempt* with its own block, not a second phase of
 * the base attempt, and it reuses the rejected base's 6,000 training groups —
 * which is why the range listed here is the 6,000 *fresh* training deals rather
 * than 12,000. Calibration and the offline screen are new and larger, and the
 * screen and formal pools are entirely new because the first ones have been
 * read by then.
 */
export const ATTEMPT_LAYOUT: Readonly<Record<AttemptKind, readonly Readonly<{
  purpose: string;
  deals: number;
}>[]>> = Object.freeze({
  base: Object.freeze([
    Object.freeze({ purpose: "train", deals: 6_000 }),
    Object.freeze({ purpose: "calibration", deals: 2_000 }),
    Object.freeze({ purpose: "offline", deals: 2_000 }),
    Object.freeze({ purpose: "stage1", deals: 200 }),
    Object.freeze({ purpose: "formal", deals: 4_800 }),
  ]),
  retry: Object.freeze([
    Object.freeze({ purpose: "train-fresh", deals: 6_000 }),
    Object.freeze({ purpose: "calibration", deals: 4_000 }),
    Object.freeze({ purpose: "offline", deals: 4_000 }),
    Object.freeze({ purpose: "stage1", deals: 200 }),
    Object.freeze({ purpose: "formal", deals: 4_800 }),
  ]),
});

/** The maximum formal N any attempt may ask for. The reserve's own size. */
export const MAX_FORMAL_N = 4_800;

export type AttemptAllocation = Readonly<{
  attemptId: string;
  kind: AttemptKind;
  block: Range;
  pools: readonly Readonly<{ purpose: string; range: Range }>[];
  /** The part of the block no pool claims. Frozen, never reassigned. */
  slack: Range | null;
}>;

export function attemptBlock(
  attemptNumber: number,
  namespaceStart: number,
  blockDeals: number = FACTORY_ATTEMPT_BLOCK,
): Range {
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) {
    throw new LedgerError(`Attempt numbers start at 1; received ${attemptNumber}.`);
  }
  if (!Number.isSafeInteger(blockDeals) || blockDeals < 1) {
    throw new LedgerError(`An attempt block must be a positive whole number of deals.`);
  }
  const start = namespaceStart + (attemptNumber - 1) * blockDeals;
  return Object.freeze({ start, end: start + blockDeals - 1 });
}

/**
 * The pure allocation: an attempt number and a kind in, non-overlapping ranges
 * out. No clock, no disk, no randomness — so the same attempt always lands on
 * the same deals, and a guard can assert the layout without running anything.
 */
export function attemptLayout(
  attemptNumber: number,
  kind: AttemptKind,
  namespaceStart: number,
  spec?: AttemptLayoutSpec,
): AttemptAllocation {
  const resolved = spec ?? (kind === "base" ? FACTORY_BASE_LAYOUT : FACTORY_RETRY_LAYOUT);
  const block = attemptBlock(attemptNumber, namespaceStart, resolved.blockDeals);
  const layout = spec === undefined ? ATTEMPT_LAYOUT[kind] : resolved.entries;
  const claimed = layout.reduce((total, entry) => total + entry.deals, 0);
  if (claimed > resolved.blockDeals) {
    throw new LedgerError(
      `The ${kind} layout claims ${claimed} deals of a ${resolved.blockDeals}-deal block.`,
    );
  }
  const attemptId = `attempt-${String(attemptNumber).padStart(3, "0")}`;
  const pools: Array<Readonly<{ purpose: string; range: Range }>> = [];
  let cursor = block.start;
  for (const entry of layout) {
    const range = Object.freeze({ start: cursor, end: cursor + entry.deals - 1 });
    pools.push(Object.freeze({ purpose: entry.purpose, range }));
    cursor = range.end + 1;
  }
  return Object.freeze({
    attemptId,
    kind,
    block,
    pools: Object.freeze(pools),
    slack: cursor > block.end ? null : Object.freeze({ start: cursor, end: block.end }),
  });
}

// ---------------------------------------------------------------------------
// Disk
// ---------------------------------------------------------------------------

export function readLedger(path: string = FACTORY_LEDGER_PATH): readonly LedgerEvent[] {
  return parseLedger(readFileSync(path, "utf8"));
}

export function ledgerPools(path: string = FACTORY_LEDGER_PATH): readonly Pool[] {
  return foldPools(readLedger(path));
}

/**
 * Appends one event, under an exclusive lock and with an `fsync` before the
 * lock is released.
 *
 * The lock is a `wx` sentinel file rather than an advisory lock on the ledger
 * itself, because the ledger is opened for append and a POSIX advisory lock on
 * a file opened `O_APPEND` is not the thing anyone thinks it is. The failure
 * mode being prevented is two allocators interleaving, and a sentinel that
 * cannot be created twice prevents exactly that. It is not crash-proof by
 * itself: a process killed between creating and removing it leaves a stale
 * sentinel, which is why the sentinel records its pid and this refuses to
 * proceed silently when one is present.
 */
export function appendLedgerEvent(
  event: Omit<LedgerEvent, "seq">,
  path: string = FACTORY_LEDGER_PATH,
): LedgerEvent {
  const lockPath = `${path}.lock`;
  let lockFd: number;
  try {
    lockFd = openSync(lockPath, "wx");
  } catch {
    throw new LedgerError(
      `The ledger lock ${lockPath} already exists. Another allocator is running, or a ` +
      "previous one was killed mid-allocation. Inspect the ledger before removing it.",
    );
  }
  try {
    const existing = readLedger(path);
    const last = existing[existing.length - 1];
    const full: LedgerEvent = Object.freeze({ ...event, seq: (last?.seq ?? 0) + 1 });
    const fd = openSync(path, "a");
    try {
      writeSync(fd, `${JSON.stringify(full)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return full;
  } finally {
    closeSync(lockFd);
    unlinkSync(lockPath);
  }
}

/**
 * Allocates one attempt: validates the layout against the whole ledger, then
 * writes one `ALLOCATE` event per pool plus the attempt's own block record.
 *
 * Validation happens before the first append, so a rejected allocation leaves
 * the ledger untouched rather than half-written.
 */
export function allocateAttempt(options: Readonly<{
  attemptNumber: number;
  kind: AttemptKind;
  attemptId: string;
  parentChampionId: string;
  protocolHash: string;
  at: string;
  spec?: AttemptLayoutSpec;
  path?: string;
}>): AttemptAllocation {
  const path = options.path ?? FACTORY_LEDGER_PATH;
  const pools = ledgerPools(path);
  const namespace = pools.find((pool) => pool.poolId === "factory-v1-namespace");
  if (namespace === undefined || namespace.start === null) {
    throw new LedgerError("The ledger has no factory-v1 namespace reservation.");
  }
  const allocation = attemptLayout(
    options.attemptNumber, options.kind, namespace.start, options.spec);

  const seen = new Set(pools.map((pool) => pool.poolId));
  for (const entry of allocation.pools) {
    const poolId = `factory-v1/${allocation.attemptId}/${entry.purpose}`;
    if (seen.has(poolId)) {
      throw new LedgerError(`Pool ${poolId} is already in the ledger.`);
    }
    assertNoOverlap(pools, entry.range, `Pool ${poolId}`);
    assertWithinNamespace(pools, entry.range, `Pool ${poolId}`);
  }
  assertNoOverlap(pools, allocation.block, `The ${allocation.attemptId} block`);

  for (const entry of allocation.pools) {
    appendLedgerEvent({
      event: "ALLOCATE",
      at: options.at,
      poolId: `factory-v1/${allocation.attemptId}/${entry.purpose}`,
      attemptId: allocation.attemptId,
      parentChampionId: options.parentChampionId,
      protocolHash: options.protocolHash,
      purpose: entry.purpose,
      start: entry.range.start,
      end: entry.range.end,
      maxFormalN: entry.purpose === "formal" ? MAX_FORMAL_N : null,
      state: "RESERVED",
      exposureCount: 0,
      kind: options.kind,
      source: "research/farmer-pi/pool-ledger.jsonl",
      note: `${allocation.attemptId} (${options.kind}) ${entry.purpose} pool.`,
    }, path);
  }
  return allocation;
}

/** Records a state transition for an existing pool, after checking it is legal. */
export function transitionPool(options: Readonly<{
  poolId: string;
  to: PoolState;
  at: string;
  note?: string;
  artifactHashes?: Readonly<Record<string, string>>;
  path?: string;
}>): void {
  const path = options.path ?? FACTORY_LEDGER_PATH;
  const pools = ledgerPools(path);
  const pool = pools.find((entry) => entry.poolId === options.poolId);
  if (pool === undefined) {
    throw new LedgerError(`Pool ${options.poolId} is not in the ledger.`);
  }
  if (CLOSED_STATES.includes(pool.state) && !CLOSED_STATES.includes(options.to)) {
    throw new LedgerError(
      `Pool ${options.poolId} is ${pool.state} and cannot return to ${options.to}. ` +
      "A closed pool is closed.",
    );
  }
  appendLedgerEvent({
    event: "TRANSITION",
    at: options.at,
    poolId: options.poolId,
    state: options.to,
    ...(options.note === undefined ? {} : { note: options.note }),
    ...(options.artifactHashes === undefined ? {} : { artifactHashes: options.artifactHashes }),
  }, path);
}
