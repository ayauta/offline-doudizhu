/**
 * Farmer Policy Iteration Factory v1 — the machinery the two worker entry
 * points share.
 *
 * `farmer-pi-corpus.test.ts` and `farmer-pi-stage.test.ts` are the same shape
 * twice: read a configuration out of the environment, build the champion chain,
 * walk a window of deals, checkpoint each deal before moving on. Everything
 * that is not *which* loop it is lives here, so each worker reads as the
 * protocol it implements rather than as plumbing, and so the two can never
 * disagree about what a pool is, what a chain is, or what "this deal is already
 * done" means.
 *
 * Four decisions are worth stating, because each of them has an obvious way to
 * be quietly wrong:
 *
 *   - **the environment is the configuration.** A value the runner does not set
 *     is an error, never a default. A defaulted pool id or policy commit would
 *     let two different experiments share a checkpoint directory while every
 *     per-deal check still passed.
 *   - **a resume re-derives and compares.** `dealCheckpointed` is handed a
 *     *freshly computed* record and only decides whether the file on disk needs
 *     writing. A resumed deal is therefore verified rather than trusted, and a
 *     deal that does not reproduce is an `INTEGRITY_STOP` from the checkpoint
 *     layer rather than a silent overwrite. The payload must be a pure function
 *     of the deal for this to hold — which is why every worker puts its timings
 *     under the record's `cost` and never inside `payload`.
 *   - **the chain is the champion, not a model.** A chain that is not exactly
 *     one model per generation would make "πn is πn-1 plus one layer" a claim
 *     about the loader instead of about the data.
 *   - **nothing printed here can be inverted into a strength.** Progress is
 *     counts, elapsed and throughput; a win, a loss, a delta or a label tally
 *     would let a reader see an outcome before its stage is sealed, which is the
 *     one thing §29 exists to prevent.
 *
 * Nothing in `src/` imports this module. The Factory never ships.
 */
import { existsSync, readFileSync } from "node:fs";

import { CF_FEATURE_NAMES } from "../src/core/ai/cf-features.js";
import { cfSchemaHash } from "./cf-corpus.js";
import {
  cfRowWeights,
  cfRows,
  type CfGroupResult,
  type CfRow,
  type CfSplit,
} from "./cf-dataset.js";
import { parseTreeModel } from "./cf-model.js";
import {
  assertChainShape,
  chainDepth,
  type ChainLayer,
  type ChampionChain,
} from "./farmer-pi-chain.js";
import {
  PI1_CHAMPION_ID,
  frozenPi1Chain,
  researchChampionId,
} from "./farmer-pi-champions.js";
import {
  FACTORY_DATASET_VERSION,
  FACTORY_GROUP_SNAPSHOT_CAP,
  FACTORY_SEED_BASE,
  FACTORY_SNAPSHOT_SALT,
  FACTORY_SPLIT_SALT,
  factorySplitOfPurpose,
  type FactoryPoolRef,
} from "./farmer-pi-corpus.js";
import {
  dealRecordPath,
  readDealRecord,
  stableHash,
  type PiDealRecord,
} from "./farmer-pi-stage.js";
import { assertProtocolHash, loadProtocol } from "./farmer-pi-protocol.js";

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/**
 * One progress line, straight to stdout.
 *
 * Written with `process.stdout.write` rather than `console.log` for the reason
 * `report` in `ai-tournament.ts` is: a run that is killed at a hard stop must
 * leave its progress behind, and an intercepted or buffered stream does not.
 *
 * The content rule is §29's, and it is a *protocol* requirement rather than a
 * style one: counts, elapsed and throughput only. There is deliberately no
 * helper here that would accept a win count, a delta or a label tally, because
 * the cost of one careless line is that a running stage's outcome becomes
 * readable before the stage is sealed — which is exactly how Spec 064's Stage 1
 * was invalidated.
 */
export function progress(line: string): void {
  process.stdout.write(`${line}\n`);
}

// ---------------------------------------------------------------------------
// The environment
// ---------------------------------------------------------------------------

function rawEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

/**
 * An environment variable the selected mode cannot run without.
 *
 * Refusing rather than defaulting is the point: every caller of these workers
 * runs for hours, and a value invented here would be discovered as a wrong
 * result rather than as a missing setting.
 */
export function requiredText(name: string): string {
  const value = rawEnv(name);
  if (value === undefined) {
    throw new Error(`${name} must be set; this mode has no default for it.`);
  }
  return value;
}

export function requiredInt(name: string): number {
  const value = requiredText(name);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be an integer, received "${value}".`);
  }
  return parsed;
}

export function requiredFloat(name: string): number {
  const value = requiredText(name);
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a finite number, received "${value}".`);
  }
  return parsed;
}

/**
 * The pool a corpus is generated from, as the runner described it.
 *
 * The range is taken from the environment and never derived here: the ledger in
 * `farmer-pi-pools.ts` is the authority on which deals belong to which pool, and
 * a second computation of it is how a corpus ends up describing deals the
 * strength run never plays.
 *
 * The purpose is resolved to a split on the way in, so a pool that cannot hold
 * a dataset (a `stage1` or `formal` pool) fails before the first deck is dealt
 * rather than after the first six thousand.
 */
export function factoryPoolRefFromEnv(): FactoryPoolRef {
  const poolId = requiredText("AI_FPI_POOL_ID");
  const purpose = requiredText("AI_FPI_PURPOSE");
  const start = requiredInt("AI_FPI_POOL_START");
  const end = requiredInt("AI_FPI_POOL_END");
  if (end < start) {
    throw new Error(
      `Pool ${poolId} is described as ${start}..${end}; its end precedes its start.`,
    );
  }
  factorySplitOfPurpose(purpose);
  return Object.freeze({
    poolId,
    purpose,
    range: Object.freeze({ start, end }),
  });
}

// ---------------------------------------------------------------------------
// Chains
// ---------------------------------------------------------------------------

/**
 * The champion chain a Factory worker builds its deals on.
 *
 * Only `ai-v1` can be built today. It is read from the artifact the *product
 * ships* through `frozenPi1Chain`, so "the base is production π1" is a claim
 * about `src/app/ai/cf-model-data.ts` rather than about a file that happens to
 * be under `.local/`.
 *
 * A research champion would come from
 * `research/farmer-pi/champions/ai-vN-research.json` through
 * `readChampionArchive` + `chainFromArchive`. That loader is deliberately not
 * written yet: no research champion exists, so there is no archive whose shape
 * is known, and guessing at the loader's call site would turn "the attempt
 * cannot start" into a failure somewhere inside a six-hour corpus.
 */
export function championChainById(championId: string): ChampionChain {
  if (championId !== PI1_CHAMPION_ID) {
    throw new Error(
      `No champion loader is wired for "${championId}". ${PI1_CHAMPION_ID} is the only ` +
      "champion that exists: a research champion becomes loadable only once an attempt " +
      "promotes one and writes its archive.",
    );
  }
  const chain = frozenPi1Chain();
  assertChainShape(chain, CF_FEATURE_NAMES.length);
  return chain;
}

/** The candidate round's packaged model, as the runner described it. */
export type CandidateLayerSpec = Readonly<{
  artifactPath: string;
  /** The LightGBM booster digest the runner froze for this round. */
  modelSha256: string;
  /** This layer's own threshold, in the model's own score units. */
  threshold: number;
  modelBytes: number;
}>;

/**
 * The candidate round's model, as a chain layer.
 *
 * Two checks, each of which catches something the other cannot:
 *
 *   - the digest the artifact *claims* must be the digest the runner froze.
 *     That digest is the booster text's, copied into the JSON wrapper by
 *     `cf-export-model.py`, so it is the identity of the learned object;
 *   - the byte length must be the one the runner recorded. This is the check the
 *     digest cannot make: a re-serialized wrapper carries the same booster
 *     digest at a different size, so a mismatch here means the file on disk is
 *     not the file the round was registered against.
 *
 * The layer's width is not checked here — `assertChainShape` does that on the
 * assembled chain, where the frozen schema's column count is known.
 */
