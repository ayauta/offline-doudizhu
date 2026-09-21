/**
 * Spec 065 corpus generator, merger and auditor.
 *
 *   generate  AI_CF_T5_GENERATE=<shard.json> AI_CF_T5_DEAL_START=140001 AI_CF_T5_DEALS=1334
 *   merge     AI_CF_T5_MERGE=<shard dir> AI_CF_T5_CORPUS_DIR=.local/cf-top5-corpus
 *   audit     AI_CF_T5_AUDIT=.local/cf-top5-corpus
 *
 * Structurally identical to Spec 064's driver, deliberately: the same shard
 * resume contract, the same exhaustive §7 battery run twice (on the way out of
 * each shard and again on the way into the merge), the same sealed held-out
 * file. Three things differ and nothing else:
 *
 *   1. the capture is `cfTop5CaptureGroup` — five-wide candidate sets, built
 *      under frozen π1's visitation, reference and continuation;
 *   2. the expectation points the battery at the top5 universe and at
 *      `cfProposal5` / `CF_TOP5_LIMIT`, so a five-wide snapshot is judged
 *      against the interface it was actually built from;
 *   3. the salts and the dataset version are this round's.
 *
 * Blind protocol unchanged: held-out is generated like any other split, sealed
 * on write, and never loaded here.
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
import { CF_LGBM_CONFIG_VERSION, cfAuditStructure, cfSchemaHash, sha256 } from "./cf-corpus.js";
import { CF_PI_MODEL_SHA256, CF_PI_THRESHOLD } from "./cf-policy-iteration.js";
import { cfPiFrozenBaseline } from "./cf-pi-corpus.js";
import { cfPiAssertGroup } from "./cf-pi-corpus.js";
import {
  CF_TOP5_DATASET_VERSION,
  CF_TOP5_LIMIT,
  CF_TOP5_SNAPSHOT_SALT,
  CF_TOP5_SPLIT_SALT,
  cfTop5CaptureGroup,
} from "./cf-top5.js";
import {
  CF_TOP5_GROUP_EXPECTATION,
  CF_TOP5_GROUP_SNAPSHOT_CAP,
  CF_TOP5_SEED_BASE,
  CF_TOP5_SPLIT_COUNTS,
  CF_TOP5_UNIVERSE_END,
  CF_TOP5_UNIVERSE_START,
  assertTop5SeedBase,
  cfTop5GroupSpecFor,
  cfTop5SplitOf,
} from "./cf-top5-corpus.js";
import { CF_SPLIT_COUNTS } from "./cf-dataset.js";

const GENERATE_OUT = process.env.AI_CF_T5_GENERATE;
const MERGE_DIR = process.env.AI_CF_T5_MERGE;
const AUDIT_DIR = process.env.AI_CF_T5_AUDIT;
const CORPUS_DIR = process.env.AI_CF_T5_CORPUS_DIR ?? ".local/cf-top5-corpus";
const POLICY_COMMIT = process.env.AI_CF_T5_POLICY_COMMIT ?? "unset";

const ENABLED = GENERATE_OUT !== undefined || MERGE_DIR !== undefined || AUDIT_DIR !== undefined;
const TIMEOUT_MS = 6 * 60 * 60 * 1000;

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

function splitOfOrThrow(dealIndex: number): CfSplit {
  const split = cfTop5SplitOf(dealIndex);
  if (split === undefined) {
    throw new Error(`Deal ${dealIndex} is outside the preregistered top5 universe.`);
  }
  return split;
}

function corpusFileName(split: CfSplit): string {
  return split === "heldout" ? "heldout.sealed.json" : `${split}.json`;
}

function expectedVersions(proposalForLimit: number) {
  return Object.freeze({
    dataset: CF_TOP5_DATASET_VERSION,
    featureSchema: CF_FEATURE_SCHEMA_VERSION,
    rules: CF_RULES_VERSION,
    policyCommit: POLICY_COMMIT,
    schemaHash: cfSchemaHash(),
    splitSalt: CF_TOP5_SPLIT_SALT,
    snapshotSalt: CF_TOP5_SNAPSHOT_SALT,
    lgbmConfig: CF_LGBM_CONFIG_VERSION,
    baselineModelSha256: CF_PI_MODEL_SHA256,
    threshold: CF_PI_THRESHOLD,
    seedBase: CF_TOP5_SEED_BASE,
    snapshotCap: CF_TOP5_GROUP_SNAPSHOT_CAP,
    candidateLimit: proposalForLimit,
  });
}

describe.runIf(ENABLED)("Spec 065 top5 corpus", () => {
  it("generates one shard, merges the shards, or audits the corpus", () => {
    assertTop5SeedBase(CF_TOP5_SEED_BASE);
    const baseline = cfPiFrozenBaseline();

    if (GENERATE_OUT !== undefined) {
      const dealStart = envInt("AI_CF_T5_DEAL_START", CF_TOP5_UNIVERSE_START);
      const deals = Math.max(1, envInt("AI_CF_T5_DEALS", 100));
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
        const spec = cfTop5GroupSpecFor(dealIndex, POLICY_COMMIT);
        const result = cfTop5CaptureGroup(dealDeck(spec.dealSeed), spec, baseline);
        const audit = cfPiAssertGroup(result, split, failures, CF_TOP5_GROUP_EXPECTATION);
        snapshots += audit.snapshots;
        rows += audit.rows;
        overridden += audit.overridden;
        farmerRoots += result.totalFarmerRoots;
        usefulRoots += result.usefulFarmerRoots;
        groups.push(result);
      }

      const payload = {
        shard: { dealStart, deals },
        versions: expectedVersions(CF_TOP5_LIMIT),
        groups,
      };
      const text = `${JSON.stringify(payload)}\n`;
      mkdirSync(dirname(GENERATE_OUT), { recursive: true });
      writeFileSync(GENERATE_OUT, text, "utf8");

      const elapsed = (performance.now() - started) / 1000;
      report(
        `[t5 shard ${dealStart}..${dealStart + deals - 1}] groups ${groups.length} ` +
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
      const expected = expectedVersions(CF_TOP5_LIMIT);
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
        const shard = JSON.parse(text) as {
          shard: { dealStart: number; deals: number };
          versions: Record<string, string | number>;
          groups: CfGroupResult[];
        };
        shardHashes[name] = sha256(text);
        for (const [key, value] of Object.entries(expected)) {
          if (shard.versions[key] !== value) {
            throw new Error(
              `${name} disagrees on ${key}: ${String(shard.versions[key])} != ${String(value)}`,
            );
          }
        }
        if (shard.groups.length !== shard.shard.deals) {
          throw new Error(`${name} holds ${shard.groups.length} groups, expected ${shard.shard.deals}.`);
        }
        expectedGroups += shard.shard.deals;
        for (const group of shard.groups) {
          const split = splitOfOrThrow(group.dealIndex);
          if (seenDeals.has(group.dealIndex)) {
            throw new Error(`§7.16 deal ${group.dealIndex} appears in more than one shard.`);
          }
          seenDeals.add(group.dealIndex);
          const audit = cfPiAssertGroup(group, split, failures, CF_TOP5_GROUP_EXPECTATION);
          snapshots += audit.snapshots;
          rows += audit.rows;
          overridden += audit.overridden;
          bySplit[split].push(group);
        }
      }

      for (const split of ["train", "calibration", "heldout"] as const) {
        bySplit[split].sort((left, right) => left.dealIndex - right.dealIndex);
        if (bySplit[split].length !== CF_TOP5_SPLIT_COUNTS[split]) {
          throw new Error(
            `§7.16 ${split} holds ${bySplit[split].length} groups, expected ${CF_TOP5_SPLIT_COUNTS[split]}.`,
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
        round: "spec-065-candidate-width-top5",
        pipelineCommit: POLICY_COMMIT,
        baselineModelSha256: CF_PI_MODEL_SHA256,
        threshold: CF_PI_THRESHOLD,
        schemaHash: cfSchemaHash(),
        splitSalt: CF_TOP5_SPLIT_SALT,
        snapshotSalt: CF_TOP5_SNAPSHOT_SALT,
        lgbmConfigVersion: CF_LGBM_CONFIG_VERSION,
        datasetVersion: CF_TOP5_DATASET_VERSION,
        featureSchemaVersion: CF_FEATURE_SCHEMA_VERSION,
        rulesVersion: CF_RULES_VERSION,
        seedBase: CF_TOP5_SEED_BASE,
        candidateLimit: CF_TOP5_LIMIT,
        universe: { start: CF_TOP5_UNIVERSE_START, end: CF_TOP5_UNIVERSE_END },
        splitCounts: CF_SPLIT_COUNTS,
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
        const audit = cfAuditStructure(bySplit[split], split, cfTop5SplitOf);
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
      report(`merged corpus checksum ${manifest.mergedCorpusChecksum}`);
      expect(manifest.mergedCorpusChecksum.length).toBe(64);
      return;
    }

    const corpusDir = AUDIT_DIR ?? CORPUS_DIR;
    const load = (name: string): readonly CfGroupResult[] =>
      (JSON.parse(readFileSync(join(corpusDir, name), "utf8")) as {
        groups: readonly CfGroupResult[];
      }).groups;
    const train = load(corpusFileName("train"));
    const calibration = load(corpusFileName("calibration"));
    const heldout = load(corpusFileName("heldout"));

    report(`\n== Spec 065 top5 corpus audit ==`);
    for (const [name, groups, split] of [
      ["train", train, "train"],
      ["calibration", calibration, "calibration"],
      ["heldout", heldout, "heldout"],
    ] as const) {
      const audit = cfAuditStructure(groups, split, cfTop5SplitOf);
      report(
        `[${name}] groups ${audit.groups}  snapshots ${audit.snapshots}  rows ${audit.rows}  ` +
        `splitMismatch ${audit.splitMismatches}  schemaMismatch ${audit.schemaMismatches}  ` +
        `labelIntegrity ${audit.labelIntegrityFailures}  productionIndex ${audit.productionIndexFailures}`,
      );
    }
    expect(train.length + calibration.length + heldout.length).toBe(
      CF_TOP5_SPLIT_COUNTS.train + CF_TOP5_SPLIT_COUNTS.calibration + CF_TOP5_SPLIT_COUNTS.heldout,
    );
  }, TIMEOUT_MS);
});
