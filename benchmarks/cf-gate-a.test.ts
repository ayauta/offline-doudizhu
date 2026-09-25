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
import { cfAuditStructure, cfLabelTally, cfSchemaHash } from "./cf-corpus.js";
import {
  CF_MIN_OVERRIDE_DEALS,
  CF_MIN_SELECTED_NONZERO_DEALS,
  CF_MU_MIN,
  CF_THRESHOLD_GRID,
  cfChooseOverride,
  cfHeldoutVerdict,
  cfScoredRootFromSnapshot,
  cfSelectThreshold,
  cfThresholdOutcome,
  type CfScoredCandidate,
  type CfScoredRoot,
} from "./cf-selector.js";
import { tQuantile } from "./cf-tquantile.js";

const DUMP_DIR = process.env.AI_CF_DUMP_ROWS;
const CALIBRATE_DIR = process.env.AI_CF_CALIBRATE;
const HELDOUT_DIR = process.env.AI_CF_HELDOUT;
const CORPUS_DIR = process.env.AI_CF_CORPUS_DIR ?? ".local/cf-corpus";

const ENABLED = DUMP_DIR !== undefined || CALIBRATE_DIR !== undefined || HELDOUT_DIR !== undefined;

/**
 * Which splits the row exporter writes. Held-out is opt-in and never part of a
 * default run, so no ordinary invocation can produce a readable held-out row
 * file by accident.
 */
function dumpSplits(): readonly CfSplit[] {
  const raw = process.env.AI_CF_DUMP_SPLITS ?? "train,calibration";
  return raw.split(",").map((entry) => entry.trim()).filter((entry): entry is CfSplit =>
    entry === "train" || entry === "calibration" || entry === "heldout");
}

