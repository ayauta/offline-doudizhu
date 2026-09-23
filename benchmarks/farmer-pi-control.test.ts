/**
 * Farmer Policy Iteration Factory v1 — the control plane (§31).
 *
 * `scripts/farmer-pi.mjs` is the single command an operator runs, and it is a
 * `.mjs` file. A `.mjs` file cannot import the Factory's `.ts` modules, so every
 * decision that must come from frozen code is asked for over a process
 * boundary: the runner writes one JSON config, runs **one** mode of this file
 * under vitest, and reads one JSON answer back. The alternative — reimplementing
 * the state machine, the verdicts and the checkpoint protocol in JavaScript —
 * would put a second, unfrozen copy of the science beside the frozen one, which
 * is exactly the failure mode the two previous rounds were made of.
 *
 * So the split is:
 *
 *   - **the runner** owns the process: the modes, the absolute deadline, the
 *     child processes and their kills, the journal, resume, the exit codes, and
 *     what may appear on a console while a stage is running;
 *   - **this file** owns the derivations: the attempt state machine, the
 *     allocation, the pool-ledger transitions, the manifests and seals, the
 *     frozen verdicts, and every read of a stage payload.
 *
 * ## The one env contract
 *
 *   AI_FPI_CONTROL=<mode>  AI_FPI_CONTROL_CONFIG=<path to the JSON config>
 *
 * Off unless `AI_FPI_CONTROL` is set, so the benchmark suite stays green with no
 * configuration. The config's `mode` must agree with the env var; a mismatch is
 * refused rather than obeyed, because the two are written by different hands and
 * a run that used the wrong one would be a run nobody can name afterwards.
 *
 * ## Four rules this file enforces rather than documents
 *
 *   1. **Sealed then revealed** (§6). Every payload read goes through
 *      `readSealedStage`, which throws unless the manifest says SEALED. There is
 *      no other way this file opens a `deals/` directory.
 *   2. **One config hash per stage.** `verifyStage` refuses a deal whose
 *      `configHash` differs from its manifest's, and the two arms of a strength
 *      stage necessarily have different ones — `armConfigHash` covers the arm
 *      and the chain. So a strength stage is *two* single-arm stage directories
 *      (which is what the stage worker's own header describes: "one worker per
 *      arm ... each with its own directory"), plus a small stage *record* beside
 *      them that holds the seal and the one verdict.
 *   3. **A decision is a write, not a conclusion.** Every branch of `decide`
 *      reads a field a frozen function wrote; nothing here compares a number to
 *      a threshold of its own.
 *   4. **The phase comes from the step.** `recordStep` takes the phase from
 *      `phaseAfter` and never from its caller, so a runner that believes it
 *      finished something it did not cannot move the machine on.
 *
 * ## Layout this file expects under `<root>/attempts/<attemptId>/`
 *
 *   attempt.json                    the attempt record (the state machine's)
 *   stages/<purpose>/               a corpus stage (train, train-fresh,
 *                                   calibration, offline): arms `[null]`
 *   stages/<stage>/<arm>/           one arm of a strength stage (stage1, formal)
 *   verdicts/<stage>/               the strength stage's record: its seal and
 *                                   its one verdict
 *   models/candidate.json           the packaged candidate layer
 *   train/                          rows in, cf-train.py's outputs beside them
 *   calibration.json formal-plan.json logs/<key>.log control/<mode>.json
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { CF_FEATURE_NAMES } from "../src/core/ai/cf-features.js";
import { parseTreeModel, scoreTrees, type TreeModel } from "./cf-model.js";
import { cfAuditStructure, cfSchemaHash, type CfStructuralAudit } from "./cf-corpus.js";
import type { CfGroupResult, CfSplit } from "./cf-dataset.js";
import {
  CF_MIN_OVERRIDE_DEALS,
  CF_MIN_SELECTED_NONZERO_DEALS,
  CF_THRESHOLD_GRID,
  cfChooseOverride,
  cfRowId,
  cfSelectThreshold,
  cfThresholdOutcome,
  type CfScoredRoot,
} from "./cf-selector.js";
import { tQuantile } from "./cf-tquantile.js";
import {
  FARMER_ARMS,
  accumulateDeal,
  armConfigHash,
  armResultHash,
  emptyArmAccumulator,
  freezeArm,
  pairedFarmerDifferences,
  type FarmerArm,
  type FarmerArmResult,
  type FarmerDealCost,
  type FarmerDealOutcome,
  type FarmerDealPayload,
} from "./farmer-pi-arm.js";
import {
  applyOutcome,
  assertAttemptProtocol,
  attemptsUsed,
  factoryStopReason,
  nextAttemptKind,
  nextAttemptStep,
  phaseAfter,
  researchChampionFor,
  type AttemptKind,
  type AttemptRecord,
  type AttemptStep,
  type AttemptSummary,
  type FactoryState,
  type StopReason,
} from "./farmer-pi-attempt.js";
import { cumulativeModelBytes, type ChampionChain } from "./farmer-pi-chain.js";
import {
  CHAMPION_DIR,
  PI1_CHAMPION_ID,
  readChampionArchive,
  writeChampionArchive,
  type ArchivedLayer,
  type ChampionArchive,
} from "./farmer-pi-champions.js";
import { factoryCandidateRow, factoryScoredRoots, factorySplitOfPurpose } from "./farmer-pi-corpus.js";
import { allocateAttempt, ledgerPools, transitionPool, type PoolState } from "./farmer-pi-pools.js";
import { PROTOCOL_PATH, loadProtocol, type FactoryProtocol } from "./farmer-pi-protocol.js";
import {
  FACTORY_ALPHA,
  FACTORY_DESIGN_DELTA,
  FACTORY_FORMAL_LADDER,
  FACTORY_OFFLINE_MIN_OVERRIDE_DEALS,
  FACTORY_OFFLINE_MIN_SELECTED_NONZERO_DEALS,
  FACTORY_PROMOTION_FLOOR,
  FACTORY_STAGE1_DEALS,
  IntegrityError,
  acquireRunLock,
  chooseFormalN,
  completedDeals,
  formalVerdict,
  offlineVerdict,
  readDealRecord,
  readJson,
  readManifest,
  requiredFormalN,
  sealStage,
  stableHash,
  stage1Decision,
  stageStatus,
  writeFileAtomic,
  writeManifest,
  writeVerdictOnce,
  type PiStageManifest,
} from "./farmer-pi-stage.js";
import {
  candidateChain,
  candidateLayer,
  championChainById,
  corpusConfigHash,
  factoryRowsFile,
} from "./farmer-pi-workers.js";

const CONTROL_MODE = process.env.AI_FPI_CONTROL;
const CONTROL_CONFIG = process.env.AI_FPI_CONTROL_CONFIG;
const ENABLED = CONTROL_MODE !== undefined;

/**
 * One control mode is bookkeeping (milliseconds) or a pass over a sealed corpus
 * (minutes). Neither is the thing the deadline stops, so this timeout is only a
 * backstop for a wedged process; the runner's absolute deadline and the host's
 * watchdog are the real limits.
 */
const CONTROL_TIMEOUT_MS = 2 * 60 * 60 * 1000;

describe.runIf(!ENABLED)("Factory v1 control plane (idle)", () => {
  it("does nothing without AI_FPI_CONTROL", () => {
    // This is an entry point for a runner, not part of `pnpm check`: with no
    // mode selected it must leave the suite exactly as it found it.
    expect(CONTROL_MODE === undefined).toBe(true);
  });
});

describe.runIf(ENABLED)("Farmer Policy Iteration Factory v1 control", () => {
  it("runs one control mode", () => {
    runControl();
  }, CONTROL_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// The config
// ---------------------------------------------------------------------------

/** One `{poolId, start, end}` as the attempt record and the ledger store it. */
export type ControlPool = Readonly<{ poolId: string; start: number; end: number }>;

/** The candidate layer, as the runner's `cf-export-model.py` call measured it. */
export type ControlLayer = Readonly<{
  artifactPath: string;
  modelSha256: string;
  /** The calibrated threshold this layer plays at. Covered by `armConfigHash`. */
  threshold: number;
  modelBytes: number;
}>;

/** The fields a finished step is allowed to record, and no others. */
export type RecordFields = Readonly<{
  threshold?: number;
  stage1?: Readonly<{ deals: number; mean: number; variance: number; proceed: boolean }>;
  formalPlan?: Readonly<{ required: number; n: number; powerCapped: boolean }>;
  formalN?: number;
  stopReason?: StopReason;
}>;

export type ControlConfig = Readonly<{
  mode: string;
  /** `<FPI_ROOT>`: where factory.json, attempts/ and the journals live. */
  root: string;
  protocolPath?: string;
  /** A rehearsal points at a copied ledger; the repo's own is the default. */
  ledgerPath?: string;
  attemptId?: string;
  runnerCommit?: string;
  runnerDirty?: boolean;
  at?: string;
  step?: AttemptStep;
  fields?: RecordFields;
  /** `open-stage`: `corpus` is a pool's deals, `arm` is one arm's, `record` is the seat above them. */
  role?: "corpus" | "arm" | "record";
  stage?: string;
  arm?: string;
  dir?: string;
  /** `strength-verdict`: the two arm directories, by arm. */
  dirs?: Readonly<Record<string, string>>;
  recordDir?: string;
  pool?: Readonly<{ poolId: string; purpose: string; start: number; end: number }>;
  pools?: Readonly<Record<string, ControlPool>>;
  championId?: string;
  layer?: ControlLayer;
  threshold?: number;
  /** `rows`: sealed corpus stages to read, in order, each with the purpose it holds. */
  sources?: readonly Readonly<{ dir: string; purpose: string }>[];
  outDir?: string;
  /** `status`. */
  elapsedMs?: number;
  workers?: number;
  errorCodes?: readonly string[];
  /** `ledger`. */
  poolId?: string;
  to?: PoolState;
  note?: string;
}>;

function field<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`The control config is missing "${name}".`);
  }
  return value;
}