export function candidateLayer(spec: CandidateLayerSpec): ChainLayer {
  const text = readFileSync(spec.artifactPath, "utf8");
  const model = parseTreeModel(JSON.parse(text) as Parameters<typeof parseTreeModel>[0]);
  if (model.modelSha256 !== spec.modelSha256) {
    throw new Error(
      `${spec.artifactPath} claims model ${model.modelSha256}; the runner froze ` +
      `${spec.modelSha256}.`,
    );
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes !== spec.modelBytes) {
    throw new Error(
      `${spec.artifactPath} is ${bytes} bytes; the runner recorded ${spec.modelBytes}. ` +
      "The candidate artifact on disk is not the one this round was registered against.",
    );
  }
  return Object.freeze({
    modelSha256: model.modelSha256,
    model,
    threshold: spec.threshold,
    modelBytes: spec.modelBytes,
  });
}

/**
 * The champion chain plus one appended layer — the candidate arm's chain.
 *
 * Nothing already in the chain is rebuilt, retrained or re-tuned: the layers are
 * the champion's own layer objects, and the appended layer is the only new one.
 * That is what makes "πn is πn-1 plus one layer" true by construction.
 *
 * The name is the generation's: a chain of depth two *is* the second research
 * generation, so it is named the way its archive will be named, with the
 * `-research` suffix the archive rules require. `parentChampionId` is set rather
 * than left null because a chain of depth greater than one with no parent is a
 * chain whose provenance was lost.
 */
export function candidateChain(base: ChampionChain, layer: ChainLayer): ChampionChain {
  const chain: ChampionChain = Object.freeze({
    championId: researchChampionId(chainDepth(base) + 1),
    parentChampionId: base.championId,
    layers: Object.freeze([...base.layers, layer]),
    baseMasterVersion: base.baseMasterVersion,
    top3Version: base.top3Version,
    schemaHash: base.schemaHash,
  });
  assertChainShape(chain, CF_FEATURE_NAMES.length);
  return chain;
}

/** The part of a chain that can change a deal's result. Never its object identity. */
function chainIdentity(chain: ChampionChain): Readonly<Record<string, unknown>> {
  return {
    championId: chain.championId,
    parentChampionId: chain.parentChampionId,
    layers: chain.layers.map((layer) => ({
      modelSha256: layer.modelSha256,
      threshold: layer.threshold,
      modelBytes: layer.modelBytes,
    })),
    schemaHash: chain.schemaHash,
    baseMasterVersion: chain.baseMasterVersion,
    top3Version: chain.top3Version,
  };
}

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

/**
 * Whether this deal is already checkpointed, byte for byte.
 *
 * The caller has just replayed the deal and holds a *freshly computed* record;
 * this decides only whether the file on disk still needs to be written. Two
 * consequences, both deliberate:
 *
 *   - a matching record is left exactly as it is — the resume path touches no
 *     file, so an interrupted run's checkpoints keep their own timestamps and
 *     the resumed process cannot reorder them;
 *   - a record that does *not* match is not overwritten here. `writeDealRecord`
 *     owns that decision and raises the `INTEGRITY_STOP`, so the two ways of
 *     noticing that a deterministic stage disagreed with itself cannot drift
 *     apart. That includes the configuration half: a deal produced under another
 *     pool, policy commit or chain is a different experiment, not a stale file.
 */
export function dealCheckpointed(dir: string, record: PiDealRecord): boolean {
  if (!existsSync(dealRecordPath(dir, record.arm, record.dealIndex))) {
    return false;
  }
  const existing = readDealRecord(dir, record.arm, record.dealIndex);
  return existing.artifactHash === record.artifactHash &&
    existing.configHash === record.configHash;
}

