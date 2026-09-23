/**
 * Farmer Policy Iteration Factory v1 — the stage protocol.
 *
 * Everything a stage has to get right that is not the game:
 *
 *   - **the deal is the transaction.** A stage's work is a sequence of initial
 *     deals, and a deal is only finished when its record is on disk, fsynced and
 *     renamed into place. §27 exists because a suspend used to cost hours: a
 *     shard was all-or-nothing, so an interrupted 1,000-deal shard was thrown
 *     away. Here the unit is one deal, and a resumed run re-does only what is
 *     genuinely missing.
 *   - **the same deal must produce the same bytes.** A resume that recomputes a
 *     deal already on disk is not an error by itself — the record is compared,
 *     and a difference is an `INTEGRITY_STOP` rather than a quiet overwrite.
 *   - **no peek is an output protocol.** §29 is explicit: the running stage may
 *     print progress, elapsed, throughput, ETA, worker health, checkpoint count
 *     and error codes, and nothing that can be inverted into a strength. The
 *     status object below *is* that list, and a guard asserts its key set, so
 *     the rule is enforced by the shape of the only thing the runner prints.
 *   - **one verdict, at the end, from a complete stage.** The aggregator refuses
 *     a stage whose manifest is not complete and whose hashes do not verify, and
 *     the sealed marker makes the verdict write-once.
 *
 * Nothing here reads the clock except to stamp records; every decision this
 * module makes is a pure function of files on disk.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { tQuantile } from "./cf-tquantile.js";

// ---------------------------------------------------------------------------
// Integrity
// ---------------------------------------------------------------------------

/**
 * Raised when a stage's recorded state and its computed state disagree. Every
 * throw of this type stops the Factory and waits for a human: these are the
 * failures where continuing would mean deciding on numbers nobody can vouch
 * for, which is worse than not deciding.
 */
export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrityError";
  }
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * A stable hash of a JSON value: keys sorted at every level, so two records
 * that differ only in key insertion order hash the same.
 */
