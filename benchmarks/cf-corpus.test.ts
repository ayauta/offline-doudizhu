/**
 * Gate A v1 corpus generator, merger and auditor.
 *
 * Three env-gated modes, all off by default so `pnpm bench:ai` never starts a
 * multi-hour job by accident:
 *
 *   generate  AI_CF_GENERATE=<shard.json> AI_CF_DEAL_START=50001 AI_CF_DEALS=1250
 *   merge     AI_CF_MERGE=<shard dir> AI_CF_CORPUS_DIR=.local/cf-corpus
 *   audit     AI_CF_AUDIT=.local/cf-corpus
 *
 * Blind protocol (spec §13): held-out labels are written to a sealed file and
 * are never summarised here. `cfAuditStructure` returns no label field at all,
 * so the only way to see a held-out outcome is to go and read the sealed file on
 * purpose. Train and calibration report freely; held-out reports shape only.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { dealDeck, report } from "./ai-tournament.js";
import {
  CF_DATASET_VERSION,
  CF_FEATURE_SCHEMA_VERSION,
  CF_RULES_VERSION,
  CF_SPLIT_COUNTS,
  CF_SPLIT_SALT,
  CF_SNAPSHOT_SALT,
  CF_UNIVERSE_END,
  CF_UNIVERSE_START,
  cfCaptureGroup,
  type CfGroupResult,
  type CfRow,
  type CfSplit,
} from "./cf-dataset.js";
import {
  CF_LGBM_CONFIG_VERSION,
  cfAuditStructure,
  cfGroupSpecFor,
  cfLabelTally,
  cfRowsForGroup,
  cfSchemaHash,
  cfSeatCoverage,
  cfSplitOf,
  sha256,
  type CfShardFile,
} from "./cf-corpus.js";

const GENERATE_OUT = process.env.AI_CF_GENERATE;
const MERGE_DIR = process.env.AI_CF_MERGE;
const AUDIT_DIR = process.env.AI_CF_AUDIT;
const CORPUS_DIR = process.env.AI_CF_CORPUS_DIR ?? ".local/cf-corpus";
const POLICY_COMMIT = process.env.AI_CF_POLICY_COMMIT ?? "unset";
const BASELINE_COMMIT = process.env.AI_CF_BASELINE_COMMIT ?? "ea67aa3";

const ENABLED = GENERATE_OUT !== undefined || MERGE_DIR !== undefined || AUDIT_DIR !== undefined;

/**
 * Generating a shard is a multi-hour job, so the runner needs an explicit
 * budget rather than the config's 15-minute default.
 *
 * The first full run of this file timed out on every shard — and *still wrote
 * every shard file*, because vitest cannot interrupt a synchronous test: the
 * work finished, the file landed, and the timeout was reported afterwards. The
 * driver read those reports as failures and skipped the merge, so a corpus that
 * was complete on disk looked like one that had never been built. The timeout
 * is now stated here instead of inherited, and the driver resumes rather than
 * restarting, so neither a slow machine nor a suspended one can turn finished
 * work into a reported failure.
 */
const CF_GENERATE_TIMEOUT_MS = 6 * 60 * 60 * 1000;

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
  const split = cfSplitOf(dealIndex);
  if (split === undefined) {
    throw new Error(`Deal ${dealIndex} is outside the preregistered universe.`);
  }
  return split;
}

function labelCounts(rows: readonly CfRow[]): Readonly<{ "+1": number; "0": number; "-1": number }> {
  return cfLabelTally(rows.map((row) => row.y));
}

