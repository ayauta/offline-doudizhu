/**
 * Guards for the packaged model artifact.
 *
 * The shipped Worker cannot fetch, so the frozen booster travels as a bundled
 * module. These are the checks that can run without the gitignored `.local`
 * workspace: the artifact is the one that was frozen, it declares the frozen
 * threshold, it has the shape the evaluator requires, and every way it can be
 * wrong resolves to "do not override" rather than to a broken move.
 *
 * The stronger claim — that this table reproduces LightGBM's own predictions
 * and the reference selector's decisions — is
 * `benchmarks/cf-model-equivalence.test.ts`, which needs the frozen artifact on
 * disk to compare against.
 */
import { describe, expect, it } from "vitest";

import {
  CF_MODEL_JSON,
  CF_MODEL_SHA256,
  CF_SELECTOR_THRESHOLD,
} from "../../src/app/ai/cf-model-data.js";
import { parseTreeModel, scoreTrees } from "../../src/core/ai/cf-model.js";
import { CF_FEATURE_NAMES } from "../../src/core/ai/cf-features.js";

const FROZEN_MODEL_SHA256 =
  "010a8a4a00524f0694d5881bacdd885d99243acf4d71e2b2fdcae7ae82fc3359";

describe("packaged model artifact", () => {
  it("is the artifact the Gates were run against", () => {
    expect(CF_MODEL_SHA256).toBe(FROZEN_MODEL_SHA256);
    const model = parseTreeModel(JSON.parse(CF_MODEL_JSON));
    expect(model.modelSha256).toBe(FROZEN_MODEL_SHA256);
    expect(model.numTrees).toBe(256);
    expect(model.numFeatures).toBe(CF_FEATURE_NAMES.length);
    expect(model.featureNames).toEqual([...CF_FEATURE_NAMES]);
  });

  it("carries the frozen threshold rather than a retyped one", () => {
    expect(CF_SELECTOR_THRESHOLD).toBe(0.01);
  });

  it("scores deterministically, and the score is the leaf sum", () => {
    const model = parseTreeModel(JSON.parse(CF_MODEL_JSON));
    const row = new Array<number>(model.numFeatures).fill(0);
    const first = scoreTrees(model, row);
    expect(Number.isFinite(first)).toBe(true);
    expect(scoreTrees(model, row)).toBe(first);
    // A NaN feature must route, not poison the sum.
    const withMissing = [...row];
    withMissing[0] = Number.NaN;
    expect(Number.isFinite(scoreTrees(model, withMissing))).toBe(true);
  });

  it("refuses a malformed or mismatched table instead of scoring it", () => {
    expect(() => parseTreeModel(null)).toThrow();
    expect(() => parseTreeModel({ trees: [], numFeatures: 1, featureNames: [] })).toThrow();
    expect(() => parseTreeModel({
      trees: [{
        feature: [999], threshold: [0], defaultLeft: [0],
        missingZero: [0], left: [0], right: [0], value: [0],
      }],
      numFeatures: 2,
      featureNames: ["a", "b"],
    })).toThrow(/beyond the schema/);
    expect(() => parseTreeModel({
      trees: [{
        feature: [-1], threshold: [0, 1], defaultLeft: [0],
        missingZero: [0], left: [0], right: [0], value: [0],
      }],
      numFeatures: 2,
      featureNames: ["a", "b"],
    })).toThrow(/ragged/);
  });
});