export function stableHash(value: unknown): string {
  return sha256(JSON.stringify(sortKeys(value)));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = sortKeys(record[key]);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Atomic file writes
// ---------------------------------------------------------------------------

/**
 * Write, fsync, rename, fsync-the-directory.
 *
 * The rename is what makes the destination never observable half-written; the
 * directory fsync is what makes the rename itself survive a power loss. Without
 * the second one a suspend can leave the *old* directory entry, which for a
 * resume means "the deal we just finished is not there" — annoying but safe —
 * or, worse on some filesystems, an entry pointing at a file whose contents
 * were never flushed. Both are cheap to avoid.
 */
export function writeFileAtomic(path: string, contents: string): void {
  const temporary = `${path}.partial`;
  const fd = openSync(temporary, "w");
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const dirFd = openSync(join(path, ".."), "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

// ---------------------------------------------------------------------------
// Deal-level checkpoints
// ---------------------------------------------------------------------------

/**
 * One initial deal's finished work.
 *
 * `artifactHash` covers `payload` alone — not the timestamp, and deliberately
 * not `cost`. The payload must be a deterministic function of the deal, because
 * the resume check compares hashes and a wall-clock reading inside the payload
 * would make every re-run an `INTEGRITY_STOP`. Cost is a measurement *about*
 * the run, not a result of it, so it is carried beside the hash rather than
 * under it.
 */
export type PiDealRecord = Readonly<{
  dealIndex: number;
  stage: string;
  /** `null` for corpus stages, which have no arms. */
  arm: string | null;
  configHash: string;
  artifactHash: string;
  payload: unknown;
  /** Timings and counters. Never hashed; see above. */
  cost?: unknown;
  completedAt: string;
}>;

export function dealRecordPath(dir: string, arm: string | null, dealIndex: number): string {
  return arm === null
    ? join(dir, "deals", `${dealIndex}.json`)
    : join(dir, "deals", arm, `${dealIndex}.json`);
}

export function makeDealRecord(options: Readonly<{
  dealIndex: number;
  stage: string;
  arm: string | null;
  configHash: string;
  payload: unknown;
  cost?: unknown;
  at: string;
}>): PiDealRecord {
  return Object.freeze({
    dealIndex: options.dealIndex,
    stage: options.stage,
    arm: options.arm,
    configHash: options.configHash,
    artifactHash: stableHash(options.payload),
    payload: options.payload,
    ...(options.cost === undefined ? {} : { cost: options.cost }),
    completedAt: options.at,
  });
}

/**
 * Persists one deal, idempotently.
 *
 * Three outcomes, and the middle one is the reason this is not a plain write:
 *
 *   - nothing on disk            → write it;
 *   - the same artifact hash     → keep the existing bytes, touch nothing;
 *   - a different artifact hash  → `INTEGRITY_STOP`.
 *
 * The third case means a deterministic computation produced two different
 * answers for the same deal, which invalidates every other deal in the stage by
 * association. Overwriting would hide exactly the failure the checkpoints exist
 * to expose.
 */
export function writeDealRecord(dir: string, record: PiDealRecord): "written" | "duplicate" {
  const path = dealRecordPath(dir, record.arm, record.dealIndex);
  if (existsSync(path)) {
    const existing = readJson(path) as PiDealRecord;
    if (existing.artifactHash !== record.artifactHash) {
      throw new IntegrityError(
        `Deal ${record.dealIndex} (${record.stage}${record.arm === null ? "" : `/${record.arm}`}) ` +
        `re-ran to ${record.artifactHash}; the checkpoint on disk says ${existing.artifactHash}. ` +
        "A deterministic stage cannot disagree with itself; every result in this stage is suspect.",
      );
    }
    if (existing.configHash !== record.configHash) {
      throw new IntegrityError(
        `Deal ${record.dealIndex} was produced under config ${existing.configHash} and is now ` +
        `being reproduced under ${record.configHash}. The stage was run under two configurations.`,
      );
    }
    return "duplicate";
  }
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify(record)}\n`);
  return "written";
}

export function readDealRecord(dir: string, arm: string | null, dealIndex: number): PiDealRecord {
  return readJson(dealRecordPath(dir, arm, dealIndex)) as PiDealRecord;
}

/** The deal indices with a record on disk, ascending. */
export function completedDeals(dir: string, arm: string | null): readonly number[] {
  const root = arm === null ? join(dir, "deals") : join(dir, "deals", arm);
  if (!existsSync(root)) {
    return Object.freeze([]);
  }
  const names = readdirSync(root).filter((name) => name.endsWith(".json"));
  const indexes = names
    .map((name) => Number.parseInt(name.slice(0, -5), 10))
    .filter((value) => Number.isSafeInteger(value))
    .sort((left, right) => left - right);
  return Object.freeze(indexes);
}

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

export type PiStageCompletion = "RUNNING" | "COMPLETE" | "SEALED";

/**
 * A stage's plan, its completion state and the hashes of every finished deal.
 *
 * The per-deal files remain the authority on *what* was computed; the manifest
 * is the authority on *what was promised*, which is what makes "this stage ran
 * the deals it registered" checkable without trusting a directory listing.
 */
export type PiStageManifest = Readonly<{
  stage: string;
  attemptId: string;
  arms: readonly (string | null)[];
  configHash: string;
  config: Readonly<Record<string, unknown>>;
  poolId: string;
  start: number;
  deals: number;
  completion: PiStageCompletion;
  /**
   * `"<arm>#<dealIndex>"` → artifactHash, as of the last flush.
   *
   * Keyed by arm as well as index because the two arms play the *same* deals —
   * a flat map by deal index would have the champion arm's hash silently
   * standing in for the candidate arm's.
   */
  hashes: Readonly<Record<string, string>>;
  updatedAt: string;
  sealedAt: string | null;
}>;

export function manifestPath(dir: string): string {
  return join(dir, "manifest.json");
}

export function writeManifest(dir: string, manifest: PiStageManifest): void {
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(manifestPath(dir), `${JSON.stringify(manifest, null, 2)}\n`);
}

export function readManifest(dir: string): PiStageManifest {
  const path = manifestPath(dir);
  if (!existsSync(path)) {
    throw new IntegrityError(`Stage ${dir} has no manifest.`);
  }
  return readJson(path) as PiStageManifest;
}

/**
 * Recomputes the manifest's hash table from the deal records on disk and
 * refuses to continue if it disagrees with what the manifest already claims.
 *
 * This is the check that runs first on every resume. It catches the three ways
 * a checkpoint area goes bad: a file removed, a file edited, and a file whose
 * payload no longer hashes to what was recorded.
 */
export function verifyStage(dir: string): Readonly<{
  manifest: PiStageManifest;
  completed: ReadonlyMap<string, readonly number[]>;
  /** Planned deals with no checkpoint yet. These are what a resume re-runs. */
  missing: number;
  /** Deals finished since the last manifest flush. Normal, not an error. */
  unflushed: number;
}> {
  const manifest = readManifest(dir);
  const completed = new Map<string, readonly number[]>();
  let missing = 0;
  let unflushed = 0;

  // The manifest's promises first: every deal it records as finished must
  // still be on disk and must still hash to what was recorded. This is the
  // check that catches a checkpoint area edited, truncated or pruned between
  // runs.
  for (const [key, hash] of Object.entries(manifest.hashes)) {
    const separator = key.lastIndexOf("#");
    if (separator < 0) {
      throw new IntegrityError(`Stage ${manifest.stage} has a malformed hash key "${key}".`);
    }
    const armKey = key.slice(0, separator);
    const index = Number.parseInt(key.slice(separator + 1), 10);
    const arm = armKey === "corpus" ? null : armKey;
    if (!manifest.arms.some((entry) => (entry ?? "corpus") === armKey)) {
      throw new IntegrityError(
        `Stage ${manifest.stage} records a deal for arm "${armKey}", which is not one of its arms.`,
      );
    }
    if (!completedDeals(dir, arm).includes(index)) {
      throw new IntegrityError(
        `Stage ${manifest.stage} records deal ${index} (${armKey}) as finished, but its ` +
        "checkpoint is gone.",
      );
    }
    const record = readDealRecord(dir, arm, index);
    if (record.artifactHash !== hash) {
      throw new IntegrityError(
        `Stage ${manifest.stage} deal ${index} (${armKey}) hashes to ${record.artifactHash} on ` +
        `disk and ${hash} in the manifest.`,
      );
    }
    if (record.configHash !== manifest.configHash) {
      throw new IntegrityError(
        `Stage ${manifest.stage} deal ${index} (${armKey}) was produced under config ` +
        `${record.configHash}; the stage runs under ${manifest.configHash}.`,
      );
    }
  }

  // Then the plan: how much of it is on disk, arm by arm.
  for (const arm of manifest.arms) {
    const key = arm ?? "corpus";
    const onDisk = completedDeals(dir, arm);
    const planned = new Set<number>();
    for (let offset = 0; offset < manifest.deals; offset += 1) {
      planned.add(manifest.start + offset);
    }
    for (const index of onDisk) {
      if (!planned.has(index)) {
        throw new IntegrityError(
          `Stage ${manifest.stage} has a checkpoint for deal ${index} (${key}), which is outside ` +
          `the pool it registered (${manifest.start}..${manifest.start + manifest.deals - 1}).`,
        );
      }
      if (manifest.hashes[`${key}#${index}`] === undefined) {
        unflushed += 1;
      }
    }
    completed.set(key, Object.freeze(onDisk));
    missing += planned.size - onDisk.length;
  }
  return Object.freeze({ manifest, completed, missing, unflushed });
}