function readConfig(): ControlConfig {
  const path = CONTROL_CONFIG;
  if (path === undefined) {
    throw new Error("AI_FPI_CONTROL_CONFIG is required when AI_FPI_CONTROL is set.");
  }
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`${path} does not hold a JSON object.`);
  }
  const config = parsed as ControlConfig;
  if (config.mode !== CONTROL_MODE) {
    throw new Error(
      `AI_FPI_CONTROL says "${String(CONTROL_MODE)}" and ${path} says "${config.mode}". ` +
      "A mode is selected once, by the file the runner wrote.",
    );
  }
  return config;
}

function runControl(): void {
  const config = readConfig();
  switch (config.mode) {
    case "register": register(config); return;
    case "next-step": nextStep(config); return;
    case "record": recordStep(config); return;
    case "resume": resume(config); return;
    case "decide": decide(config); return;
    case "ledger": movePool(config); return;
    case "open-stage": openStage(config); return;
    case "seal-stage": seal(config); return;
    case "rows": exportRows(config); return;
    case "calibrate": calibrate(config); return;
    case "offline": offlineScreen(config); return;
    case "formal-plan": formalPlan(config); return;
    case "strength-verdict": strengthVerdict(config); return;
    case "status": status(config); return;
    case "inspect": inspect(config); return;
    default:
      throw new Error(`Unknown control mode "${config.mode}".`);
  }
}

/** One machine-readable answer, prefixed so the runner can find it. */
function answer(line: string): void {
  process.stdout.write(`[fpi control] ${line}\n`);
}