/** Group-level outcome summary — only ever called on train and calibration. */
function outcomeSummary(rows: readonly CfRow[]): readonly string[] {
  const counts = labelCounts(rows);
  const total = rows.length;
  const nonzero = counts["+1"] + counts["-1"];
  const groups = new Set(rows.map((row) => row.groupId));
  const roots = new Set(rows.map((row) => row.snapshotId));
  const byGroup = new Map<string, number>();
  for (const row of rows) {
    if (row.y !== 0) {
      byGroup.set(row.groupId, (byGroup.get(row.groupId) ?? 0) + 1);
    }
  }
  const concentrated = [...byGroup.values()].sort((left, right) => right - left);
  return [
    `rows ${total}  +1 ${counts["+1"]}  0 ${counts["0"]}  -1 ${counts["-1"]}  nonzero ${((nonzero / Math.max(1, total)) * 100).toFixed(2)}%`,
    `groups ${groups.size}  roots ${roots.size}  rows/root ${(total / Math.max(1, roots.size)).toFixed(2)}`,
    `groups with a nonzero row ${byGroup.size}  worst group ${concentrated[0] ?? 0} rows`,
    `nonzero per group p50 ${concentrated[Math.floor(concentrated.length / 2)] ?? 0}  p90 ${concentrated[Math.floor(concentrated.length * 0.1)] ?? 0}`,
  ];
}