/**
 * Rewrites the manifest from what is on disk.
 *
 * Called at a bounded interval and always at stage end. Between flushes the
 * deals directory is ahead of the manifest, which is why `verifyStage` reports
 * the difference as `unflushed` rather than treating it as damage: the deals
 * are the record of what happened, and the manifest is the record of what was
 * promised.
 */
export function flushManifest(dir: string, at: string): PiStageManifest {
  const manifest = readManifest(dir);
  if (manifest.completion === "SEALED") {
    // A flush after the seal would write `RUNNING` over the one state that is
    // not allowed to be revisited, which would let a second verdict be written.
    throw new IntegrityError(
      `Stage ${manifest.stage} is sealed; a flush may not reopen it.`,
    );
  }
  const hashes: Record<string, string> = {};
  for (const arm of manifest.arms) {
    const key = arm ?? "corpus";
    for (const index of completedDeals(dir, arm)) {
      hashes[`${key}#${index}`] = readDealRecord(dir, arm, index).artifactHash;
    }
  }
  const flushed: PiStageManifest = Object.freeze({
    ...manifest,
    hashes: Object.freeze(hashes),
    completion: "RUNNING",
    updatedAt: at,
  });
  writeManifest(dir, flushed);
  return flushed;
}

export function sealStage(dir: string, at: string): PiStageManifest {
  const existing = readManifest(dir);
  if (existing.completion === "SEALED") {
    throw new IntegrityError(`Stage ${existing.stage} is already sealed.`);
  }
  // Flush first, so the manifest the seal writes is the complete one, and then
  // re-verify: the seal is the moment the stage's own record has to be right.
  flushManifest(dir, at);
  const { manifest, missing } = verifyStage(dir);
  if (missing > 0) {
    throw new IntegrityError(
      `Stage ${manifest.stage} cannot be sealed: ${missing} of ${manifest.deals} deals are missing.`,
    );
  }
  if (manifest.completion !== "RUNNING" && manifest.completion !== "COMPLETE") {
    throw new IntegrityError(
      `Stage ${manifest.stage} is ${manifest.completion} and cannot be sealed from there.`,
    );
  }
  const sealed: PiStageManifest = Object.freeze({
    ...readManifest(dir),
    completion: "SEALED",
    sealedAt: at,
    updatedAt: at,
  });
  writeManifest(dir, sealed);
  return sealed;
}

