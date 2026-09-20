/**
 * Gate A v1: row export and calibration.
 *
 * Two env-gated modes, both off by default.
 *
 *   rows       AI_CF_DUMP_ROWS=<dir>  AI_CF_CORPUS_DIR=.local/cf-corpus
 *   calibrate  AI_CF_CALIBRATE=<dir>  AI_CF_CORPUS_DIR=.local/cf-corpus
 *
 * The split between here and Python is deliberate: Python fits the model and
 * predicts scores, and *everything else* — row assembly, weights, the selector,
 * the group-level reduction, the threshold grid, the gate rule — stays in
 * TypeScript, where it is unit-tested and frozen. A number produced by a script
 * nobody can re-run is not a preregistered result.
 *
 * Blind protocol: held-out is never loaded in either mode.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { report } from "./ai-tournament.js";
import {
  CF_FEATURE_NAMES,
  cfRow,
  type CfGroupResult,
  type CfLabel,
  type CfSplit,
} from "./cf-dataset.js";
import { cfLabelTally, cfSchemaHash } from "./cf-corpus.js";
import {
  CF_THRESHOLD_GRID,
  cfChooseOverride,
  cfScoredRootFromSnapshot,
  cfSelectThreshold,
  cfThresholdOutcome,
  type CfScoredCandidate,
  type CfScoredRoot,
} from "./cf-selector.js";
import { tQuantile } from "./cf-tquantile.js";

const DUMP_DIR = process.env.AI_CF_DUMP_ROWS;
const CALIBRATE_DIR = process.env.AI_CF_CALIBRATE;
const CORPUS_DIR = process.env.AI_CF_CORPUS_DIR ?? ".local/cf-corpus";

const ENABLED = DUMP_DIR !== undefined || CALIBRATE_DIR !== undefined;

type ExportedRow = Readonly<{
  id: string;
  groupId: string;
  snapshotId: string;
  y: CfLabel;
  w: number;
  x: readonly number[];
  candidateOrder: number;
}>;

type RowFile = Readonly<{
  split: CfSplit;
  schemaHash: string;
  featureNames: readonly string[];
  /** Every registered group of this split, in group order — the R_i denominator. */
  registeredGroups: readonly string[];
  rootsPerGroup: Readonly<Record<string, number>>;
  rows: readonly ExportedRow[];
}>;

function loadGroups(dir: string, name: string): readonly CfGroupResult[] {
  return (JSON.parse(readFileSync(join(dir, name), "utf8")) as {
    groups: readonly CfGroupResult[];
  }).groups;
}

/** Every non-a0 candidate row of one split, with its frozen weight. */
function exportSplit(
  groups: readonly CfGroupResult[],
  split: CfSplit,
): RowFile {
  const rootsPerGroup: Record<string, number> = {};
  const alternativesPerRoot = new Map<string, number>();
  const pending: Array<Omit<ExportedRow, "w">> = [];

  for (const group of groups) {
    rootsPerGroup[group.groupId] = group.snapshots.length;
    for (const snapshot of group.snapshots) {
      const referenceIndex = snapshot.candidates[snapshot.productionIndex]?.actionIndex;
      if (referenceIndex === undefined) {
        throw new Error(`Snapshot ${snapshot.meta.snapshotId} has no reference action.`);
      }
      const reference = snapshot.actions[referenceIndex];
      if (reference === undefined) {
        throw new Error(`Snapshot ${snapshot.meta.snapshotId} has no reference action object.`);
      }
      snapshot.candidates.forEach((candidate, index) => {
        if (index === snapshot.productionIndex) {
          return;
        }
        const action = snapshot.actions[candidate.actionIndex];
        const label = snapshot.labels[index];
        if (action === undefined || label === undefined) {
          throw new Error(`Snapshot ${snapshot.meta.snapshotId} candidate ${index} is incomplete.`);
        }
        pending.push({
          id: `${snapshot.meta.snapshotId}#${index}`,
          groupId: group.groupId,
          snapshotId: snapshot.meta.snapshotId,
          y: label,
          x: cfRow(snapshot.view, action, reference),
          candidateOrder: index,
        });
        alternativesPerRoot.set(
          snapshot.meta.snapshotId,
          (alternativesPerRoot.get(snapshot.meta.snapshotId) ?? 0) + 1,
        );
      });
    }
  }

  // w ∝ 1 / (sampled roots in the group × alternatives at this root), then
  // normalised so the split's mean weight is exactly 1. Every useful root and
  // every group therefore carries the same total weight.
  const raw = pending.map((row) =>
    1 / (
      Math.max(1, rootsPerGroup[row.groupId] ?? 1) *
      Math.max(1, alternativesPerRoot.get(row.snapshotId) ?? 1)
    ));
  const mean = raw.length === 0 ? 1 : raw.reduce((sum, value) => sum + value, 0) / raw.length;
  const rows = pending.map((row, index) => Object.freeze({
    ...row,
    w: (raw[index] ?? 0) / (mean === 0 ? 1 : mean),
  }));

  return Object.freeze({
    split,
    schemaHash: cfSchemaHash(),
    featureNames: CF_FEATURE_NAMES,
    registeredGroups: Object.freeze(groups.map((group) => group.groupId)),
    rootsPerGroup: Object.freeze(rootsPerGroup),
    rows: Object.freeze(rows),
  });
}

