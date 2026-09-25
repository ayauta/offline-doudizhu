/**
 * Farmer Policy Iteration Factory v1 — the champion archive.
 *
 * A champion is what the Factory *promoted*, recorded immutably: the whole
 * model chain, each layer's artifact digest, the pools the attempt drew from,
 * the formal evidence and the cost. The archive is the only thing a later
 * generation is allowed to build on, which is why it records the chain rather
 * than a pointer to "the current model" — a pointer can be repointed, and a
 * chain with digests cannot.
 *
 * Two kinds of champion live here, and the difference is not cosmetic:
 *
 *   - **`ai-v1` is production.** Its layer is the artifact the shipped Worker
 *     loads, read from `src/app/ai/cf-model-data.ts` rather than from any file
 *     under `.local/`. It is never rewritten by this Factory.
 *   - **`ai-vN-research` is a research champion.** It is never shipped, never
 *     installed in a product path, and never called production. The `-research`
 *     suffix is deliberate: this repository already has a separate release-tag
 *     policy (`vMAJOR.MINOR.PATCH`, main-only), and an `ai-v2` tag that meant
 *     "the second thing we tried" would eventually be read as "the second thing
 *     we shipped".
 *
 * Nothing here reads or writes the ledger. Which pools an attempt used is
 * recorded in the archive, but the ledger remains the authority on what those
 * pools *are*; the archive cites it rather than restating it.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CF_MODEL_JSON, CF_MODEL_SHA256, CF_SELECTOR_THRESHOLD } from "../src/app/ai/cf-model-data.js";
import { parseTreeModel } from "../src/core/ai/cf-model.js";
import { CF_FEATURE_NAMES } from "../src/core/ai/cf-features.js";
import { cfSchemaHash } from "./cf-corpus.js";
import { cfPiFrozenBaseline } from "./cf-pi-corpus.js";
import { assertChainShape, type ChainLayer, type ChampionChain } from "./farmer-pi-chain.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const PI1_CHAMPION_ID = "ai-v1";

/**
 * Production champions, oldest first.
 *
 * `ai-v2` was added when the CHEAP landlord policy and the π1 farmer selector
 * were promoted together: the two mechanisms that had each passed their own
 * independent validation became the shipped configuration at the master tier.
 * It is a production champion in its own right, not a research one, which is
 * why it carries no `-research` suffix and why `researchChampionId` still
 * refuses to mint a bare `ai-v2` for an experiment.
 *
 * Nothing here writes this file. The list is what the archivist accepts, not
 * what the Factory may produce.
 */
export const PRODUCTION_CHAMPION_IDS: readonly string[] = Object.freeze([
  PI1_CHAMPION_ID,
  "ai-v2",
]);

export const CHAMPION_DIR = join(ROOT, "research", "farmer-pi", "champions");

/** The frozen master and candidate-width identities this Factory builds on. */
export const FACTORY_BASE_MASTER_VERSION = "master-v1";
export const FACTORY_TOP3_VERSION = "expert-top3-anchored-v1";

/** `ai-v2-research`, `ai-v3-research`, ... — never a bare `ai-v2`. */
export function researchChampionId(generation: number): string {
  if (!Number.isSafeInteger(generation) || generation < 2) {
    throw new Error(`Research champions start at generation 2; received ${generation}.`);
  }
  return `ai-v${generation}-research`;
}

export function championArchivePath(championId: string, dir: string = CHAMPION_DIR): string {
  return join(dir, `${championId}.json`);
}

/**
 * The production champion, as a chain of depth one.
 *
 * Read from the *shipped* module, and put through `cfPiFrozenBaseline`'s checks
 * — digest, tree count, width and column order — before it is allowed to become
 * a layer. A chain built from a file that merely happens to be on disk would
 * make "π1 is the production champion" a claim about the disk.
 */
export function frozenPi1Chain(): ChampionChain {
  const baseline = cfPiFrozenBaseline();
  const layer: ChainLayer = Object.freeze({
    modelSha256: baseline.model.modelSha256,
    model: baseline.model,
    threshold: baseline.threshold,
    modelBytes: Buffer.byteLength(CF_MODEL_JSON, "utf8"),
  });
  if (layer.modelSha256 !== CF_MODEL_SHA256) {
    throw new Error("The frozen baseline's digest is not the artifact's published digest.");
  }
  if (layer.threshold !== CF_SELECTOR_THRESHOLD) {
    throw new Error("The frozen baseline's threshold is not the artifact's published threshold.");
  }
  return Object.freeze({
    championId: PI1_CHAMPION_ID,
    parentChampionId: null,
    layers: Object.freeze([layer]),
    baseMasterVersion: FACTORY_BASE_MASTER_VERSION,
    top3Version: FACTORY_TOP3_VERSION,
    schemaHash: cfSchemaHash(),
  });
}

/** One layer's serialized record inside a champion archive. */
export type ArchivedLayer = Readonly<{
  modelSha256: string;
  threshold: number;
  /** Path to the packaged model JSON, relative to the repository root. */
  artifact: string;
  modelBytes: number;
}>;