/**
 * The one-way door in front of a stage's outcome.
 *
 * A stage's verdict is written once, after the stage is sealed, and a second
 * write is refused. This is the mechanism behind "formal 不得加样本、调
 * threshold、重新训练" — not a promise to behave, but a write that cannot happen.
 */
export function writeVerdictOnce(dir: string, verdict: unknown): string {
  const manifest = readManifest(dir);
  if (manifest.completion !== "SEALED") {
    throw new IntegrityError(
      `Stage ${manifest.stage} is ${manifest.completion}; a verdict may only be written after seal.`,
    );
  }
  const path = join(dir, "verdict.json");
  if (existsSync(path)) {
    throw new IntegrityError(
      `Stage ${manifest.stage} already has a verdict. A stage decides once.`,
    );
  }
  writeFileAtomic(path, `${JSON.stringify(verdict, null, 2)}\n`);
  return path;
}

// ---------------------------------------------------------------------------
// The no-peek status protocol (§29)
// ---------------------------------------------------------------------------

/**
 * Everything a running stage is allowed to say about itself.
 *
 * There is no field here that can be inverted into a strength, and there is no
 * field here that a caller could add one to: `PI_STATUS_KEYS` is the whole
 * surface, and `assertNoPeekStatus` checks the key set exactly rather than
 * checking for the fields somebody remembered to forbid.
 */