function emit(value: unknown): void {
  answer(JSON.stringify(value));
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Shared paths, protocol, and the frozen-vs-protocol check
// ---------------------------------------------------------------------------

function protocolOf(config: ControlConfig): Readonly<{ protocol: FactoryProtocol; hash: string }> {
  return loadProtocol(config.protocolPath ?? PROTOCOL_PATH);
}

export function factoryPath(root: string): string {
  return join(root, "factory.json");
}

export function attemptDirFor(root: string, attemptId: string): string {
  return join(root, "attempts", attemptId);
}

/** A corpus stage is one directory; an arm stage is one directory per arm. */
export function stageDirFor(attemptDir: string, stage: string, arm?: string): string {
  return arm === undefined
    ? join(attemptDir, "stages", stage)
    : join(attemptDir, "stages", stage, arm);
}

export function recordDirFor(attemptDir: string, stage: string): string {
  return join(attemptDir, "verdicts", stage);
}

function readAttempt(root: string, attemptId: string): AttemptRecord {
  const path = join(attemptDirFor(root, attemptId), "attempt.json");
  if (!existsSync(path)) {
    throw new IntegrityError(`${attemptId} has no record at ${path}.`);
  }
  return readJson(path) as AttemptRecord;
}

function writeAttempt(root: string, attempt: AttemptRecord): void {
  writeJsonFile(join(attemptDirFor(root, attempt.attemptId), "attempt.json"), attempt);
}

function readFactory(root: string): FactoryState | null {
  const path = factoryPath(root);
  return existsSync(path) ? readJson(path) as FactoryState : null;
}

function writeFactory(root: string, factory: FactoryState, pendingAttemptId: string | null): void {
  writeJsonFile(factoryPath(root), { ...factory, pendingAttemptId });
}

function attemptIdsOnDisk(root: string): readonly string[] {
  const base = join(root, "attempts");
  if (!existsSync(base)) {
    return Object.freeze([]);
  }
  return Object.freeze(
    readdirSync(base).filter((name) => existsSync(join(base, name, "attempt.json"))).sort(),
  );
}

/**
 * The protocol's numbers against the frozen constants the code actually uses.
 *
 * Two documents describe the same experiment: the YAML the archive cites, and
 * the constants compiled into the verdict functions. They agree today. When they
 * stop agreeing, every number this Factory produces is computed under the code
 * and *named* after the file, and no reader could tell which one moved — so this
 * is an integrity failure before the first deal rather than a surprise at the
 * end. Where the protocol has no field for a frozen constant the constant is
 * checked against the value the protocol *does* carry, or against nothing at all.
 */
export function assertProtocolMatchesFrozen(protocol: FactoryProtocol): void {
  const mismatches: string[] = [];
  const check = (name: string, fromProtocol: unknown, frozen: unknown): void => {
    if (fromProtocol !== frozen) {
      mismatches.push(`${name}: protocol ${String(fromProtocol)} vs code ${String(frozen)}`);
    }
  };
  check(
    "calibration.thresholds",
    protocol.calibration.thresholds.join(","),
    CF_THRESHOLD_GRID.join(","),
  );
  check("calibration.minOverrideDeals", protocol.calibration.minOverrideDeals, CF_MIN_OVERRIDE_DEALS);
  check(
    "calibration.minSelectedNonzeroDeals",
    protocol.calibration.minSelectedNonzeroDeals,
    CF_MIN_SELECTED_NONZERO_DEALS,
  );
  check("offline.groups", protocol.offline.groups, 2_000);
  check(
    "offline.minOverrideDeals",
    protocol.offline.minOverrideDeals,
    FACTORY_OFFLINE_MIN_OVERRIDE_DEALS,
  );
  check(
    "offline.minSelectedNonzeroDeals",
    protocol.offline.minSelectedNonzeroDeals,
    FACTORY_OFFLINE_MIN_SELECTED_NONZERO_DEALS,
  );
  check("stage1.deals", protocol.stage1.deals, FACTORY_STAGE1_DEALS);
  check("attempt.stage1Deals", protocol.attempt.stage1Deals, FACTORY_STAGE1_DEALS);
  check("formal.alpha", protocol.formal.alpha, FACTORY_ALPHA);
  check("formal.promotionFloor", protocol.formal.promotionFloor, FACTORY_PROMOTION_FLOOR);
  check("formal.designDelta", protocol.formal.designDelta, FACTORY_DESIGN_DELTA);
  check("formal.ladder", protocol.formal.ladder.join(","), FACTORY_FORMAL_LADDER.join(","));
  if (mismatches.length > 0) {
    throw new IntegrityError(
      "The protocol and the frozen verdict code disagree, so no number this Factory produces " +
      `would have one name: ${mismatches.join("; ")}`,
    );
  }
}

/**
 * Whether a worker could build a chain for this champion at all.
 *
 * `championChainById` knows `ai-v1`; a research champion becomes loadable only
 * once its archive exists and the workers learn to read it. A Factory that
 * promoted and then discovered this at the *next* attempt's first corpus would
 * have spent an attempt finding out, so it is asked here, where the answer is
 * cheap and the alternative is a six-hour corpus that cannot start.
 */
function assertChampionLoadable(championId: string): void {
  if (championId === PI1_CHAMPION_ID) {
    return;
  }
  throw new IntegrityError(
    `The next attempt's champion is "${championId}", and no worker can load a chain for it yet: ` +
    `the loader is wired for ${PI1_CHAMPION_ID} only. The promotion is recorded and its archive ` +
    "is written; the next generation needs the archive loader before the Factory can continue.",
  );
}

// ---------------------------------------------------------------------------
// register — resume or create, then apply, archive and allocate
// ---------------------------------------------------------------------------

/** §13: the runner's commit is recorded beside the protocol hash, never as it. */
type StoredAttempt = AttemptRecord & Readonly<{
  runnerCommit: string | null;
  runnerDirty: boolean;
  model: Readonly<{ path: string; modelSha256: string; modelBytes: number }> | null;
}>;

function readStoredAttempt(root: string, attemptId: string): StoredAttempt {
  return readAttempt(root, attemptId) as StoredAttempt;
}

/**
 * Reads every attempt record on disk and returns the one that is not finished.
 *
 * "Not finished" is `outcome === null`, which includes a paused attempt: a
 * deadline pause is resumed by clearing the pause, and §47 is explicit that a
 * pause is not an INCOMPLETE result and not a pool retirement. Two unfinished
 * records is not a state the runner can produce, so it means something else did,
 * and it stops rather than picking one.
 */
function unfinishedAttempt(root: string): StoredAttempt | null {
  const open = attemptIdsOnDisk(root)
    .map((attemptId) => readStoredAttempt(root, attemptId))
    .filter((attempt) => attempt.outcome === null);
  if (open.length > 1) {
    throw new IntegrityError(
      `${open.length} attempts are unfinished at once (${open
        .map((attempt) => attempt.attemptId).join(", ")}). Only one attempt may be in flight.`,
    );
  }
  return open[0] ?? null;
}

function register(config: ControlConfig): void {
  const { protocol, hash } = protocolOf(config);
  assertProtocolMatchesFrozen(protocol);
  const root = field(config.root, "root");
  const at = field(config.at, "at");
  const ledger = config.ledgerPath === undefined ? {} : { path: config.ledgerPath };

  const pending = unfinishedAttempt(root);
  if (pending !== null) {
    assertAttemptProtocol(pending, hash);
    assertChampionLoadable(pending.parentChampionId);
    // The lock is taken here rather than at allocation so that a resumed run
    // holds it from its first transition, exactly as a fresh one does.
    const lockPath = acquireRunLock(attemptDirFor(root, pending.attemptId));
    emit({ created: false, attempt: pending, lockPath, stop: null });
    return;
  }

  let factory = readFactory(root);
  const recorded = new Set((factory?.attempts ?? []).map((attempt) => attempt.attemptId));
  const unapplied = attemptIdsOnDisk(root)
    .map((attemptId) => readStoredAttempt(root, attemptId))
    .filter((attempt) => attempt.outcome !== null && !recorded.has(attempt.attemptId));
  if (unapplied.length > 1) {
    throw new IntegrityError(
      `${unapplied.length} decisions have not reached the Factory (${unapplied
        .map((attempt) => attempt.attemptId).join(", ")}). One registration applies one attempt.`,
    );
  }
  const decided = unapplied[0] ?? null;
  if (factory === null) {
    if (decided !== null) {
      throw new IntegrityError("An attempt holds a decision, and the Factory has never started.");
    }
    factory = Object.freeze({
      championId: protocol.startChampion,
      generation: 1,
      attempts: Object.freeze([]),
      startedAt: at,
      updatedAt: at,
    });
  }
  if (decided !== null) {
    factory = applyOutcome(factory, summaryOf(decided), factory.generation, at);
    if (decided.outcome === "PROMOTE") {
      writeChampion(root, decided, factory, hash, at);
    }
    // Applying is written before allocating, so a crash between the two cannot
    // apply the same decision twice — which would advance the generation twice.
    writeFactory(root, factory, null);
  }

  const stop = factoryStopReason(factory, protocol);
  if (stop !== null) {
    writeFactory(root, factory, null);
    emit({ created: false, attempt: null, lockPath: null, stop });
    return;
  }
  const kind: AttemptKind | null = nextAttemptKind(factory, protocol);
  if (kind === null) {
    throw new IntegrityError("The Factory may continue, yet offers no kind for the next attempt.");
  }
  assertChampionLoadable(factory.championId);

  const attemptNumber = attemptsUsed(factory) + 1;
  const allocation = allocateAttempt({
    attemptNumber,
    kind,
    attemptId: attemptIdFor(attemptNumber),
    parentChampionId: factory.championId,
    protocolHash: hash,
    at,
    ...ledger,
  });
  const pools: Record<string, ControlPool> = {};
  for (const entry of allocation.pools) {
    pools[entry.purpose] = Object.freeze({
      poolId: `factory-v1/${allocation.attemptId}/${entry.purpose}`,
      start: entry.range.start,
      end: entry.range.end,
    });
  }
  const attempt: StoredAttempt = Object.freeze({
    attemptId: allocation.attemptId,
    attemptNumber,
    kind,
    parentChampionId: factory.championId,
    protocolHash: hash,
    pools: Object.freeze(pools),
    phase: "PLANNED",
    corpusDone: Object.freeze([]),
    threshold: null,
    stage1: null,
    formalPlan: null,
    formalN: null,
    stopReason: null,
    outcome: null,
    startedAt: at,
    updatedAt: at,
    runnerCommit: config.runnerCommit ?? null,
    runnerDirty: config.runnerDirty ?? false,
    model: null,
  });
  writeAttempt(root, attempt);
  writeFactory(root, factory, allocation.attemptId);
  const lockPath = acquireRunLock(attemptDirFor(root, allocation.attemptId));
  emit({ created: true, attempt, lockPath, stop: null });
}

/** The same name `attemptLayout` gives, computed without needing the ledger. */
function attemptIdFor(attemptNumber: number): string {
  return `attempt-${String(attemptNumber).padStart(3, "0")}`;
}

function summaryOf(attempt: StoredAttempt): AttemptSummary {
  if (attempt.outcome === null) {
    throw new IntegrityError(`${attempt.attemptId} has no outcome to apply.`);
  }
  return Object.freeze({
    attemptId: attempt.attemptId,
    kind: attempt.kind,
    parentChampionId: attempt.parentChampionId,
    outcome: attempt.outcome,
    stopReason: attempt.stopReason,
  });
}

/**
 * The champion archive a promotion writes, out of what is already on disk.
 *
 * Every number is copied from something sealed — the formal verdict's own
 * `mean`/`lower`/`n`, the attempt's pools, the artifact the model was exported
 * to — rather than recomputed, so the archive cannot disagree with the evidence
 * it cites. The chain is rebuilt from the parent chain plus the new layer, which
 * is what makes "πn is πn-1 plus one layer" a property of the archive rather
 * than a sentence in a document.
 */
function writeChampion(
  root: string,
  attempt: StoredAttempt,
  factory: FactoryState,
  protocolHash: string,
  at: string,
): void {
  const model = attempt.model;
  const threshold = attempt.threshold;
  const formalN = attempt.formalN;
  if (model === null || threshold === null || formalN === null) {
    throw new IntegrityError(
      `${attempt.attemptId} was promoted with no recorded model, threshold or formal N, so its ` +
      "champion's chain cannot be written down.",
    );
  }
  const attemptDir = attemptDirFor(root, attempt.attemptId);
  const formalDir = recordDirFor(attemptDir, "formal");
  const verdict = readJson(join(formalDir, "verdict.json")) as Readonly<{
    mean?: unknown; lower?: unknown; alpha?: unknown; arms?: unknown;
  }>;
  const layer = candidateLayer(Object.freeze({
    artifactPath: model.path,
    modelSha256: model.modelSha256,
    threshold,
    modelBytes: model.modelBytes,
  }));
  const parent = championChainById(attempt.parentChampionId);
  const chain = candidateChain(parent, layer);
  if (chain.championId !== researchChampionFor(factory.generation)) {
    throw new IntegrityError(
      `A promotion at generation ${factory.generation} built the chain ${chain.championId}.`,
    );
  }
  const archive: ChampionArchive = Object.freeze({
    championId: chain.championId,
    parentChampionId: chain.parentChampionId,
    generation: factory.generation,
    immutableGitTag: null,
    sourceCommit: attempt.runnerCommit ?? "unknown",
    researchOnly: true,
    layers: Object.freeze(chain.layers.map((entry, index) => Object.freeze({
      modelSha256: entry.modelSha256,
      threshold: entry.threshold,
      artifact: index < parent.layers.length
        ? parentArtifactPath(attempt.parentChampionId, entry.modelSha256)
        : relative(process.cwd(), model.path),
      modelBytes: entry.modelBytes,
    }))),
    modelChain: Object.freeze(chain.layers.map((entry) => entry.modelSha256)),
    schemaVersion: 2,
    schemaHash: cfSchemaHash(),
    baseMasterVersion: chain.baseMasterVersion,
    top3Version: chain.top3Version,
    pools: Object.freeze(Object.fromEntries(
      Object.entries(attempt.pools).map(([purpose, pool]) => [purpose, pool.poolId]),
    )),
    attemptId: attempt.attemptId,
    formalN,
    alpha: typeof verdict.alpha === "number" ? verdict.alpha : FACTORY_ALPHA,
    farmerDelta: typeof verdict.mean === "number" ? verdict.mean : null,
    lowerBound99: typeof verdict.lower === "number" ? verdict.lower : null,
    decision: "PROMOTE",
    runtimeCost: runtimeCostOf(verdict.arms),
    cumulativeModelBytes: cumulativeModelBytes(chain),
    createdAt: at,
  });
  const path = writeChampionArchive(archive);
  // The formal verdict is the archive's evidence, so it is copied beside the
  // archive: a champion read a year from now should not have to find a live
  // attempt directory to see what promoted it. The protocol hash is recorded
  // with it because the archive cites none of its own — the archive names a
  // champion, and the champion names the protocol it was measured under.
  writeJsonFile(join(CHAMPION_DIR, `${chain.championId}.formal.json`), {
    ...readJson(join(formalDir, "verdict.json")) as Record<string, unknown>,
    protocolHash,
    attemptId: attempt.attemptId,
  });
  answer(`champion ${chain.championId} layers ${chain.layers.length} archive ${path}`);
}

/** The timing numbers the formal stage recorded, for the archive. */
function runtimeCostOf(arms: unknown): Readonly<Record<string, number>> {
  if (arms === null || typeof arms !== "object") {
    return Object.freeze({});
  }
  const numbers: Record<string, number> = {};
  for (const [key, value] of Object.entries(arms)) {
    if (typeof value === "number") {
      numbers[key] = value;
    }
  }
  return Object.freeze(numbers);
}

/**
 * Where a parent layer's artifact lives.
 *
 * A research parent's path comes from its own archive, which recorded it. The
 * production champion has no archive — it is a release, not a Factory product —
 * so its layer's artifact is the module the product ships.
 */
function parentArtifactPath(parentChampionId: string, modelSha256: string): string {
  if (parentChampionId === PI1_CHAMPION_ID) {
    return "src/app/ai/cf-model-data.ts";
  }
  const archive = readChampionArchive(parentChampionId);
  const layer = archive.layers.find((entry: ArchivedLayer) => entry.modelSha256 === modelSha256);
  if (layer === undefined) {
    throw new IntegrityError(`Champion ${parentChampionId} has no archived layer ${modelSha256}.`);
  }
  return layer.artifact;
}

// ---------------------------------------------------------------------------
// next-step / record / resume / decide
// ---------------------------------------------------------------------------

function nextStep(config: ControlConfig): void {
  const { protocol, hash } = protocolOf(config);
  const root = field(config.root, "root");
  const attemptId = field(config.attemptId, "attemptId");
  const attempt = readAttempt(root, attemptId);
  assertAttemptProtocol(attempt, hash);
  emit({ step: nextAttemptStep(attempt, protocol) });
}

/**
 * Records one finished step.
 *
 * The decision fields are write-once: a threshold, a screen result, a formal N
 * or a stop is what a verdict was computed from, and a runner that could quietly
 * replace one could quietly re-decide an attempt.
 *
 * A stop is the exception to `phaseAfter`: its phase is left where the attempt
 * was, because a deadline pause is *cleared* rather than obeyed and clearing it
 * must resume the attempt exactly where it stopped (§47). A terminal stop never
 * needs the phase again — a stopped attempt is read for its reason, not its
 * position.
 */
function recordStep(config: ControlConfig): void {
  const { protocol, hash } = protocolOf(config);
  assertProtocolMatchesFrozen(protocol);
  const root = field(config.root, "root");
  const attemptId = field(config.attemptId, "attemptId");
  const at = field(config.at, "at");
  const step = field(config.step, "step");
  const attempt = readAttempt(root, attemptId);
  assertAttemptProtocol(attempt, hash);
  const fields: RecordFields = config.fields ?? {};
  const patch: Record<string, unknown> = { updatedAt: at };

  if (step.kind === "decide" || step.kind === "done") {
    throw new Error(
      `The ${step.kind} transition belongs to the decide mode, not to a phase record.`,
    );
  }
  if (step.kind === "stop") {
    if (fields.stopReason !== step.reason) {
      throw new IntegrityError(
        `The machine stops ${attemptId} for ${step.reason}${
          fields.stopReason === undefined ? "" : ` and the record says ${fields.stopReason}`
        }.`,
      );
    }
  } else {
    patch.phase = phaseAfter(step);
    if (step.kind === "corpus" && !attempt.corpusDone.includes(step.purpose)) {
      patch.corpusDone = Object.freeze([...attempt.corpusDone, step.purpose]);
    }
  }

  for (const [key, previous, next] of [
    ["threshold", attempt.threshold, fields.threshold],
    ["stage1", attempt.stage1, fields.stage1],
    ["formalPlan", attempt.formalPlan, fields.formalPlan],
    ["formalN", attempt.formalN, fields.formalN],
    ["stopReason", attempt.stopReason, fields.stopReason],
  ] as const) {
    if (next === undefined) {
      continue;
    }
    if (previous !== null && previous !== undefined) {
      throw new IntegrityError(`${attemptId} already records ${key}; it is written once.`);
    }
    patch[key] = next;
  }
  const updated = Object.freeze({ ...attempt, ...patch }) as AttemptRecord;
  writeAttempt(root, updated);
  emit({ attempt: updated });
}

/**
 * Clears a deadline pause.
 *
 * The one door that removes a `stopReason`, and it only opens for
 * `PAUSED_DEADLINE`: an integrity stop is a judgment about the data, and
 * resuming past one would re-read a stage the protocol has already decided was
 * damaged. The attempt's phase was never advanced by the pause, so there is
 * nothing else to undo.
 */
function resume(config: ControlConfig): void {
  const { hash } = protocolOf(config);
  const root = field(config.root, "root");
  const attemptId = field(config.attemptId, "attemptId");
  const attempt = readAttempt(root, attemptId);
  assertAttemptProtocol(attempt, hash);
  if (attempt.stopReason !== "PAUSED_DEADLINE") {
    throw new IntegrityError(
      `${attemptId} is ${
        attempt.stopReason === null ? "not stopped" : `stopped for ${attempt.stopReason}`
      }; only a deadline pause is resumed.`,
    );
  }
  const updated = Object.freeze({
    ...attempt,
    stopReason: null,
    updatedAt: field(config.at, "at"),
  }) as AttemptRecord;
  writeAttempt(root, updated);
  emit({ attempt: updated });
}

/**
 * The preregistered decision table, in one place.
 *
 * Nothing here is arithmetic. Every branch reads a field a frozen function
 * wrote: the offline screen's own decision string, the fact that calibration
 * selected no threshold, `stage1Decision`'s `proceed`, `formalVerdict`'s own
 * decision. The runner may not interpret a result, and neither may this — it
 * maps a recorded name to an outcome. The `detail` it prints is structural on
 * purpose: a verdict's `reasons` quote the numbers behind it, and those numbers
 * are exactly what the console may not carry while a run is deciding.
 */
function decide(config: ControlConfig): void {
  const { protocol, hash } = protocolOf(config);
  assertProtocolMatchesFrozen(protocol);
  const root = field(config.root, "root");
  const attemptId = field(config.attemptId, "attemptId");
  const attempt = readAttempt(root, attemptId);
  assertAttemptProtocol(attempt, hash);
  const decided = decideOutcome(attempt, attemptDirFor(root, attemptId));

  const updated = Object.freeze({
    ...attempt,
    phase: "DECIDED",
    outcome: decided.outcome,
    updatedAt: field(config.at, "at"),
  }) as AttemptRecord;
  writeAttempt(root, updated);
  answer(`${attemptId} ${decided.outcome} at ${decided.stage}: ${decided.detail}`);
  emit({ outcome: decided.outcome, stage: decided.stage, detail: decided.detail });
}

function decideOutcome(
  attempt: AttemptRecord,
  attemptDir: string,
): Readonly<{ outcome: "PROMOTE" | "REJECT"; stage: string; detail: string }> {
  if (attempt.threshold === null) {
    return Object.freeze({
      outcome: "REJECT",
      stage: "calibrate",
      detail: "calibration-no-go: no threshold cleared the support floors and the lower bound",
    });
  }
  const offline = readSealedVerdict(recordDirFor(attemptDir, "offline"));
  if (offline.decision !== "PASS") {
    // The offline screen has no `decide` step of its own: `nextAttemptStep`
    // routes OFFLINE onward unconditionally, so a SCREEN_REJECT is recorded
    // here, and the attempt ends without spending the Stage 1 pool.
    return Object.freeze({
      outcome: "REJECT",
      stage: "offline",
      detail: `offline ${String(offline.decision)} reasons ${
        Array.isArray(offline.reasons) ? offline.reasons.length : 0}`,
    });
  }
  if (attempt.stage1 === null || !attempt.stage1.proceed) {
    return Object.freeze({
      outcome: "REJECT",
      stage: "stage1",
      detail: "stage1: the candidate was not at least not worse on the screen",
    });
  }
  const verdict = readSealedVerdict(recordDirFor(attemptDir, "formal"));
  const decision = verdict.decision;
  if (decision !== "PROMOTE" && decision !== "REJECT") {
    throw new IntegrityError(
      `The formal verdict for ${attempt.attemptId} says ${JSON.stringify(decision)}; ` +
      "formalVerdict writes PROMOTE or REJECT and nothing else.",
    );
  }
  return Object.freeze({
    outcome: decision,
    stage: "formal",
    detail: `formal ${decision} reasons ${
      Array.isArray(verdict.reasons) ? verdict.reasons.length : 0}`,
  });
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

function movePool(config: ControlConfig): void {
  const ledger = config.ledgerPath === undefined ? {} : { path: config.ledgerPath };
  const poolId = field(config.poolId, "poolId");
  transitionPool({
    poolId,
    to: field(config.to, "to"),
    at: field(config.at, "at"),
    ...(config.note === undefined ? {} : { note: config.note }),
    ...ledger,
  });
  emit({ poolId, to: config.to });
}

// ---------------------------------------------------------------------------
// Manifests and seals
// ---------------------------------------------------------------------------

/**
 * Writes the manifest a stage runs under, before its first deal.
 *
 * The config hash is computed here, by the same frozen functions the worker will
 * compute it with, because `verifyStage` compares the two: a manifest whose hash
 * was guessed would seal nothing. The three shapes:
 *
 *   - `corpus` — the pool's deals, `arms: [null]`, `corpusConfigHash`;
 *   - `arm` — one arm of a strength stage, `arms: [thatArm]`, `armConfigHash`;
 *   - `record` — the seat above the two arms: no deals of its own, so it can be
 *     sealed (and therefore hold a verdict) without a second payload.
 */
function openStage(config: ControlConfig): void {
  const { hash } = protocolOf(config);
  const root = field(config.root, "root");
  const attemptId = field(config.attemptId, "attemptId");
  const stage = field(config.stage, "stage");
  const pool = field(config.pool, "pool");
  const at = field(config.at, "at");
  const attemptDir = attemptDirFor(root, attemptId);
  const role = field(config.role, "role");
  const deals = pool.end - pool.start + 1;

  let dir: string;
  let configHash: string;
  let arms: readonly (string | null)[];
  let planned: number;
  let plan: Readonly<Record<string, unknown>>;
  if (role === "record") {
    dir = recordDirFor(attemptDir, stage);
    configHash = stableHash({
      kind: "farmer-pi-stage-record", attemptId, stage, protocolHash: hash,
    });
    arms = Object.freeze([]);
    planned = 0;
    plan = Object.freeze({ protocolHash: hash, poolId: pool.poolId, purpose: pool.purpose, start: pool.start, deals });
  } else if (role === "arm") {
    const arm = farmArm(field(config.arm, "arm"));
    const base = championChainById(field(config.championId, "championId"));
    const chain = config.layer === undefined ? base : candidateChainOf(base, config.layer);
    dir = stageDirFor(attemptDir, stage, arm);
    configHash = armConfigHash({ chain, arm, protocolHash: hash });
    arms = Object.freeze([arm]);
    planned = deals;
    plan = Object.freeze({
      protocolHash: hash,
      poolId: pool.poolId,
      purpose: pool.purpose,
      start: pool.start,
      deals,
      arm,
      championId: chain.championId,
      layers: chain.layers.length,
    });
  } else {
    if (pool.purpose !== stage) {
      throw new Error(
        `A corpus stage is named by its purpose: stage "${stage}" cannot run pool ` +
        `"${pool.purpose}".`,
      );
    }
    const chain = championChainById(field(config.championId, "championId"));
    dir = stageDirFor(attemptDir, stage);
    configHash = corpusConfigHash({
      pool: Object.freeze({
        poolId: pool.poolId,
        purpose: pool.purpose,
        range: Object.freeze({ start: pool.start, end: pool.end }),
      }),
      chain,
      protocolHash: hash,
      attemptId,
    });
    arms = Object.freeze([null]);
    planned = deals;
    plan = Object.freeze({
      protocolHash: hash,
      poolId: pool.poolId,
      purpose: pool.purpose,
      start: pool.start,
      deals,
      championId: chain.championId,
    });
  }

  const manifest: PiStageManifest = Object.freeze({
    stage,
    attemptId,
    arms,
    configHash,
    config: plan,
    poolId: pool.poolId,
    start: pool.start,
    deals: planned,
    completion: "RUNNING",
    hashes: Object.freeze({}),
    updatedAt: at,
    sealedAt: null,
  });
  if (existsSync(join(dir, "manifest.json"))) {
    const existing = readManifest(dir);
    if (existing.configHash !== configHash || existing.deals !== planned) {
      throw new IntegrityError(
        `${dir} already has a manifest under another plan (${existing.configHash}, ` +
        `${existing.deals} deals). A stage is opened once.`,
      );
    }
    emit({ dir, configHash, opened: false, deals: existing.deals, completion: existing.completion });
    return;
  }
  writeManifest(dir, manifest);
  emit({ dir, configHash, opened: true, deals: planned, completion: manifest.completion });
}

function farmArm(value: string): FarmerArm {
  const arm = FARMER_ARMS.find((candidate) => candidate === value);
  if (arm === undefined) {
    throw new Error(`"${value}" is not an arm; expected one of ${FARMER_ARMS.join(", ")}.`);
  }
  return arm;
}

/**
 * The candidate arm's chain: the champion's own layers plus one.
 *
 * The threshold travels with the layer, so the value the arm plays at is the
 * value `armConfigHash` covers — an arm that ran at a threshold other than the
 * one the attempt calibrated would produce a complete stage and a meaningless
 * result.
 */
function candidateChainOf(base: ChampionChain, layer: ControlLayer): ChampionChain {
  return candidateChain(base, candidateLayer(Object.freeze({
    artifactPath: layer.artifactPath,
    modelSha256: layer.modelSha256,
    threshold: layer.threshold,
    modelBytes: layer.modelBytes,
  })));
}

function seal(config: ControlConfig): void {
  const dir = field(config.dir, "dir");
  const sealed = sealStage(dir, field(config.at, "at"));
  emit({
    dir,
    stage: sealed.stage,
    arms: sealed.arms,
    deals: sealed.deals,
    completion: sealed.completion,
    checkpoints: Object.keys(sealed.hashes).length,
  });
}

// ---------------------------------------------------------------------------
// Sealed reads (§6)
// ---------------------------------------------------------------------------

/**
 * The gate in front of every payload read in this file.
 *
 * A stage's deal records hold the very numbers the whole no-peek discipline is
 * about, and they are written while the stage runs. Nothing here may look at one
 * until the manifest says SEALED, and the manifest only reaches SEALED through
 * `sealStage`, which flushes and re-verifies first. Exported because the rule is
 * worth naming where it is applied rather than leaving it implicit in a call to
 * `readManifest`.
 */
export function readSealedStage(dir: string): PiStageManifest {
  const manifest = readManifest(dir);
  if (manifest.completion !== "SEALED") {
    throw new IntegrityError(
      `Stage ${manifest.stage} at ${dir} is ${manifest.completion}; its payload may only be read ` +
      "after it is sealed.",
    );
  }
  return manifest;
}

function readSealedVerdict(dir: string): Readonly<Record<string, unknown>> {
  readSealedStage(dir);
  const path = join(dir, "verdict.json");
  if (!existsSync(path)) {
    throw new IntegrityError(`Sealed stage ${dir} has no verdict.`);
  }
  return readJson(path) as Readonly<Record<string, unknown>>;
}

/**
 * Every group of a sealed corpus stage, in deal order.
 *
 * The deal records are the authority on what was computed and the manifest is
 * the authority on what was promised, so each record is re-hashed on the way in.
 * A payload edited after the seal is a corpus nobody can re-run, and this is the
 * last moment it can be caught before it trains a model or picks a threshold.
 */
function sealedGroups(dir: string): readonly CfGroupResult[] {
  const manifest = readSealedStage(dir);
  const indexes = completedDeals(dir, null);
  if (indexes.length !== manifest.deals) {
    throw new IntegrityError(`${dir} records ${indexes.length} deals and planned ${manifest.deals}.`);
  }
  const groups: CfGroupResult[] = [];
  for (const dealIndex of indexes) {
    const record = readDealRecord(dir, null, dealIndex);
    const recomputed = stableHash(record.payload);
    if (recomputed !== record.artifactHash) {
      throw new IntegrityError(
        `Deal ${dealIndex} of ${dir} hashes to ${recomputed} and claims ${record.artifactHash}.`,
      );
    }
    const group = record.payload as CfGroupResult;
    if (group.dealIndex !== dealIndex || group.groupId !== `deal-${dealIndex}`) {
      throw new IntegrityError(
        `Deal ${dealIndex} of ${dir} holds group ${group.groupId} for deal ${group.dealIndex}.`,
      );
    }
    groups.push(group);
  }
  return Object.freeze(groups);
}

/**
 * The split a deal index belongs to, per the attempt's own allocation.
 *
 * The Factory's splits are by purpose, not by v1's universe table: a
 * 200,001..450,000 deal has no v1 split at all, so the default resolver would
 * report every group as misfiled — and a split audit that always fails is a
 * guard nobody reads. This resolver answers from the pools the attempt actually
 * registered, and `undefined` for a deal none of them owns, which is exactly the
 * group this audit exists to catch.
 */
export function splitResolver(
  pools: Readonly<Record<string, ControlPool>>,
): (dealIndex: number) => CfSplit | undefined {
  const ranges = Object.entries(pools).map(([purpose, pool]) => Object.freeze({
    purpose, start: pool.start, end: pool.end,
  }));
  return (dealIndex: number): CfSplit | undefined => {
    const hit = ranges.find((range) => dealIndex >= range.start && dealIndex <= range.end);
    return hit === undefined ? undefined : factorySplitOfPurpose(hit.purpose);
  };
}

/** The structural audit as the integrity flag the frozen verdicts take. */
export function auditFlag(audit: CfStructuralAudit): boolean {
  return audit.splitMismatches === 0 && audit.schemaMismatches === 0 &&
    audit.labelIntegrityFailures === 0 && audit.productionIndexFailures === 0;
}

function auditDetail(audit: CfStructuralAudit, where: string): string {
  return `${where}: groups ${audit.groups} snapshots ${audit.snapshots} ` +
    `withSnapshots ${audit.groupsWithSnapshots} splitMismatches ${audit.splitMismatches} ` +
    `schemaMismatches ${audit.schemaMismatches} ` +
    `labelIntegrityFailures ${audit.labelIntegrityFailures} ` +
    `productionIndexFailures ${audit.productionIndexFailures}`;
}

// ---------------------------------------------------------------------------
// rows — the training corpus
// ---------------------------------------------------------------------------

type CfTrainRow = Readonly<{ id: string; x: readonly number[]; y: number; w: number }>;
type CfTrainFile = Readonly<{
  schemaHash: string;
  featureNames: readonly string[];
  rows: readonly CfTrainRow[];
}>;

/**
 * The rows a booster trains on, from sealed corpus stages.
 *
 * The rows and the weights come from the frozen `factoryRowsFile`; the ids come
 * from the same traversal expressed as `(snapshotId, candidateOrder)` and are
 * checked against it, so a change in the row order is an error here rather than
 * a corpus whose labels silently belong to their neighbours.
 *
 * More than one source is normal: a retry trains on the rejected base attempt's
 * `train` pool *and* its own `train-fresh` pool, and both are the `train` split.
 * The order of `sources` is therefore part of the corpus, and the ids say so.
 */
function exportRows(config: ControlConfig): void {
  const outDir = field(config.outDir, "outDir");
  const bySplit = new Map<CfSplit, CfGroupResult[]>();
  for (const source of field(config.sources, "sources")) {
    const split = factorySplitOfPurpose(source.purpose);
    const bucket = bySplit.get(split) ?? [];
    for (const group of sealedGroups(source.dir)) {
      bucket.push(group);
    }
    bySplit.set(split, bucket);
  }
  for (const [split, groups] of bySplit) {
    if (split !== "train" && split !== "calibration") {
      throw new Error(
        `Rows are exported for train and calibration only; ${split} has ${groups.length} groups.`,
      );
    }
  }
  const written: string[] = [];
  for (const split of ["train", "calibration"] as const) {
    const groups = bySplit.get(split);
    if (groups === undefined || groups.length === 0) {
      throw new Error(`The rows export needs a ${split} source; it was given none.`);
    }
    const file = factoryRowsFile(groups, split);
    const ids: string[] = [];
    for (const group of groups) {
      for (const snapshot of group.snapshots) {
        for (let order = 0; order < snapshot.candidates.length; order += 1) {
          // `factoryCandidateRow` answers `null` for the reference action, which
          // is exactly the row `cfRows` omits — so the id list is derived by the
          // same predicate rather than by a second copy of it.
          if (factoryCandidateRow(snapshot, order) === null) {
            continue;
          }
          ids.push(cfRowId(snapshot.meta.snapshotId, order));
        }
      }
    }
    if (ids.length !== file.rows.length) {
      throw new IntegrityError(
        `${split} has ${file.rows.length} rows and ${ids.length} non-reference candidates.`,
      );
    }
    const rows = file.rows.map((row, index) => {
      const id = ids[index];
      const weight = file.weights[index];
      if (id === undefined || weight === undefined) {
        throw new IntegrityError(`${split} row ${index} has no id or no weight.`);
      }
      if (!id.startsWith(`${row.snapshotId}#`)) {
        throw new IntegrityError(
          `${split} row ${index} is snapshot ${row.snapshotId} and was named ${id}; the row ` +
          "order and the candidate order have drifted apart.",
        );
      }
      return Object.freeze({ id, x: row.x, y: row.y, w: weight }) satisfies CfTrainRow;
    });
    const path = join(outDir, `${split}.rows.json`);
    writeJsonFile(path, Object.freeze({
      schemaHash: cfSchemaHash(),
      featureNames: CF_FEATURE_NAMES,
      rows: Object.freeze(rows),
    }) satisfies CfTrainFile);
    written.push(`${path} (${rows.length} rows)`);
  }
  answer(written.join("; "));
}

// ---------------------------------------------------------------------------
// calibrate — the threshold (§16)
// ---------------------------------------------------------------------------

/** The packaged candidate layer's model, read the way the chain will read it. */
function layerModel(config: ControlConfig): TreeModel {
  const layer = field(config.layer, "layer");
  const text = readFileSync(layer.artifactPath, "utf8");
  const model = parseTreeModel(JSON.parse(text) as Parameters<typeof parseTreeModel>[0]);
  if (model.modelSha256 !== layer.modelSha256) {
    throw new IntegrityError(
      `${layer.artifactPath} claims model ${model.modelSha256}; the attempt registered ` +
      `${layer.modelSha256}.`,
    );
  }
  if (Buffer.byteLength(text, "utf8") !== layer.modelBytes) {
    throw new IntegrityError(
      `${layer.artifactPath} is ${Buffer.byteLength(text, "utf8")} bytes; the attempt ` +
      `registered ${layer.modelBytes}.`,
    );
  }
  return model;
}

/** Every root of a sealed corpus, scored by the candidate layer. */
function rootScores(
  groups: readonly CfGroupResult[],
  model: TreeModel,
): Readonly<{ roots: readonly CfScoredRoot[]; rootCounts: ReadonlyMap<string, number> }> {
  const byId = new Map<string, CfGroupResult["snapshots"][number]>();
  const rootCounts = new Map<string, number>();
  for (const group of groups) {
    rootCounts.set(group.groupId, group.snapshots.length);
    for (const snapshot of group.snapshots) {
      byId.set(snapshot.meta.snapshotId, snapshot);
    }
  }
  const scoreOf = (snapshotId: string, candidateOrder: number): number => {
    const snapshot = byId.get(snapshotId);
    if (snapshot === undefined) {
      throw new IntegrityError(`No snapshot ${snapshotId} in this sealed stage.`);
    }
    const row = factoryCandidateRow(snapshot, candidateOrder);
    if (row === null) {
      throw new IntegrityError(
        `${snapshotId}#${candidateOrder} is the reference action; a layer never scores it.`,
      );
    }
    return scoreTrees(model, row.x);
  };
  const roots: CfScoredRoot[] = [];
  for (const group of groups) {
    for (const root of factoryScoredRoots(group, scoreOf)) {
      roots.push(root);
    }
  }
  return Object.freeze({ roots: Object.freeze(roots), rootCounts });
}

function calibrate(config: ControlConfig): void {
  const { protocol } = protocolOf(config);
  assertProtocolMatchesFrozen(protocol);
  const root = field(config.root, "root");
  const attemptId = field(config.attemptId, "attemptId");
  const attemptDir = attemptDirFor(root, attemptId);
  assertTrainingConfig(attemptDir, protocol);

  const dir = field(config.dir, "dir");
  const groups = sealedGroups(dir);
  const audit = cfAuditStructure(groups, "calibration", splitResolver(field(config.pools, "pools")));
  if (!auditFlag(audit)) {
    // `cfSelectThreshold` is a pure function of the choices and takes no
    // integrity flag, so a calibration corpus that cannot be vouched for must
    // stop the attempt rather than select a threshold from it.
    throw new IntegrityError(
      `The calibration corpus cannot select a threshold — ${auditDetail(audit, dir)}.`,
    );
  }
  const model = layerModel(config);
  const { roots, rootCounts } = rootScores(groups, model);
  const thresholds = protocol.calibration.thresholds;
  const outcomes = thresholds.map((threshold) => cfThresholdOutcome(
    roots.map((scored) => cfChooseOverride(scored, threshold)),
    groups.map((group) => group.groupId),
    rootCounts,
    threshold,
    tQuantile,
  ));
  const decision = cfSelectThreshold(outcomes);
  const selected = decision.reason === "selected" ? decision.selected : null;
  writeJsonFile(join(attemptDir, "calibration.json"), {
    reason: decision.reason,
    // `cfSelectThreshold` says "never override" with `Infinity`, which is not a
    // threshold an attempt may carry into an arm. The machine's `threshold ===
    // null` is what routes a no-go to `decide`; `Infinity` would route it to the
    // offline screen instead, where it would screen a candidate that had already
    // failed.
    selected,
    eligible: decision.eligible,
    modelSha256: model.modelSha256,
    groups: groups.length,
    snapshots: audit.snapshots,
    audit,
    outcomes,
  });
  answer(
    `calibration ${decision.reason} groups ${groups.length} snapshots ${audit.snapshots} ` +
    `eligible ${decision.eligible.length} roots ${roots.length}`,
  );
  emit({ reason: decision.reason, selected });
}

/**
 * The training config a booster was actually trained with, against the protocol.
 *
 * The protocol's `model` block and `cf-train.py`'s frozen parameters are two
 * descriptions of one training run, and the booster only means anything if they
 * agree: every key the protocol names must be in the config with that value, and
 * the only keys the config may carry beyond them are the two the frozen script
 * has always had and the protocol has never listed (`metric: l2`,
 * `verbosity: -1`). A literal set equality is not available — those two exist on
 * one side only — and inventing a third document to hold them would be worse
 * than naming them here.
 */
export function assertTrainingConfig(attemptDir: string, protocol: FactoryProtocol): void {
  const path = join(attemptDir, "train", "train-config.json");
  if (!existsSync(path)) {
    throw new IntegrityError(`No training config at ${path}; the model has no provenance.`);
  }
  const config = readJson(path) as Readonly<Record<string, unknown>>;
  const params = config.params;
  if (params === null || typeof params !== "object") {
    throw new IntegrityError(`${path} has no params.`);
  }
  const actual = params as Readonly<Record<string, unknown>>;
  const expected: Readonly<Record<string, unknown>> = {
    objective: protocol.model.objective,
    num_iterations: protocol.model.iterations,
    max_depth: protocol.model.maxDepth,
    num_leaves: protocol.model.numLeaves,
    learning_rate: protocol.model.learningRate,
    min_data_in_leaf: protocol.model.minDataInLeaf,
    lambda_l1: protocol.model.lambdaL1,
    lambda_l2: protocol.model.lambdaL2,
    feature_fraction: protocol.model.featureFraction,
    bagging_fraction: protocol.model.baggingFraction,
    bagging_freq: protocol.model.baggingFreq,
    max_bin: protocol.model.maxBin,
    num_threads: protocol.model.threads,
    deterministic: protocol.model.deterministic,
    force_col_wise: protocol.model.forceColWise,
    seed: protocol.model.seed,
    data_random_seed: protocol.model.seed,
  };
  const mismatches: string[] = [];
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) {
      mismatches.push(`${key}: protocol ${String(value)} vs trained ${String(actual[key])}`);
    }
  }
  const extras = Object.keys(actual).filter((key) => !(key in expected)).sort();
  if (extras.join(",") !== "metric,verbosity") {
    mismatches.push(`unlisted training parameters: ${extras.join(", ") || "none"}`);
  }
  if (actual.metric !== "l2" || actual.verbosity !== -1) {
    mismatches.push(`metric ${String(actual.metric)} verbosity ${String(actual.verbosity)}`);
  }
  if (config.lightgbmVersion !== protocol.model.lightgbmVersion) {
    mismatches.push(
      `lightgbm ${String(config.lightgbmVersion)} vs protocol ${protocol.model.lightgbmVersion}`,
    );
  }
  if (config.schemaHash !== cfSchemaHash()) {
    mismatches.push(`schema ${String(config.schemaHash)} vs frozen ${cfSchemaHash()}`);
  }
  if (mismatches.length > 0) {
    throw new IntegrityError(
      `The model at ${path} was not trained under this protocol: ${mismatches.join("; ")}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// offline — the screen (§15)
// ---------------------------------------------------------------------------

function offlineScreen(config: ControlConfig): void {
  const { protocol } = protocolOf(config);
  assertProtocolMatchesFrozen(protocol);
  const dir = field(config.dir, "dir");
  const threshold = field(config.threshold, "threshold");
  const groups = sealedGroups(dir);
  const audit = cfAuditStructure(groups, "heldout", splitResolver(field(config.pools, "pools")));
  const model = layerModel(config);
  const { roots, rootCounts } = rootScores(groups, model);
  const outcome = cfThresholdOutcome(
    roots.map((scored) => cfChooseOverride(scored, threshold)),
    groups.map((group) => group.groupId),
    rootCounts,
    threshold,
    tQuantile,
  );
  const verdict = offlineVerdict({
    perGroup: outcome.perGroup,
    overrideDeals: outcome.overrideDeals,
    selectedNonzeroDeals: outcome.selectedNonzeroDeals,
    integrityValid: auditFlag(audit),
  });
  writeVerdictOnce(field(config.recordDir, "recordDir"), Object.freeze({
    ...verdict,
    threshold,
    modelSha256: model.modelSha256,
    audit,
  }));
  answer(
    `offline ${verdict.decision} groups ${verdict.groups} overrides ${outcome.overrides} ` +
    `overrideDeals ${verdict.overrideDeals} selectedNonzero ${verdict.selectedNonzeroDeals}`,
  );
  emit({
    decision: verdict.decision,
    groups: verdict.groups,
    overrideDeals: verdict.overrideDeals,
    selectedNonzeroDeals: verdict.selectedNonzeroDeals,
    reasons: verdict.reasons,
  });
}

// ---------------------------------------------------------------------------
// The formal plan (§19)
// ---------------------------------------------------------------------------

function formalPlan(config: ControlConfig): void {
  const { protocol } = protocolOf(config);
  assertProtocolMatchesFrozen(protocol);
  const root = field(config.root, "root");
  const attemptId = field(config.attemptId, "attemptId");
  const verdict = readSealedVerdict(field(config.recordDir, "recordDir"));
  const variance = verdict.variance;
  if (typeof variance !== "number" || !Number.isFinite(variance)) {
    throw new IntegrityError("The Stage 1 verdict carries no variance to size the formal test on.");
  }
  const plan = chooseFormalN(requiredFormalN(variance, protocol.formal.designDelta));
  const reserve = field(config.pool, "pool");
  const available = reserve.end - reserve.start + 1;
  if (plan.n > available) {
    throw new IntegrityError(
      `The plan asks for ${plan.n} formal deals and the reserve holds ${available}.`,
    );
  }
  writeJsonFile(join(attemptDirFor(root, attemptId), "formal-plan.json"), plan);
  answer(`formal plan n ${plan.n} of ${available} reserve, powerCapped ${String(plan.powerCapped)}`);
  emit(plan);
}

// ---------------------------------------------------------------------------
// strength-verdict — Stage 1 and the formal test
// ---------------------------------------------------------------------------

/**
 * One arm's frozen result, read from its own sealed stage directory.
 *
 * Two structural checks come out of this, and both are about the *installation*
 * rather than about the candidate: the landlord arm must be identical in the two
 * arms (it plays the same three games either way, so a difference means the
 * wiring leaked the candidate into the landlord seat), and every deal must hold
 * the three games it was registered for. The landlord invariant raises here
 * because it is a fault to review; the game count becomes `formalVerdict`'s
 * integrity flag, because it is an outcome the frozen rule already knows how to
 * fail closed on.
 */
function armResult(
  dir: string,
  arm: FarmerArm,
  stage: string,
): Readonly<{ result: FarmerArmResult; gamesOk: boolean }> {
  const manifest = readSealedStage(dir);
  if (manifest.stage !== stage || manifest.arms.length !== 1 || manifest.arms[0] !== arm) {
    throw new IntegrityError(
      `${dir} is stage ${manifest.stage} with arms ${JSON.stringify(manifest.arms)}; ` +
      `this is ${stage}'s ${arm} arm.`,
    );
  }
  const indexes = completedDeals(dir, arm);
  if (indexes.length !== manifest.deals) {
    throw new IntegrityError(`${dir} has ${indexes.length} ${arm} deals of ${manifest.deals}.`);
  }
  const accumulator = emptyArmAccumulator(arm, manifest.start);
  let gamesOk = true;
  for (const dealIndex of indexes) {
    const record = readDealRecord(dir, arm, dealIndex);
    if (record.arm !== arm || record.stage !== stage) {
      throw new IntegrityError(`${dir} deal ${dealIndex} is ${record.stage}/${String(record.arm)}.`);
    }
    const payload = record.payload as FarmerDealPayload;
    if (payload.dealIndex !== dealIndex) {
      throw new IntegrityError(`${dir} deal ${dealIndex} holds payload ${payload.dealIndex}.`);
    }
    if (payload.gamesA !== 3 || payload.gamesB !== 3) {
      gamesOk = false;
    }
    accumulateDeal(accumulator, Object.freeze({
      payload,
      cost: costOf(record.cost),
    }) satisfies FarmerDealOutcome);
  }
  return Object.freeze({ result: freezeArm(accumulator), gamesOk });
}