export type ChampionArchive = Readonly<{
  championId: string;
  parentChampionId: string | null;
  /** 1 for the starting champion; +1 for each PROMOTE. Never for an attempt. */
  generation: number;
  /** `null` for production, which carries its own release tag instead. */
  immutableGitTag: string | null;
  sourceCommit: string;
  /** True for every champion this Factory produces. Production is false. */
  researchOnly: boolean;
  layers: readonly ArchivedLayer[];
  modelChain: readonly string[];
  schemaVersion: number;
  schemaHash: string;
  baseMasterVersion: string;
  top3Version: string;
  /** Pool ids, by purpose. Names only; the ledger holds the ranges. */
  pools: Readonly<Record<string, string>>;
  attemptId: string | null;
  formalN: number | null;
  /** One-sided alpha the formal test ran at. */
  alpha: number | null;
  farmerDelta: number | null;
  lowerBound99: number | null;
  /** Formal verdict: `null` for the starting champion, which ran no attempt. */
  decision: "PROMOTE" | null;
  runtimeCost: Readonly<Record<string, number>>;
  cumulativeModelBytes: number;
  createdAt: string;
}>;

export function parseChampionArchive(text: string): ChampionArchive {
  const parsed = JSON.parse(text) as ChampionArchive;
  if (typeof parsed.championId !== "string" || parsed.championId === "") {
    throw new Error("Champion archive has no championId.");
  }
  if (!Array.isArray(parsed.layers) || parsed.layers.length < 1) {
    throw new Error(`Champion ${parsed.championId} has no layers.`);
  }
  if (parsed.researchOnly !== true && !PRODUCTION_CHAMPION_IDS.includes(parsed.championId)) {
    throw new Error(
      `Champion ${parsed.championId} is not marked research-only, and it is not one of the ` +
        `production champions (${PRODUCTION_CHAMPION_IDS.join(", ")}). This Factory never ` +
        "writes a production champion.",
    );
  }
  if (parsed.researchOnly === true && !parsed.championId.endsWith("-research")) {
    throw new Error(
      `Research champion ${parsed.championId} must carry the -research suffix so it cannot ` +
      "be mistaken for a production tag.",
    );
  }
  // Depth and generation are the same number by construction: one promotion,
  // one new layer. Asserted rather than assumed, because a chain that grew by
  // two layers in one promotion would double-count a generation's evidence.
  if (parsed.layers.length !== parsed.generation) {
    throw new Error(
      `Champion ${parsed.championId} claims generation ${parsed.generation} with ` +
      `${parsed.layers.length} layers.`,
    );
  }
  return Object.freeze(parsed);
}

/**
 * Materialises a chain from an archive.
 *
 * The layer loader is injected rather than hard-coded so the pure part — "does
 * this archive describe a chain that can be built at all?" — can be tested
 * without a filesystem, and so the runner is the only place that knows where
 * model artifacts live.
 */
export function chainFromArchive(
  archive: ChampionArchive,
  loadLayerModel: (layer: ArchivedLayer) => string,
): ChampionChain {
  const layers: ChainLayer[] = archive.layers.map((layer) => {
    const text = loadLayerModel(layer);
    const model = parseTreeModel(JSON.parse(text) as Parameters<typeof parseTreeModel>[0]);
    if (model.modelSha256 !== layer.modelSha256) {
      throw new Error(
        `Champion ${archive.championId} layer ${layer.modelSha256} loaded a model claiming ` +
        `${model.modelSha256}.`,
      );
    }
    if (Buffer.byteLength(text, "utf8") !== layer.modelBytes) {
      throw new Error(
        `Champion ${archive.championId} layer ${layer.modelSha256} has ` +
        `${Buffer.byteLength(text, "utf8")} bytes; the archive records ${layer.modelBytes}.`,
      );
    }
    return Object.freeze({
      modelSha256: layer.modelSha256,
      model,
      threshold: layer.threshold,
      modelBytes: layer.modelBytes,
    });
  });
  const chain: ChampionChain = Object.freeze({
    championId: archive.championId,
    parentChampionId: archive.parentChampionId,
    layers: Object.freeze(layers),
    baseMasterVersion: archive.baseMasterVersion,
    top3Version: archive.top3Version,
    schemaHash: archive.schemaHash,
  });
  assertChainShape(chain, CF_FEATURE_NAMES.length);
  if (chain.schemaHash !== cfSchemaHash()) {
    throw new Error(
      `Champion ${archive.championId} was built on schema ${archive.schemaHash}; the frozen ` +
      `schema is ${cfSchemaHash()}.`,
    );
  }
  if (chain.layers.length !== archive.generation) {
    throw new Error(
      `Champion ${archive.championId} has ${chain.layers.length} layers for generation ` +
      `${archive.generation}.`,
    );
  }
  return chain;
}

export function readChampionArchive(
  championId: string,
  dir: string = CHAMPION_DIR,
): ChampionArchive {
  return parseChampionArchive(readFileSync(championArchivePath(championId, dir), "utf8"));
}

/**
 * Writes an archive in one step. Temp-then-rename, because a champion file that
 * exists but is half-written is worse than one that does not exist: the next
 * generation would read the chain from it.
 */
export function writeChampionArchive(
  archive: ChampionArchive,
  dir: string = CHAMPION_DIR,
): string {
  mkdirSync(dir, { recursive: true });
  const path = championArchivePath(archive.championId, dir);
  const temporary = `${path}.partial`;
  writeFileSync(temporary, `${JSON.stringify(archive, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
  return path;
}