/**
 * The identity a corpus's checkpoints are bound to.
 *
 * Everything that can change a group's bytes is in here: the pool the deals come
 * from, the champion the deals were played under, and the salts, version and
 * snapshot cap that decide which roots are sampled. The attempt and the policy
 * commit are carried beside them because a corpus whose provenance cannot be
 * named is a corpus nobody can re-run.
 *
 * It is not the *deal window*: the window is per invocation and the deal index is
 * already the record's own key, while the configuration is what a resume must
 * not be allowed to change.
 */
export function corpusConfigHash(options: Readonly<{
  pool: FactoryPoolRef;
  chain: ChampionChain;
  /** The sha256 of `protocol-v1.yaml`'s bytes, never the runner's commit. */
  protocolHash: string;
  attemptId: string;
}>): string {
  return stableHash({
    kind: "farmer-pi-corpus",
    attemptId: options.attemptId,
    protocolHash: options.protocolHash,
    pool: {
      poolId: options.pool.poolId,
      purpose: options.pool.purpose,
      start: options.pool.range.start,
      end: options.pool.range.end,
    },
    chain: chainIdentity(options.chain),
    datasetVersion: FACTORY_DATASET_VERSION,
    featureSchemaHash: cfSchemaHash(),
    snapshotSalt: FACTORY_SNAPSHOT_SALT,
    splitSalt: FACTORY_SPLIT_SALT,
    snapshotCap: FACTORY_GROUP_SNAPSHOT_CAP,
    seedBase: FACTORY_SEED_BASE,
  });
}

/**
 * The protocol the runner registered, re-derived from the file and compared.
 *
 * The worker is handed a hash and does not trust it: it reads the protocol
 * itself, hashes the bytes, and refuses when the two disagree. That is what
 * makes "this attempt ran under protocol X" a statement the worker can make
 * about its own checkpoints rather than one it takes on the runner's word.
 */
export function assertRegisteredProtocol(registered: string): string {
  // The runner names the protocol file it registered the attempt under, so a
  // rehearsal running under `protocol-rehearsal.yaml` is checked against that
  // document rather than against the Factory's. Falling back to the default path
  // is what a bare invocation gets, and the hash comparison below is what makes
  // the choice safe either way: a worker pointed at the wrong document refuses
  // rather than generating a corpus under it.
  const path = process.env.AI_FPI_PROTOCOL_PATH;
  const { hash } = loadProtocol(path === undefined || path === "" ? undefined : path);
  assertProtocolHash(registered, hash);
  return hash;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * One corpus directory's training rows.
 *
 * The three keys are the whole file: v1's exporter writes several more, but the
 * Factory's corpus is one pool — one purpose, one split — so the split is on
 * every row already and a second copy of it here could disagree with the first.
 */
export type FactoryRowsFile = Readonly<{
  rows: readonly CfRow[];
  weights: readonly number[];
  /** groupId → sampled roots. The weights' denominator. */
  groups: Readonly<Record<string, number>>;
}>;

/**
 * Turns a corpus's groups into rows, with v1's weights.
 *
 * `cfRows` and `cfRowWeights` are imported rather than re-derived: the Factory
 * asks a different question of each generation, but it must ask it in the same
 * units as every round before it, or the generations stop being comparable.
 *
 * `rootsPerGroup` counts a group's *snapshots*, because under the Factory a
 * sampled root is a snapshot — one per root, each already carrying the candidate
 * set that root offered. A count of anything else would silently reweight every
 * model trained on the result.
 */
export function factoryRowsFile(
  groups: readonly CfGroupResult[],
  split: CfSplit,
): FactoryRowsFile {
  const rows: CfRow[] = [];
  const rootsPerGroup = new Map<string, number>();
  for (const group of groups) {
    rootsPerGroup.set(group.groupId, group.snapshots.length);
    for (const snapshot of group.snapshots) {
      for (const row of cfRows(snapshot, split)) {
        rows.push(row);
      }
    }
  }
  const weights = cfRowWeights(rows, rootsPerGroup);
  return Object.freeze({
    rows: Object.freeze(rows),
    weights,
    groups: Object.freeze(Object.fromEntries(rootsPerGroup)),
  });
}