/** The record's timing block, whose shape the arm's own writer fixed. */
function costOf(cost: unknown): FarmerDealCost {
  if (cost === null || typeof cost !== "object") {
    return Object.freeze({ elapsedMs: 0, inferenceMs: 0 });
  }
  const block = cost as Readonly<Record<string, unknown>>;
  return Object.freeze({
    elapsedMs: typeof block.elapsedMs === "number" ? block.elapsedMs : 0,
    inferenceMs: typeof block.inferenceMs === "number" ? block.inferenceMs : 0,
  });
}

function strengthVerdict(config: ControlConfig): void {
  const { protocol } = protocolOf(config);
  assertProtocolMatchesFrozen(protocol);
  const stage = field(config.stage, "stage");
  const dirs = field(config.dirs, "dirs");
  const championDir = dirs.champion;
  const candidateDir = dirs.candidate;
  if (championDir === undefined || candidateDir === undefined) {
    throw new Error("A strength verdict needs both arm directories.");
  }
  const champion = armResult(championDir, "champion", stage);
  const candidate = armResult(candidateDir, "candidate", stage);
  const deals = champion.result.winsB.length;
  for (let index = 0; index < deals; index += 1) {
    if (champion.result.winsA[index] !== candidate.result.winsA[index]) {
      throw new IntegrityError(
        `Deal ${champion.result.start + index}: the landlord arm scored ` +
        `${String(champion.result.winsA[index])} and ${String(candidate.result.winsA[index])}. ` +
        "The two arms differ in one thing only, and the landlord seat is not it.",
      );
    }
  }
  const arms = Object.freeze({
    champion: armResultHash(champion.result),
    candidate: armResultHash(candidate.result),
    championInferenceMs: champion.result.inferenceMs,
    candidateInferenceMs: candidate.result.inferenceMs,
    championElapsedMs: champion.result.elapsedMs,
    candidateElapsedMs: candidate.result.elapsedMs,
  });
  const recordDir = field(config.recordDir, "recordDir");
  const differences = pairedFarmerDifferences(champion.result, candidate.result);
  const integrityValid = champion.gamesOk && candidate.gamesOk;
  if (stage === "stage1") {
    const screen = stage1Decision(differences);
    writeVerdictOnce(recordDir, Object.freeze({
      stage,
      deals: screen.deals,
      mean: screen.mean,
      variance: screen.variance,
      proceed: screen.proceed,
      arms,
      alpha: null,
      integrityValid,
    }));
    answer(`stage1 deals ${screen.deals} proceed ${String(screen.proceed)}`);
    emit({
      deals: screen.deals,
      mean: screen.mean,
      variance: screen.variance,
      proceed: screen.proceed,
      integrityValid,
    });
    return;
  }
  const verdict = formalVerdict(differences, integrityValid, protocol.formal.alpha);
  writeVerdictOnce(recordDir, Object.freeze({
    ...verdict,
    stage,
    arms,
    designDelta: protocol.formal.designDelta,
    promotionFloor: protocol.formal.promotionFloor,
  }));
  answer(
    `formal n ${verdict.n} decision ${verdict.decision} reasons ${verdict.reasons.length} ` +
    `integrity ${String(verdict.integrityValid)}`,
  );
  emit({
    n: verdict.n,
    mean: verdict.mean,
    lower: verdict.lower,
    alpha: verdict.alpha,
    decision: verdict.decision,
    reasons: verdict.reasons,
  });
}