export const PI_STATUS_KEYS: readonly string[] = Object.freeze([
  "stage",
  "attemptId",
  "arms",
  "elapsedMs",
  "throughputPerHour",
  "etaMs",
  "workers",
  "checkpoints",
  "errorCodes",
  "completion",
]);

export type PiStageStatus = Readonly<{
  stage: string;
  attemptId: string;
  arms: readonly Readonly<{ arm: string; completed: number; total: number }>[];
  elapsedMs: number;
  throughputPerHour: number;
  etaMs: number | null;
  workers: number;
  checkpoints: number;
  errorCodes: readonly string[];
  completion: PiStageCompletion;
}>;

export function assertNoPeekStatus(status: Record<string, unknown>): void {
  const keys = Object.keys(status).sort();
  const allowed = [...PI_STATUS_KEYS].sort();
  if (JSON.stringify(keys) !== JSON.stringify(allowed)) {
    throw new IntegrityError(
      `A stage status must expose exactly ${allowed.join(", ")}; it exposes ${keys.join(", ")}. ` +
      "Anything else is a channel through which a running outcome could reach a reader.",
    );
  }
}

/**
 * Builds the status from the manifest and the clock, and nothing else.
 *
 * Note what it is *not* given: the deal payloads. The progress numbers come
 * from counting files, so there is no path by which a payload could reach the
 * status even by accident.
 */
export function stageStatus(options: Readonly<{
  dir: string;
  elapsedMs: number;
  workers: number;
  errorCodes?: readonly string[];
}>): PiStageStatus {
  const manifest = readManifest(options.dir);
  const arms = manifest.arms.map((arm) => {
    const completed = completedDeals(options.dir, arm).length;
    return Object.freeze({ arm: arm ?? "corpus", completed, total: manifest.deals });
  });
  const done = arms.reduce((total, entry) => total + entry.completed, 0);
  const expected = manifest.deals * Math.max(1, manifest.arms.length);
  const perMs = options.elapsedMs <= 0 ? 0 : done / options.elapsedMs;
  const remaining = Math.max(0, expected - done);
  const status: PiStageStatus = Object.freeze({
    stage: manifest.stage,
    attemptId: manifest.attemptId,
    arms: Object.freeze(arms),
    elapsedMs: options.elapsedMs,
    throughputPerHour: perMs * 3_600_000,
    etaMs: perMs <= 0 ? null : remaining / perMs,
    workers: options.workers,
    checkpoints: done,
    errorCodes: Object.freeze([...(options.errorCodes ?? [])]),
    completion: manifest.completion,
  });
  assertNoPeekStatus(status as unknown as Record<string, unknown>);
  return status;
}

// ---------------------------------------------------------------------------
// Stage 1 (§18) and the formal test (§19–§21)
// ---------------------------------------------------------------------------

/** One-sided alpha for every formal test in the Factory. */
export const FACTORY_ALPHA = 0.005;
/** The preregistered promotion floor, in farmer-arm paired win-rate units. */
export const FACTORY_PROMOTION_FLOOR = 0.01;
/** The two design quantiles of §19's sample-size formula. */
export const FACTORY_POWER_QUANTILES = Object.freeze({ alpha: 2.576, power: 0.842 });
/** The smallest effect the formal sample size is sized to detect. */
export const FACTORY_DESIGN_DELTA = 0.02;
/** The preregistered ladder. The first rung at or above `N_req` is used. */
export const FACTORY_FORMAL_LADDER: readonly number[] = Object.freeze([1_200, 2_400, 4_800]);
export const FACTORY_STAGE1_DEALS = 200;

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function sampleVariance(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) {
    return 0;
  }
  const m = mean(values);
  return values.reduce((total, value) => total + (value - m) ** 2, 0) / (n - 1);
}