describe.runIf(ENABLED)("Gate A v1 corpus", () => {
  it("generates one shard, merges the shards, or audits the corpus", () => {
    if (GENERATE_OUT !== undefined) {
      const dealStart = envInt("AI_CF_DEAL_START", CF_UNIVERSE_START);
      const deals = Math.max(1, envInt("AI_CF_DEALS", 100));
      const started = performance.now();
      const groups: CfGroupResult[] = [];
      let snapshots = 0;
      let farmerRoots = 0;
      let usefulRoots = 0;

      for (let offset = 0; offset < deals; offset += 1) {
        const dealIndex = dealStart + offset;
        const spec = cfGroupSpecFor(dealIndex, POLICY_COMMIT);
        if (spec === null) {
          continue;
        }
        splitOfOrThrow(dealIndex);
        const result = cfCaptureGroup(dealDeck(spec.dealSeed), spec);
        groups.push(result);
        snapshots += result.snapshots.length;
        farmerRoots += result.totalFarmerRoots;
        usefulRoots += result.usefulFarmerRoots;
      }

      const payload: CfShardFile = {
        shard: { dealStart, deals },
        versions: {
          dataset: CF_DATASET_VERSION,
          featureSchema: CF_FEATURE_SCHEMA_VERSION,
          rules: CF_RULES_VERSION,
          policyCommit: POLICY_COMMIT,
          schemaHash: cfSchemaHash(),
          splitSalt: CF_SPLIT_SALT,
          snapshotSalt: CF_SNAPSHOT_SALT,
          lgbmConfig: CF_LGBM_CONFIG_VERSION,
        },
        groups,
      };
      const text = `${JSON.stringify(payload)}\n`;
      mkdirSync(dirname(GENERATE_OUT), { recursive: true });
      writeFileSync(GENERATE_OUT, text, "utf8");

      const elapsed = (performance.now() - started) / 1000;
      report(
        `[cf shard ${dealStart}..${dealStart + deals - 1}] groups ${groups.length} ` +
        `snapshots ${snapshots}  farmerRoots ${farmerRoots}  usefulRoots ${usefulRoots}  ` +
        `${elapsed.toFixed(0)}s  ${(text.length / 1024 / 1024).toFixed(1)} MiB  ` +
        `sha256 ${sha256(text).slice(0, 16)}`,
      );
      expect(groups.length).toBeGreaterThan(0);
      return;
    }

    if (MERGE_DIR !== undefined) {
      const names = readdirSync(MERGE_DIR).filter((name) => name.endsWith(".json")).sort();
      const bySplit: Record<CfSplit, CfGroupResult[]> = { train: [], calibration: [], heldout: [] };
      const shardHashes: Record<string, string> = {};
      let expectedGroups = 0;
      for (const name of names) {
        const path = join(MERGE_DIR, name);
        const text = readFileSync(path, "utf8");
        const shard = JSON.parse(text) as CfShardFile;
        shardHashes[name] = sha256(text);
        expectedGroups += shard.shard.deals;
        for (const group of shard.groups) {
          bySplit[splitOfOrThrow(group.dealIndex)].push(group);
        }
      }
      for (const split of ["train", "calibration", "heldout"] as const) {
        bySplit[split].sort((left, right) => left.dealIndex - right.dealIndex);
      }

      mkdirSync(CORPUS_DIR, { recursive: true });
      const fileHashes: Record<string, string> = {};
      for (const split of ["train", "calibration", "heldout"] as const) {
        const body = `${JSON.stringify({
          split,
          schemaHash: cfSchemaHash(),
          groups: bySplit[split],
        })}\n`;
        const name = split === "heldout" ? "heldout.sealed.json" : `${split}.json`;
        writeFileSync(join(CORPUS_DIR, name), body, "utf8");
        fileHashes[name] = sha256(body);
      }

      const manifest = {
        pipelineCommit: POLICY_COMMIT,
        productionBaselineCommit: BASELINE_COMMIT,
        schemaHash: cfSchemaHash(),
        splitSalt: CF_SPLIT_SALT,
        snapshotSalt: CF_SNAPSHOT_SALT,
        lgbmConfigVersion: CF_LGBM_CONFIG_VERSION,
        datasetVersion: CF_DATASET_VERSION,
        featureSchemaVersion: CF_FEATURE_SCHEMA_VERSION,
        rulesVersion: CF_RULES_VERSION,
        universe: { start: CF_UNIVERSE_START, end: CF_UNIVERSE_END },
        splitCounts: CF_SPLIT_COUNTS,
        shards: { count: names.length, expectedGroups, hashes: shardHashes },
        files: fileHashes,
        mergedCorpusChecksum: sha256(
          (["train", "calibration", "heldout"] as const).map((split) => fileHashes[
            split === "heldout" ? "heldout.sealed.json" : `${split}.json`
          ]).join(":"),
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
      report(`manifest ${join(CORPUS_DIR, "manifest.json")}`);
      report(`merged corpus checksum ${manifest.mergedCorpusChecksum}`);
      expect(manifest.mergedCorpusChecksum.length).toBe(64);
      return;
    }

    const corpusDir = AUDIT_DIR ?? CORPUS_DIR;
    const load = (name: string): readonly CfGroupResult[] =>
      readJson<{ groups: readonly CfGroupResult[] }>(join(corpusDir, name)).groups;
    const train = load("train.json");
    const calibration = load("calibration.json");
    const heldout = load("heldout.sealed.json");

    report(`\n== Gate A v1 corpus audit ==`);
    for (const [name, groups, split] of [
      ["train", train, "train"],
      ["calibration", calibration, "calibration"],
      ["heldout", heldout, "heldout"],
    ] as const) {
      const audit = cfAuditStructure(groups, split);
      report(
        `[${name}] groups ${audit.groups}  snapshots ${audit.snapshots}  rows ${audit.rows}  ` +
        `seats ${JSON.stringify(cfSeatCoverage(groups))}`,
      );
      if (split === "heldout") {
        // Blind: shape only. No label field is even computed for this split.
        report(
          `[heldout] BLIND — structure only. splitMismatch ${audit.splitMismatches}  ` +
          `schemaMismatch ${audit.schemaMismatches}  labelIntegrity ${audit.labelIntegrityFailures}  ` +
          `productionIndex ${audit.productionIndexFailures}`,
        );
        continue;
      }
      const rows = groups.flatMap((result) => cfRowsForGroup(result, split));
      for (const line of outcomeSummary(rows)) {
        report(`[${name}] ${line}`);
      }
      const gapBuckets = new Map<string, { n: number; nonzero: number }>();
      for (const row of rows) {
        const bucket = row.expertGap <= 0 ? "<=0" : row.expertGap < 500 ? "0-500" : row.expertGap < 1500 ? "500-1500" : ">=1500";
        const entry = gapBuckets.get(bucket) ?? { n: 0, nonzero: 0 };
        entry.n += 1;
        if (row.y !== 0) {
          entry.nonzero += 1;
        }
        gapBuckets.set(bucket, entry);
      }
      report(
        `[${name}] expertGap buckets ` +
        [...gapBuckets.entries()].sort().map(([bucket, entry]) =>
          `${bucket}:${entry.nonzero}/${entry.n}`).join("  "),
      );
    }
    expect(train.length + calibration.length + heldout.length).toBe(
      CF_SPLIT_COUNTS.train + CF_SPLIT_COUNTS.calibration + CF_SPLIT_COUNTS.heldout,
    );
  }, CF_GENERATE_TIMEOUT_MS);
});