// ---------------------------------------------------------------------------
// status and inspect
// ---------------------------------------------------------------------------

function status(config: ControlConfig): void {
  const stage = stageStatus({
    dir: field(config.dir, "dir"),
    elapsedMs: field(config.elapsedMs, "elapsedMs"),
    workers: field(config.workers, "workers"),
    ...(config.errorCodes === undefined ? {} : { errorCodes: config.errorCodes }),
  });
  answer(JSON.stringify(stage));
}

/**
 * What an operator may look at, and where the line runs.
 *
 * A stage that is not sealed has a plan, a set of completion counts and a hash
 * table, and nothing else may leave it — so its section is exactly those three
 * things. A sealed stage may also show its verdict's *name* and the digest of
 * the file it is in; the verdict's numbers stay on disk, because the operator who
 * needs them reads the file this section just vouched for.
 *
 * The attempt section follows the same rule one level up: until every stage the
 * attempt touched is sealed, its record is projected down to fields that cannot
 * carry a strength, and it is printed whole only once there is nothing left to
 * leak.
 */
function inspect(config: ControlConfig): void {
  const root = field(config.root, "root");
  const ledger = config.ledgerPath === undefined ? {} : { path: config.ledgerPath };
  const attempts = attemptIdsOnDisk(root).map((attemptId) => Object.freeze({
    attemptId,
    dir: attemptDirFor(root, attemptId),
    record: readStoredAttempt(root, attemptId),
  }));
  const stages: Readonly<Record<string, unknown>>[] = [];
  for (const attempt of attempts) {
    for (const dir of stageDirsOf(attempt.dir)) {
      stages.push(stageView(dir, attempt.attemptId));
    }
  }
  const archives = existsSync(CHAMPION_DIR)
    ? readdirSync(CHAMPION_DIR)
      .filter((name) => name.endsWith(".json") && !name.endsWith(".formal.json"))
      .sort()
      .map((name) => archiveView(join(CHAMPION_DIR, name)))
    : [];

  // The protocol and its hash are public — they are the document of record —
  // and the runner needs the numbers in them (the screen's size, the model
  // block it checks the trained booster against). Everything a stage payload
  // holds stays where it is: `stageView` above is the only thing this mode
  // knows how to build out of a stage directory.
  const { protocol, hash } = protocolOf(config);
  emit({
    runnerCommit: config.runnerCommit ?? null,
    runnerDirty: config.runnerDirty ?? null,
    protocolHash: hash,
    protocol,
    schemaHash: cfSchemaHash(),
    factory: readFactory(root),
    pools: poolsOf(ledger),
    archives,
    stages,
    attempts: attempts.map((attempt) => attempt.record.outcome !== null && stages.every(
      (stage) => stage.sealed === true,
    )
      ? attempt.record
      : Object.freeze({
        attemptId: attempt.record.attemptId,
        attemptNumber: attempt.record.attemptNumber,
        kind: attempt.record.kind,
        parentChampionId: attempt.record.parentChampionId,
        protocolHash: attempt.record.protocolHash,
        phase: attempt.record.phase,
        corpusDone: attempt.record.corpusDone,
        pools: attempt.record.pools,
        formalN: attempt.record.formalN,
        thresholdFrozen: attempt.record.threshold !== null,
        screenFrozen: attempt.record.stage1 !== null,
        planSized: attempt.record.formalPlan !== null,
        decisionRecorded: attempt.record.outcome !== null,
        stopRecorded: attempt.record.stopReason,
        runnerCommit: attempt.record.runnerCommit,
        runnerDirty: attempt.record.runnerDirty,
      })),
    artifacts: artifactsOf(attempts),
  });
}

