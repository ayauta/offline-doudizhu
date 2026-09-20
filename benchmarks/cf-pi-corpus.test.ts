/**
 * Phase 2 Night Lab π1→π2 corpus generator, merger and auditor (spec 064 §6).
 *
 * Three env-gated modes, all off by default so `pnpm test` never starts a
 * multi-hour job by accident:
 *
 *   generate  AI_CF_PI_GENERATE=<shard.json> AI_CF_PI_DEAL_START=100001 AI_CF_PI_DEALS=1250
 *   merge     AI_CF_PI_MERGE=<shard dir> AI_CF_PI_CORPUS_DIR=.local/cf-pi-corpus
 *   audit     AI_CF_PI_AUDIT=.local/cf-pi-corpus
 *
 * Driven by `scripts/cf-pi-corpus.mjs`, which shards the universe and resumes
 * rather than restarting. Sharding only parallelises: a group's seed is its
 * absolute deal index, so the merged corpus does not depend on the shard count.
 *
 * Two things differ from `cf-corpus.test.ts` and nothing else does:
 *
 *   1. the policy. Every variant is visited, forked and continued under π1
 *      (`cfPiCaptureGroup`), so the reference every row is built against is the
 *      action the frozen selector actually executed — `b1`, not `b0`;
 *   2. the assertions. Spec §7.16 requires the integrity gates to hold over
 *      *every* generated row, not a sample, so `cf-pi-corpus.ts` runs the whole
 *      battery on the way out of `generate` and again on the way into `merge`.
 *      A violation throws and no shard is written.
 *
 * Blind protocol (unchanged from v1): held-out is generated like every other
 * split, sealed on write, and its labels are never loaded here. `audit` reports
 * shape for it and nothing else.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { dealDeck, report } from "./ai-tournament.js";
import {
  CF_FEATURE_SCHEMA_VERSION,
  CF_RULES_VERSION,
  type CfGroupResult,
  type CfSplit,
} from "./cf-dataset.js";
import {
  CF_LGBM_CONFIG_VERSION,
  cfAuditStructure,
  cfSchemaHash,
  sha256,
} from "./cf-corpus.js";
import {
  CF_PI_DATASET_VERSION,
  CF_PI_MODEL_SHA256,
  CF_PI_GROUP_SNAPSHOT_CAP,
  CF_PI_SEED_BASE,
  CF_PI_SNAPSHOT_SALT,
  CF_PI_SPLIT_COUNTS,
  CF_PI_SPLIT_SALT,
  CF_PI_THRESHOLD,
  CF_PI_UNIVERSE_END,
  CF_PI_UNIVERSE_START,
  assertPiSeedBase,
  cfPiCaptureGroup,
  cfPiGroupSpecFor,
  cfPiSplitOf,
} from "./cf-policy-iteration.js";
import { cfPiAssertGroup, cfPiFrozenBaseline } from "./cf-pi-corpus.js";

const GENERATE_OUT = process.env.AI_CF_PI_GENERATE;
const MERGE_DIR = process.env.AI_CF_PI_MERGE;
const AUDIT_DIR = process.env.AI_CF_PI_AUDIT;
const CORPUS_DIR = process.env.AI_CF_PI_CORPUS_DIR ?? ".local/cf-pi-corpus";
const POLICY_COMMIT = process.env.AI_CF_PI_POLICY_COMMIT ?? "unset";

const ENABLED = GENERATE_OUT !== undefined || MERGE_DIR !== undefined || AUDIT_DIR !== undefined;

/** A shard is a multi-hour job; the budget is stated rather than inherited. */
const CF_PI_GENERATE_TIMEOUT_MS = 6 * 60 * 60 * 1000;