describe.runIf(ENABLED)("Gate A v1 rows and calibration", () => {
  it("exports rows, or runs the calibration threshold grid", () => {
    if (DUMP_DIR !== undefined) {
      mkdirSync(DUMP_DIR, { recursive: true });
      for (const split of ["train", "calibration"] as const) {
        const payload = exportSplit(loadGroups(CORPUS_DIR, `${split}.json`), split);
        const text = `${JSON.stringify(payload)}\n`;
        writeFileSync(join(DUMP_DIR, `${split}.rows.json`), text, "utf8");
        const labels = cfLabelTally(payload.rows.map((row) => row.y));
        const weights = payload.rows.map((row) => row.w);
        report(
          `[rows ${split}] groups ${payload.registeredGroups.length} ` +
          `roots ${Object.values(payload.rootsPerGroup).reduce((a, b) => a + b, 0)} ` +
          `rows ${payload.rows.length} labels ${JSON.stringify(labels)} ` +
          `weight mean ${(weights.reduce((a, b) => a + b, 0) / Math.max(1, weights.length)).toFixed(6)} ` +
          `min ${Math.min(...weights).toFixed(6)} max ${Math.max(...weights).toFixed(6)} ` +
          `${(text.length / 1024 / 1024).toFixed(1)} MiB`,
        );
      }
      return;
    }

    const dir = CALIBRATE_DIR ?? "";
    const rowFile = JSON.parse(
      readFileSync(join(dir, "calibration.rows.json"), "utf8"),
    ) as RowFile;
    const scoreFile = JSON.parse(
      readFileSync(join(dir, "calibration.scores.json"), "utf8"),
    ) as { scores: Record<string, number> };

    const grouped = new Map<string, CfScoredCandidate[]>();
    for (const row of rowFile.rows) {
      const list = grouped.get(row.snapshotId) ?? [];
      list.push(Object.freeze({
        candidateOrder: row.candidateOrder,
        score: scoreFile.scores[row.id] ?? Number.NaN,
        label: row.y,
      }));
      grouped.set(row.snapshotId, list);
    }
    const rootCounts = new Map<string, number>(Object.entries(rowFile.rootsPerGroup));
    for (const list of grouped.values()) {
      list.sort((left, right) => left.candidateOrder - right.candidateOrder);
    }
    const roots: CfScoredRoot[] = [...grouped.entries()].map(([snapshotId, candidates]) => {
      const groupId = rowFile.rows.find((row) => row.snapshotId === snapshotId)?.groupId ?? "";
      return Object.freeze({
        snapshotId,
        groupId,
        candidates: Object.freeze(candidates),
      });
    });
    if (roots.some((root) => root.candidates.some((candidate) => !Number.isFinite(candidate.score)))) {
      throw new Error("Some calibration rows have no score — the model did not cover every row.");
    }

    const outcomes = CF_THRESHOLD_GRID.map((threshold) => cfThresholdOutcome(
      roots.map((root) => cfChooseOverride(root, threshold)),
      rowFile.registeredGroups,
      rootCounts,
      threshold,
      tQuantile,
    ));

    report(`\n== Gate A v1 calibration (${rowFile.registeredGroups.length} registered groups) ==`);
    report(`roots with a choice ${roots.length}   rows ${rowFile.rows.length}`);
    report(
      "threshold     mu_hat       L_cal   overrideDeals  selectedNonzero  coverage  cond(good-bad)/ovr",
    );
    for (const outcome of outcomes) {
      report(
        `${String(outcome.threshold).padStart(8)}  ${outcome.mean.toFixed(6).padStart(10)}  ` +
        `${outcome.lower.toFixed(6).padStart(10)}  ${String(outcome.overrideDeals).padStart(13)}  ` +
        `${String(outcome.selectedNonzeroDeals).padStart(15)}  ` +
        `${(outcome.coverage * 100).toFixed(2).padStart(7)}%  ${outcome.conditional.toFixed(4).padStart(8)}`,
      );
    }

    const decision = cfSelectThreshold(outcomes);
    if (decision.reason === "calibration-no-go") {
      report(`\nDECISION: CALIBRATION NO-GO — no supported threshold has L_cal > 0.`);
      report(`STOP Phase 2 v1. The held-out split is not opened.`);
    } else {
      report(`\nDECISION: threshold = ${decision.selected}`);
      report(`eligible thresholds: ${decision.eligible.join(", ")}`);
    }

    writeFileSync(join(dir, "threshold.json"), `${JSON.stringify({
      schemaHash: rowFile.schemaHash,
      featureNames: rowFile.featureNames,
      decision: decision.reason,
      selected: decision.reason === "selected" ? decision.selected : null,
      eligible: decision.eligible,
      outcomes: outcomes.map((outcome) => ({
        threshold: outcome.threshold,
        mean: outcome.mean,
        lower: outcome.lower,
        se: outcome.se,
        overrideDeals: outcome.overrideDeals,
        selectedNonzeroDeals: outcome.selectedNonzeroDeals,
        coverage: outcome.coverage,
        conditional: outcome.conditional,
      })),
    }, null, 2)}\n`, "utf8");

    expect(outcomes.length).toBe(CF_THRESHOLD_GRID.length);
    void cfScoredRootFromSnapshot;
  });
});