export type PiPairedTest = Readonly<{
  n: number;
  mean: number;
  sd: number;
  variance: number;
  se: number;
  /** `t(1 - alpha, n - 1)`. */
  quantile: number;
  /** The one-sided lower confidence bound at `1 - alpha`. */
  lower: number;
  /** `mean + quantile * se`. Reported, never used to promote. */
  upper: number;
}>;

export function pairedTest(differences: readonly number[], alpha: number): PiPairedTest {
  const n = differences.length;
  if (n < 2) {
    throw new IntegrityError(`A paired test needs at least two deals; received ${n}.`);
  }
  const m = mean(differences);
  const variance = sampleVariance(differences);
  const sd = Math.sqrt(variance);
  const se = sd / Math.sqrt(n);
  const quantile = tQuantile(1 - alpha, n - 1);
  return Object.freeze({
    n,
    mean: m,
    sd,
    variance,
    se,
    quantile,
    lower: m - quantile * se,
    upper: m + quantile * se,
  });
}

/**
 * §18's screen. Two arms, 200 fresh deals, one direction only.
 *
 * Stage 1 cannot promote anything and its pool is never merged with the formal
 * one; all it can do is stop the attempt early or let it continue, and the
 * sample size it implies is the only other thing that leaves this function.
 */
export type PiStage1Decision = Readonly<{
  deals: number;
  mean: number;
  variance: number;
  /** True when the candidate is at least not worse. Strictly positive required. */
  proceed: boolean;
}>;

export function stage1Decision(differences: readonly number[]): PiStage1Decision {
  const n = differences.length;
  const m = mean(differences);
  return Object.freeze({
    deals: n,
    mean: m,
    variance: sampleVariance(differences),
    // §18: `farmer Δ <= 0` is REJECT. Exactly zero is not an improvement.
    proceed: n > 0 && m > 0,
  });
}

/**
 * §19's sample size, from Stage 1's variance alone.
 *
 * The variance is read from the screen and the *size* is then frozen before any
 * formal outcome is read, which is the whole reason the screen exists: choosing
 * N after seeing the formal numbers would be a second look at the same data.
 */
export function requiredFormalN(
  variance: number,
  delta: number = FACTORY_DESIGN_DELTA,
): number {
  const { alpha, power } = FACTORY_POWER_QUANTILES;
  return Math.ceil(((alpha + power) ** 2 * variance) / delta ** 2);
}

export type PiFormalPlan = Readonly<{
  required: number;
  n: number;
  powerCapped: boolean;
}>;

export function chooseFormalN(required: number): PiFormalPlan {
  for (const n of FACTORY_FORMAL_LADDER) {
    if (n >= required) {
      return Object.freeze({ required, n, powerCapped: false });
    }
  }
  const last = FACTORY_FORMAL_LADDER[FACTORY_FORMAL_LADDER.length - 1] ?? 0;
  return Object.freeze({ required, n: last, powerCapped: true });
}

export type PiFormalVerdict = Readonly<{
  n: number;
  mean: number;
  se: number;
  quantile: number;
  lower: number;
  alpha: number;
  integrityValid: boolean;
  decision: "PROMOTE" | "REJECT";
  reasons: readonly string[];
}>;

/**
 * §20 and §21, in one function so the two cannot drift apart.
 *
 * Promotion needs all of: the effect at or above the preregistered floor, a
 * lower bound strictly above zero, and a valid stage. The integrity flag is an
 * argument rather than something this function checks, because the checks live
 * where the artifacts are and this function must stay a pure function of
 * numbers a guard can drive.
 */
export function formalVerdict(
  differences: readonly number[],
  integrityValid: boolean,
  alpha: number = FACTORY_ALPHA,
): PiFormalVerdict {
  const test = pairedTest(differences, alpha);
  const reasons: string[] = [];
  if (!integrityValid) {
    reasons.push("integrity gate failed");
  }
  if (test.mean < FACTORY_PROMOTION_FLOOR) {
    reasons.push(`farmer mean_D ${test.mean.toFixed(6)} < ${FACTORY_PROMOTION_FLOOR}`);
  }
  if (!(test.lower > 0)) {
    reasons.push(`lower bound ${test.lower.toFixed(6)} is not above 0`);
  }
  return Object.freeze({
    n: test.n,
    mean: test.mean,
    se: test.se,
    quantile: test.quantile,
    lower: test.lower,
    alpha,
    integrityValid,
    decision: reasons.length === 0 ? "PROMOTE" : "REJECT",
    reasons: Object.freeze(reasons),
  });
}