function corpusFileName(split: CfSplit): string {
  return split === "heldout" ? "heldout.sealed.json" : `${split}.json`;
}

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
      for (const split of dumpSplits()) {
        const payload = exportSplit(loadGroups(CORPUS_DIR, corpusFileName(split)), split);
        const text = `${JSON.stringify(payload)}\n`;
        writeFileSync(join(DUMP_DIR, `${split}.rows.json`), text, "utf8");
        const labels = cfLabelTally(payload.rows.map((row) => row.y));
        const weights = payload.rows.map((row) => row.w);
        report(
          `[rows ${split}] groups ${payload.registeredGroups.length} ` +
          `roots ${Object.values(payload.rootsPerGroup).reduce((a, b) => a + b, 0)} ` +
          `rows ${payload.rows.length} labels ${split === "heldout" ? "BLIND (not read before the primary)" : JSON.stringify(labels)} ` +
          `weight mean ${(weights.reduce((a, b) => a + b, 0) / Math.max(1, weights.length)).toFixed(6)} ` +
          `min ${Math.min(...weights).toFixed(6)} max ${Math.max(...weights).toFixed(6)} ` +
          `${(text.length / 1024 / 1024).toFixed(1)} MiB`,
        );
      }
      return;
    }

    if (HELDOUT_DIR !== undefined) {
      // The threshold is read from the frozen calibration artifact rather than
      // retyped here, so the number this run applies is the number that was
      // frozen and not a transcription of it.
      const thresholdFile = JSON.parse(
        readFileSync(process.env.AI_CF_THRESHOLD_FILE ?? ".local/cf-rows/threshold.json", "utf8"),
      ) as { decision: string; selected: number | null; schemaHash: string };
      if (thresholdFile.decision !== "selected" || typeof thresholdFile.selected !== "number") {
        throw new Error("No threshold was frozen; the held-out split must not be opened.");
      }
      if (thresholdFile.schemaHash !== cfSchemaHash()) {
        throw new Error("The frozen threshold was chosen under a different feature schema.");
      }
      const threshold = thresholdFile.selected;

      const rowFile = JSON.parse(
        readFileSync(join(HELDOUT_DIR, "heldout.rows.json"), "utf8"),
      ) as RowFile;
      const scoreFile = JSON.parse(
        readFileSync(join(HELDOUT_DIR, "heldout.scores.json"), "utf8"),
      ) as { scores: Record<string, number> };
      const groups = loadGroups(CORPUS_DIR, "heldout.sealed.json");

      const audit = cfAuditStructure(groups, "heldout");
      const integrityValid = audit.splitMismatches === 0 && audit.schemaMismatches === 0 &&
        audit.labelIntegrityFailures === 0 && audit.productionIndexFailures === 0;

      const bySnapshot = new Map<string, CfScoredCandidate[]>();
      for (const row of rowFile.rows) {
        const list = bySnapshot.get(row.snapshotId) ?? [];
        list.push(Object.freeze({
          candidateOrder: row.candidateOrder,
          score: scoreFile.scores[row.id] ?? Number.NaN,
          label: row.y,
        }));
        bySnapshot.set(row.snapshotId, list);
      }
      for (const list of bySnapshot.values()) {
        list.sort((left, right) => left.candidateOrder - right.candidateOrder);
      }
      const groupOfSnapshot = new Map<string, string>();
      const gapsOfSnapshot = new Map<string, Map<number, number>>();
      const attrsOfSnapshot = new Map<string, Readonly<{ seat: string; landlord: string; minRemaining: number }>>();
      for (const group of groups) {
        for (const snapshot of group.snapshots) {
          groupOfSnapshot.set(snapshot.meta.snapshotId, group.groupId);
          gapsOfSnapshot.set(snapshot.meta.snapshotId, new Map(
            snapshot.candidates.map((_candidate, index) => [index, snapshot.diagnostics.expertGap[index] ?? 0]),
          ));
          attrsOfSnapshot.set(snapshot.meta.snapshotId, Object.freeze({
            seat: snapshot.meta.seat,
            landlord: snapshot.meta.landlord,
            minRemaining: snapshot.diagnostics.minRemaining,
          }));
        }
      }
      const roots: CfScoredRoot[] = [...bySnapshot.entries()].map(([snapshotId, candidates]) =>
        Object.freeze({
          snapshotId,
          groupId: groupOfSnapshot.get(snapshotId) ?? "",
          candidates: Object.freeze(candidates),
        }));
      if (roots.some((root) => root.candidates.some((candidate) => !Number.isFinite(candidate.score)))) {
        throw new Error("Some held-out rows have no score.");
      }

      const choices = roots.map((root) => cfChooseOverride(root, threshold));
      const outcome = cfThresholdOutcome(choices, rowFile.registeredGroups, new Map(
        Object.entries(rowFile.rootsPerGroup),
      ), threshold, tQuantile);
      const verdict = cfHeldoutVerdict(
        outcome.perGroup,
        outcome.overrideDeals,
        outcome.selectedNonzeroDeals,
        integrityValid,
        tQuantile,
      );

      report(`\n===== GATE A v1 FORMAL HELD-OUT =====`);
      report(`frozen threshold ${threshold}   schema ${thresholdFile.schemaHash.slice(0, 16)}   integrity ${integrityValid ? "valid" : "INVALID"}`);
      report(`\n-- PRIMARY (group-level, all ${outcome.groups} registered groups in the denominator) --`);
      report(`N registered groups        ${outcome.groups}`);
      report(`mu_hat                     ${verdict.mean.toFixed(6)}`);
      report(`SE                         ${outcome.se.toFixed(6)}`);
      report(`97.5% t interval           [${verdict.lower.toFixed(6)}, ${verdict.upper.toFixed(6)}]`);
      report(`mu_min                     ${CF_MU_MIN}`);
      report(`override distinct deals    ${verdict.overrideDeals}  (floor ${CF_MIN_OVERRIDE_DEALS})`);
      report(`selected-nonzero deals     ${verdict.selectedNonzeroDeals}  (floor ${CF_MIN_SELECTED_NONZERO_DEALS})`);
      report(`reasons                    ${verdict.reasons.length === 0 ? "(none)" : verdict.reasons.join("; ")}`);
      report(`\n*** GATE A ${verdict.status.toUpperCase()} ***`);

      report(`\n-- SELECTOR DIAGNOSTICS --`);
      report(`sampled snapshots          ${roots.length}`);
      report(`override snapshots         ${outcome.overrides}`);
      report(`override distinct deals    ${outcome.overrideDeals} / ${outcome.groups} = ${(100 * outcome.overrideDeals / outcome.groups).toFixed(2)}% (deal-equal)`);
      report(`root-level coverage        ${(100 * outcome.coverage).toFixed(2)}%`);
      report(`raw selected overrides     good ${outcome.goodOverrides}  neutral ${outcome.overrides - outcome.goodOverrides - outcome.badOverrides}  bad ${outcome.badOverrides}`);
      report(`(good - bad) / overrides   ${outcome.conditional.toFixed(4)}`);

      // Subgroups are reported only after the primary, and cannot move it.
      const subgroups = new Map<string, { n: number; overrides: number; good: number; bad: number }>();
      const bump = (key: string, z: number, overrode: boolean) => {
        const entry = subgroups.get(key) ?? { n: 0, overrides: 0, good: 0, bad: 0 };
        entry.n += 1;
        if (overrode) {
          entry.overrides += 1;
          if (z > 0) entry.good += 1;
          else if (z < 0) entry.bad += 1;
        }
        subgroups.set(key, entry);
      };
      const seatIndexOf = (seat: string) => ["human", "ai-one", "ai-two"].indexOf(seat);
      for (let index = 0; index < roots.length; index += 1) {
        const root = roots[index];
        const choice = choices[index];
        if (root === undefined || choice === undefined) continue;
        const attrs = attrsOfSnapshot.get(root.snapshotId);
        if (attrs === undefined) continue;
        const relative = (seatIndexOf(attrs.seat) - seatIndexOf(attrs.landlord) + 3) % 3;
        bump(`farmer position +${relative}`, choice.z, choice.overrode);
        const stage = attrs.minRemaining <= 2 ? "min<=2" : attrs.minRemaining <= 4 ? "min 3-4"
          : attrs.minRemaining <= 9 ? "min 5-9" : "min>=10";
        bump(`stage ${stage}`, choice.z, choice.overrode);
        if (choice.overrode) {
          const gaps = gapsOfSnapshot.get(root.snapshotId);
          let selectedOrder: number | null = null;
          for (const candidate of root.candidates) {
            if (candidate.score === choice.winningScore) { selectedOrder = candidate.candidateOrder; break; }
          }
          const gap = selectedOrder === null ? 0 : (gaps?.get(selectedOrder) ?? 0);
          const bucket = gap <= 0 ? "gap<=0" : gap < 500 ? "gap 0-500" : gap < 1500 ? "gap 500-1500" : "gap>=1500";
          bump(`expertGap ${bucket}`, choice.z, choice.overrode);
        }
      }
      report(`\n-- PRE-REGISTERED SUBGROUP DIAGNOSTICS (descriptive; cannot change the primary) --`);
      report(`subgroup                    snapshots  overrides   good  neutral     bad  (good-bad)/ovr`);
      for (const key of [...subgroups.keys()].sort()) {
        const entry = subgroups.get(key);
        if (entry === undefined) continue;
        const cond = entry.overrides === 0 ? 0 : (entry.good - entry.bad) / entry.overrides;
        const neutral = entry.overrides - entry.good - entry.bad;
        report(
          `${key.padEnd(26)}  ${String(entry.n).padStart(9)}  ${String(entry.overrides).padStart(9)}  ` +
          `${String(entry.good).padStart(6)}  ${String(neutral).padStart(7)}  ${String(entry.bad).padStart(6)}  ${cond.toFixed(4).padStart(8)}`,
        );
      }

      writeFileSync(join(HELDOUT_DIR, "heldout.verdict.json"), `${JSON.stringify({
        threshold,
        schemaHash: thresholdFile.schemaHash,
        integrityValid,
        primary: {
          groups: outcome.groups,
          mean: verdict.mean,
          se: outcome.se,
          lower: verdict.lower,
          upper: verdict.upper,
          overrideDeals: verdict.overrideDeals,
          selectedNonzeroDeals: verdict.selectedNonzeroDeals,
          status: verdict.status,
          reasons: verdict.reasons,
        },
        diagnostics: {
          snapshots: roots.length,
          overrides: outcome.overrides,
          overrideDeals: outcome.overrideDeals,
          dealEqualCoverage: outcome.overrideDeals / outcome.groups,
          rootCoverage: outcome.coverage,
          good: outcome.goodOverrides,
          neutral: outcome.overrides - outcome.goodOverrides - outcome.badOverrides,
          bad: outcome.badOverrides,
          conditional: outcome.conditional,
        },
        subgroups: Object.fromEntries([...subgroups.entries()]),
      }, null, 2)}\n`, "utf8");
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
