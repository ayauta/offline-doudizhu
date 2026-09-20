/**
 * Runtime/reference equivalence for the frozen Gate A model.
 *
 * The product runtime has no LightGBM, so the booster is transcribed into a
 * tree table and walked in TypeScript. That transcription is only trustworthy
 * if it reproduces *LightGBM's own predictions* — not a re-reading of them. This
 * check runs the TypeScript evaluator against the scores the frozen Python
 * model actually produced on the calibration rows.
 *
 * The bar the spec sets is behavioural, not textual: zero divergence in the
 * selector's decisions. Numeric agreement is reported and bounded, and the
 * samples closest to the threshold are called out separately, because those are
 * the only rows where a last-bit difference could change an override.
 *
 *   AI_CF_EQUIVALENCE=1 npx vitest run --config vitest.benchmark.config.ts \
 *     benchmarks/cf-model-equivalence.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { report } from "./ai-tournament.js";
import { assertRowMatchesSchema, parseTreeModel, scoreTrees } from "./cf-model.js";
import {
  CF_MODEL_JSON,
  CF_MODEL_SHA256,
  CF_SELECTOR_THRESHOLD,
} from "../src/app/ai/cf-model-data.js";
import { CF_THRESHOLD_GRID, cfChooseOverride, type CfScoredRoot } from "./cf-selector.js";

const ENABLED = process.env.AI_CF_EQUIVALENCE === "1";
const MODEL_PATH = process.env.AI_CF_MODEL ?? ".local/cf-rows/model.json";
const ROWS_DIR = process.env.AI_CF_ROWS_DIR ?? ".local/cf-rows";
const THRESHOLD = Number(process.env.AI_CF_THRESHOLD ?? "0.01");

type RowFile = Readonly<{
  rows: readonly Readonly<{
    id: string;
    groupId: string;
    snapshotId: string;
    y: -1 | 0 | 1;
    candidateOrder: number;
    x: readonly number[];
  }>[];
}>;

describe.runIf(ENABLED)("frozen model: runtime equivalence", () => {
  it("reproduces the LightGBM reference and every selector decision it drives", () => {
    const model = parseTreeModel(JSON.parse(readFileSync(MODEL_PATH, "utf8")));
    const rows = (JSON.parse(
      readFileSync(join(ROWS_DIR, "calibration.rows.json"), "utf8"),
    ) as RowFile).rows;
    const reference = (JSON.parse(
      readFileSync(join(ROWS_DIR, "calibration.scores.json"), "utf8"),
    ) as { scores: Record<string, number>; modelSha256: string }).scores;

    expect(model.modelSha256).toBe(
      (JSON.parse(readFileSync(join(ROWS_DIR, "train-config.json"), "utf8")) as {
        modelSha256: string;
      }).modelSha256,
    );
    report(`\nmodel ${model.modelSha256.slice(0, 16)}  trees ${model.numTrees}  features ${model.numFeatures}`);
    report(`rows ${rows.length}  threshold ${THRESHOLD}  packaged threshold ${CF_SELECTOR_THRESHOLD}`);
    expect(CF_SELECTOR_THRESHOLD).toBe(THRESHOLD);

    let maxDelta = 0;
    let worst = "";
    let nonFinite = 0;
    const mine = new Map<string, number>();
    for (const row of rows) {
      assertRowMatchesSchema(model, row.x);
      const value = scoreTrees(model, row.x);
      if (!Number.isFinite(value)) {
        nonFinite += 1;
      }
      mine.set(row.id, value);
      const expected = reference[row.id];
      if (expected === undefined) {
        throw new Error(`No reference score for row ${row.id}.`);
      }
      const delta = Math.abs(value - expected);
      if (delta > maxDelta) {
        maxDelta = delta;
        worst = row.id;
      }
    }
    report(`max |runtime - reference| = ${maxDelta.toExponential(3)}  (worst row ${worst})`);
    report(`non-finite runtime scores ${nonFinite}`);

    // Behaviour is what must not differ; the numeric bound is a sanity rail.
    expect(nonFinite).toBe(0);
    expect(maxDelta).toBeLessThan(1e-9);

    // The packaged artifact — the module the shipped Worker loads — must be the
    // same table. A packaging step that changed a threshold or dropped a tree
    // would leave every check above green while the product ran something else.
    expect(CF_MODEL_SHA256).toBe(model.modelSha256);
    const packaged = parseTreeModel(JSON.parse(CF_MODEL_JSON));
    expect(packaged.modelSha256).toBe(model.modelSha256);
    expect(packaged.numTrees).toBe(model.numTrees);
    expect(packaged.featureNames).toEqual(model.featureNames);
    let packagedDelta = 0;
    for (const row of rows) {
      packagedDelta = Math.max(packagedDelta, Math.abs(scoreTrees(packaged, row.x) - scoreTrees(model, row.x)));
    }
    report(`packaged vs source table: max |delta| = ${packagedDelta.toExponential(3)}`);
    expect(packagedDelta).toBe(0);

    // Rebuild each root and compare the selector's actual decisions.
    const groupOf = new Map<string, { snapshotId: string; order: number; y: -1 | 0 | 1 }[]>();
    for (const row of rows) {
      const list = groupOf.get(row.snapshotId) ?? [];
      list.push({ snapshotId: row.snapshotId, order: row.candidateOrder, y: row.y });
      groupOf.set(row.snapshotId, list);
    }
    const rootsFrom = (
      pick: (id: string) => number,
    ): CfScoredRoot[] => [...groupOf.entries()].map(([snapshotId, entries]) => {
      const sorted = [...entries].sort((left, right) => left.order - right.order);
      const groupId = rows.find((row) => row.snapshotId === snapshotId)?.groupId ?? "";
      return Object.freeze({
        snapshotId,
        groupId,
        candidates: Object.freeze(sorted.map((entry) => Object.freeze({
          candidateOrder: entry.order,
          score: pick(`${snapshotId}#${entry.order}`),
          label: entry.y,
        }))),
      });
    });

    const mineRoots = rootsFrom((id) => mine.get(id) ?? Number.NaN);
    const refRoots = rootsFrom((id) => reference[id] ?? Number.NaN);
    expect(mineRoots.length).toBe(refRoots.length);

    let argmaxDivergence = 0;
    let thresholdDivergence = 0;
    let zDivergence = 0;
    let nearThreshold = 0;
    for (let index = 0; index < mineRoots.length; index += 1) {
      const a = mineRoots[index];
      const b = refRoots[index];
      if (a === undefined || b === undefined) {
        throw new Error("root list mismatch");
      }
      for (const threshold of CF_THRESHOLD_GRID) {
        const mineChoice = cfChooseOverride(a, threshold);
        const refChoice = cfChooseOverride(b, threshold);
        if (mineChoice.overrode !== refChoice.overrode) {
          thresholdDivergence += 1;
        }
        if (mineChoice.z !== refChoice.z) {
          zDivergence += 1;
        }
      }
      const mineAt = cfChooseOverride(a, THRESHOLD);
      const refAt = cfChooseOverride(b, THRESHOLD);
      const mineOrder = a.candidates.find((c) => c.score === mineAt.winningScore)?.candidateOrder;
      const refOrder = b.candidates.find((c) => c.score === refAt.winningScore)?.candidateOrder;
      if (mineOrder !== refOrder) {
        argmaxDivergence += 1;
      }
      const margin = Math.abs((mineAt.winningScore ?? 0) - THRESHOLD);
      if (margin < 1e-6) {
        nearThreshold += 1;
      }
    }

    report(`roots ${mineRoots.length}`);
    report(`argmax divergence          ${argmaxDivergence}`);
    report(`override-decision divergence ${thresholdDivergence}`);
    report(`selected-label divergence  ${zDivergence}`);
    report(`roots whose winning score is within 1e-6 of the threshold: ${nearThreshold}`);

    // The spec's bar: any actual selector behaviour that differs is a failure.
    expect(argmaxDivergence).toBe(0);
    expect(thresholdDivergence).toBe(0);
    expect(zDivergence).toBe(0);
  });
});