export type CfPiShardFile = Readonly<{
  shard: Readonly<{ dealStart: number; deals: number }>;
  versions: Readonly<{
    dataset: number;
    featureSchema: number;
    rules: string;
    policyCommit: string;
    schemaHash: string;
    splitSalt: string;
    snapshotSalt: string;
    lgbmConfig: string;
    /** Frozen π1 identity, carried so a π2 shard cannot be read as a v1 one. */
    baselineModelSha256: string;
    threshold: number;
    seedBase: number;
    snapshotCap: number;
  }>;
  groups: readonly CfGroupResult[];
}>;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be an integer, received "${raw}".`);
  }
  return parsed;
}


function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function splitOfOrThrow(dealIndex: number): CfSplit {
  const split = cfPiSplitOf(dealIndex);
  if (split === undefined) {
    throw new Error(`Deal ${dealIndex} is outside the preregistered π2 universe.`);
  }
  return split;
}

function corpusFileName(split: CfSplit): string {
  return split === "heldout" ? "heldout.sealed.json" : `${split}.json`;
}

/** The `versions` block every shard must agree on, byte for byte. */
function expectedVersions(): CfPiShardFile["versions"] {
  return Object.freeze({
    dataset: CF_PI_DATASET_VERSION,
    featureSchema: CF_FEATURE_SCHEMA_VERSION,
    rules: CF_RULES_VERSION,
    policyCommit: POLICY_COMMIT,
    schemaHash: cfSchemaHash(),
    splitSalt: CF_PI_SPLIT_SALT,
    snapshotSalt: CF_PI_SNAPSHOT_SALT,
    lgbmConfig: CF_LGBM_CONFIG_VERSION,
    baselineModelSha256: CF_PI_MODEL_SHA256,
    threshold: CF_PI_THRESHOLD,
    seedBase: CF_PI_SEED_BASE,
    snapshotCap: CF_PI_GROUP_SNAPSHOT_CAP,
  });
}

describe.runIf(ENABLED)("Phase 2 Night Lab π1→π2 corpus", () => {
  it("generates one shard, merges the shards, or audits the corpus", () => {
    // §7.10 — the corpus and the strength run must agree on which game a deal
    // index names. Checked before a single deck is dealt.
    assertPiSeedBase(CF_PI_SEED_BASE);
    const baseline = cfPiFrozenBaseline();

    if (GENERATE_OUT !== undefined) {
      const dealStart = envInt("AI_CF_PI_DEAL_START", CF_PI_UNIVERSE_START);
      const deals = Math.max(1, envInt("AI_CF_PI_DEALS", 100));
      const started = performance.now();
      const groups: CfGroupResult[] = [];
      const failures: Record<string, number> = {};
      let snapshots = 0;
      let rows = 0;
      let overridden = 0;
      let farmerRoots = 0;
      let usefulRoots = 0;

      for (let offset = 0; offset < deals; offset += 1) {
        const dealIndex = dealStart + offset;
        const split = splitOfOrThrow(dealIndex);
        const spec = cfPiGroupSpecFor(dealIndex, POLICY_COMMIT);
        const result = cfPiCaptureGroup(dealDeck(spec.dealSeed), spec, baseline);
        // Exhaustive, every group, on the way out. A shard that fails this is
        // never written, so a bad corpus cannot exist on disk to be merged.
        const audit = cfPiAssertGroup(result, split, failures);
        snapshots += audit.snapshots;
        rows += audit.rows;
        overridden += audit.overridden;
        farmerRoots += result.totalFarmerRoots;
        usefulRoots += result.usefulFarmerRoots;
        groups.push(result);
      }

      const payload: CfPiShardFile = {
        shard: { dealStart, deals },
        versions: expectedVersions(),
        groups,
      };
      const text = `${JSON.stringify(payload)}\n`;
      mkdirSync(dirname(GENERATE_OUT), { recursive: true });
      writeFileSync(GENERATE_OUT, text, "utf8");

      const elapsed = (performance.now() - started) / 1000;
      report(
        `[cf-pi shard ${dealStart}..${dealStart + deals - 1}] groups ${groups.length} ` +
        `snapshots ${snapshots}  rows ${rows}  overridden ${overridden}  ` +
        `farmerRoots ${farmerRoots}  usefulRoots ${usefulRoots}  ` +
        `${elapsed.toFixed(0)}s  ${(text.length / 1024 / 1024).toFixed(1)} MiB  ` +
        `sha256 ${sha256(text).slice(0, 16)}`,
      );
      expect(groups.length).toBe(deals);
      return;
    }

    if (MERGE_DIR !== undefined) {
      const names = readdirSync(MERGE_DIR).filter((name) => name.endsWith(".json")).sort();
      if (names.length === 0) {
        throw new Error(`No shards in ${MERGE_DIR}.`);
      }
      const expected = expectedVersions();
      const bySplit: Record<CfSplit, CfGroupResult[]> = { train: [], calibration: [], heldout: [] };
      const shardHashes: Record<string, string> = {};
      const failures: Record<string, number> = {};
      const seenDeals = new Set<number>();
      let expectedGroups = 0;
      let snapshots = 0;
      let rows = 0;
      let overridden = 0;

      for (const name of names) {
        const path = join(MERGE_DIR, name);
        const text = readFileSync(path, "utf8");
        const shard = JSON.parse(text) as CfPiShardFile;
        shardHashes[name] = sha256(text);
        // Every shard must carry this round's frozen provenance. A shard from
        // another universe, policy or salt is not "close enough" — it is a
        // different experiment, and merging it would silently mix two datasets.
        for (const [key, value] of Object.entries(expected)) {
          if ((shard.versions as Record<string, unknown>)[key] !== value) {
            throw new Error(
              `${name} disagrees on ${key}: ${String((shard.versions as Record<string, unknown>)[key])} != ${String(value)}`,
            );
          }
        }
        if (shard.groups.length !== shard.shard.deals) {
          throw new Error(
            `${name} holds ${shard.groups.length} groups, expected ${shard.shard.deals}.`,
          );
        }
        expectedGroups += shard.shard.deals;
        for (const group of shard.groups) {
          const split = splitOfOrThrow(group.dealIndex);
          // §7.16 — no deal may appear twice across shards. Windows that
          // overlapped would double-count a group while every per-group check
          // still passed.
          if (seenDeals.has(group.dealIndex)) {
            throw new Error(`§7.16 deal ${group.dealIndex} appears in more than one shard.`);
          }
          seenDeals.add(group.dealIndex);
          // The same exhaustive battery again, on the way in: a shard edited on
          // disk after generation is caught here rather than trained on.
          const audit = cfPiAssertGroup(group, split, failures);
          snapshots += audit.snapshots;
          rows += audit.rows;
          overridden += audit.overridden;
          bySplit[split].push(group);
        }
      }

      for (const split of ["train", "calibration", "heldout"] as const) {
        bySplit[split].sort((left, right) => left.dealIndex - right.dealIndex);
        if (bySplit[split].length !== CF_PI_SPLIT_COUNTS[split]) {
          throw new Error(
            `§7.16 ${split} holds ${bySplit[split].length} groups, expected ${CF_PI_SPLIT_COUNTS[split]}.`,
          );
        }
      }

      mkdirSync(CORPUS_DIR, { recursive: true });
      const fileHashes: Record<string, string> = {};
      for (const split of ["train", "calibration", "heldout"] as const) {
        const body = `${JSON.stringify({
          split,
          schemaHash: cfSchemaHash(),
          groups: bySplit[split],
        })}\n`;
        const fileName = corpusFileName(split);
        writeFileSync(join(CORPUS_DIR, fileName), body, "utf8");
        fileHashes[fileName] = sha256(body);
      }

      const manifest = {
        round: "spec-064-phase2-night-policy-iteration",
        pipelineCommit: POLICY_COMMIT,
        baselineModelSha256: CF_PI_MODEL_SHA256,
        threshold: CF_PI_THRESHOLD,
        schemaHash: cfSchemaHash(),
        splitSalt: CF_PI_SPLIT_SALT,
        snapshotSalt: CF_PI_SNAPSHOT_SALT,
        lgbmConfigVersion: CF_LGBM_CONFIG_VERSION,
        datasetVersion: CF_PI_DATASET_VERSION,
        featureSchemaVersion: CF_FEATURE_SCHEMA_VERSION,
        rulesVersion: CF_RULES_VERSION,
        seedBase: CF_PI_SEED_BASE,
        universe: { start: CF_PI_UNIVERSE_START, end: CF_PI_UNIVERSE_END },
        splitCounts: CF_PI_SPLIT_COUNTS,
        shards: { count: names.length, expectedGroups, hashes: shardHashes },
        files: fileHashes,
        totals: { groups: expectedGroups, snapshots, rows, overridden },
        mergedCorpusChecksum: sha256(
          (["train", "calibration", "heldout"] as const)
            .map((split) => fileHashes[corpusFileName(split)]).join(":"),
        ),
      };
      writeFileSync(join(CORPUS_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

      for (const split of ["train", "calibration", "heldout"] as const) {
        const audit = cfAuditStructure(bySplit[split], split);
        report(
          `[${split}] groups ${audit.groups} (with snapshots ${audit.groupsWithSnapshots}, ` +
          `empty ${audit.zeroSnapshotGroups})  snapshots ${audit.snapshots}  rows ${audit.rows}  ` +
          `max/group ${audit.maxSnapshotsPerGroup}  splitMismatch ${audit.splitMismatches}  ` +
          `schemaMismatch ${audit.schemaMismatches}  labelIntegrity ${audit.labelIntegrityFailures}  ` +
          `productionIndex ${audit.productionIndexFailures}`,
        );
      }
      report(`overridden roots ${overridden} of ${snapshots} snapshots`);
      report(`exhaustive §7 battery: ${JSON.stringify(failures)}`);
      report(`manifest ${join(CORPUS_DIR, "manifest.json")}`);
      report(`merged corpus checksum ${manifest.mergedCorpusChecksum}`);
      expect(manifest.mergedCorpusChecksum.length).toBe(64);
      return;
    }

    const corpusDir = AUDIT_DIR ?? CORPUS_DIR;
    const load = (name: string): readonly CfGroupResult[] =>
      readJson<{ groups: readonly CfGroupResult[] }>(join(corpusDir, name)).groups;
    const train = load(corpusFileName("train"));
    const calibration = load(corpusFileName("calibration"));
    const heldout = load(corpusFileName("heldout"));

    report(`\n== Phase 2 Night Lab π1→π2 corpus audit ==`);
    for (const [name, groups, split] of [
      ["train", train, "train"],
      ["calibration", calibration, "calibration"],
      ["heldout", heldout, "heldout"],
    ] as const) {
      const audit = cfAuditStructure(groups, split);
      report(
        `[${name}] groups ${audit.groups}  snapshots ${audit.snapshots}  rows ${audit.rows}  ` +
        `splitMismatch ${audit.splitMismatches}  schemaMismatch ${audit.schemaMismatches}  ` +
        `labelIntegrity ${audit.labelIntegrityFailures}  productionIndex ${audit.productionIndexFailures}`,
      );
    }
    expect(train.length + calibration.length + heldout.length).toBe(
      CF_PI_SPLIT_COUNTS.train + CF_PI_SPLIT_COUNTS.calibration + CF_PI_SPLIT_COUNTS.heldout,
    );
  }, CF_PI_GENERATE_TIMEOUT_MS);
});