/** Every stage directory of one attempt: corpus stages, arm stages, records. */
export function stageDirsOf(attemptDir: string): readonly string[] {
  const found: string[] = [];
  const stagesRoot = join(attemptDir, "stages");
  if (existsSync(stagesRoot)) {
    for (const name of readdirSync(stagesRoot).sort()) {
      const dir = join(stagesRoot, name);
      if (existsSync(join(dir, "manifest.json"))) {
        found.push(dir);
        continue;
      }
      for (const arm of FARMER_ARMS) {
        if (existsSync(join(dir, arm, "manifest.json"))) {
          found.push(join(dir, arm));
        }
      }
    }
  }
  const recordsRoot = join(attemptDir, "verdicts");
  if (existsSync(recordsRoot)) {
    for (const name of readdirSync(recordsRoot).sort()) {
      if (existsSync(join(recordsRoot, name, "manifest.json"))) {
        found.push(join(recordsRoot, name));
      }
    }
  }
  return Object.freeze(found);
}

/**
 * One stage's section.
 *
 * `sealed` is the field the caller reads to decide whether anything else in the
 * section may be shown, so it is computed from the manifest rather than passed
 * in: a caller could otherwise pass what it wished were true.
 */
function stageView(dir: string, attemptId: string): Readonly<Record<string, unknown>> {
  if (!existsSync(join(dir, "manifest.json"))) {
    return Object.freeze({ sealed: false, dir, attemptId, completion: "ABSENT" });
  }
  const manifest = readManifest(dir);
  const sealed = manifest.completion === "SEALED";
  const path = join(dir, "verdict.json");
  return Object.freeze({
    dir,
    attemptId,
    stage: manifest.stage,
    arms: manifest.arms,
    poolId: manifest.poolId,
    start: manifest.start,
    deals: manifest.deals,
    completion: manifest.completion,
    sealed,
    sealedAt: manifest.sealedAt,
    configHash: manifest.configHash,
    // The hash table is a set of digests of things that exist, not a result:
    // counts and digests are what an unsealed stage may show.
    checkpoints: Object.keys(manifest.hashes).length,
    manifestSha256: stableHash(JSON.stringify(manifest)),
    verdict: !sealed || !existsSync(path)
      ? null
      : Object.freeze({
        decision: (readJson(path) as Readonly<{ decision?: unknown }>).decision ?? null,
        sha256: stableHash(readFileSync(path, "utf8")),
      }),
  });
}