// ---------------------------------------------------------------------------
// The offline screen (§15)
// ---------------------------------------------------------------------------

export const FACTORY_OFFLINE_GROUPS = 2_000;
export const FACTORY_OFFLINE_MIN_OVERRIDE_DEALS = 100;
export const FACTORY_OFFLINE_MIN_SELECTED_NONZERO_DEALS = 20;

export type PiOfflineVerdict = Readonly<{
  groups: number;
  muHat: number;
  overrideDeals: number;
  selectedNonzeroDeals: number;
  integrityValid: boolean;
  decision: "PASS" | "SCREEN_REJECT";
  reasons: readonly string[];
}>;

/**
 * The cheap filter. Deliberately not evidence: it runs on a pool the attempt
 * may never train on, it demands far less than the formal test, and passing it
 * only buys the right to spend the formal reserve.
 */
export function offlineVerdict(options: Readonly<{
  perGroup: readonly number[];
  overrideDeals: number;
  selectedNonzeroDeals: number;
  integrityValid: boolean;
}>): PiOfflineVerdict {
  const reasons: string[] = [];
  const muHat = mean(options.perGroup);
  if (!options.integrityValid) {
    reasons.push("integrity gate failed");
  }
  if (!(muHat > 0)) {
    reasons.push(`deal-equal mu_hat ${muHat.toFixed(6)} is not above 0`);
  }
  if (options.overrideDeals < FACTORY_OFFLINE_MIN_OVERRIDE_DEALS) {
    reasons.push(
      `override deals ${options.overrideDeals} < ${FACTORY_OFFLINE_MIN_OVERRIDE_DEALS}`);
  }
  if (options.selectedNonzeroDeals < FACTORY_OFFLINE_MIN_SELECTED_NONZERO_DEALS) {
    reasons.push(
      `selected nonzero deals ${options.selectedNonzeroDeals} < ` +
      `${FACTORY_OFFLINE_MIN_SELECTED_NONZERO_DEALS}`);
  }
  return Object.freeze({
    groups: options.perGroup.length,
    muHat,
    overrideDeals: options.overrideDeals,
    selectedNonzeroDeals: options.selectedNonzeroDeals,
    integrityValid: options.integrityValid,
    decision: reasons.length === 0 ? "PASS" : "SCREEN_REJECT",
    reasons: Object.freeze(reasons),
  });
}

// ---------------------------------------------------------------------------
// The lock the runner holds
// ---------------------------------------------------------------------------

/**
 * A single-writer lock for one attempt directory.
 *
 * Two runners on one attempt would interleave checkpoints and halve the
 * throughput, and the deal-level idempotence would make the damage invisible.
 * The lock file records its pid so a stale one — a runner killed mid-attempt —
 * can be told apart from a live one by hand rather than by guesswork.
 */
export function acquireRunLock(dir: string, now: number = Date.now()): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "run.lock");
  if (existsSync(path)) {
    const holder = readFileSync(path, "utf8").trim();
    throw new IntegrityError(
      `Attempt ${dir} is locked by ${holder}. If that process is gone, delete ${path} by hand ` +
      "and say so in the journal.",
    );
  }
  const fd = openSync(path, "wx");
  try {
    writeSync(fd, `${process.pid} ${new Date(now).toISOString()}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return path;
}

export function releaseRunLock(path: string): void {
  if (existsSync(path)) {
    unlinkSync(path);
  }
}