function archiveView(path: string): Readonly<Record<string, unknown>> {
  const archive = readChampionArchive(path.slice(path.lastIndexOf("/") + 1, -5));
  const text = readFileSync(path, "utf8");
  return Object.freeze({
    championId: archive.championId,
    generation: archive.generation,
    parentChampionId: archive.parentChampionId,
    layers: archive.layers.length,
    decision: archive.decision,
    researchOnly: archive.researchOnly,
    bytes: Buffer.byteLength(text, "utf8"),
    sha256: stableHash(text),
  });
}

function poolsOf(options: Readonly<{ path?: string }>): readonly Readonly<Record<string, unknown>>[] {
  return Object.freeze(ledgerPools(options.path)
    .filter((pool) => pool.poolId.startsWith("factory-v1"))
    .map((pool) => Object.freeze({
      poolId: pool.poolId,
      state: pool.state,
      purpose: pool.purpose,
      attemptId: pool.attemptId,
      start: pool.start,
      end: pool.end,
      maxFormalN: pool.maxFormalN,
      events: pool.history.length,
    })));
}

function artifactsOf(
  attempts: readonly Readonly<{ dir: string }>[],
): readonly Readonly<Record<string, unknown>>[] {
  const found: Readonly<Record<string, unknown>>[] = [];
  const named = [
    ["train/train.rows.json", "rows"],
    ["train/calibration.rows.json", "rows"],
    ["train/train-config.json", "training config"],
    ["train/model.txt", "booster"],
    ["train/calibration.scores.json", "calibration scores"],
    ["calibration.json", "calibration"],
    ["formal-plan.json", "formal plan"],
  ] as const;
  for (const attempt of attempts) {
    for (const [suffix, kind] of named) {
      const path = join(attempt.dir, suffix);
      if (existsSync(path)) {
        found.push(fileView(path, kind));
      }
    }
    const modelsDir = join(attempt.dir, "models");
    if (existsSync(modelsDir)) {
      for (const name of readdirSync(modelsDir).sort()) {
        found.push(fileView(join(modelsDir, name), "candidate layer"));
      }
    }
  }
  return Object.freeze(found);
}

function fileView(path: string, kind: string): Readonly<Record<string, unknown>> {
  const text = readFileSync(path, "utf8");
  return Object.freeze({
    kind, path, bytes: Buffer.byteLength(text, "utf8"), sha256: stableHash(text),
  });
}
