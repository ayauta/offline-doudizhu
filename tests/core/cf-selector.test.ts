/**
 * Selector and evaluation guards for Gate A v1 (spec 062 §17–§24).
 *
 * The selector is the thing that will be frozen at calibration time and then run
 * once against the sealed held-out split, so its semantics are pinned here on
 * synthetic data — cheap, deterministic, and independent of any corpus.
 *
 * The statistics are checked against values that can be derived by hand, and
 * the t-quantile is checked against a published critical value rather than
 * against itself.
 */
import { describe, expect, it } from "vitest";

import {
  CF_CALIBRATION_ALPHA,
  CF_HELDOUT_TAIL,
  CF_MIN_OVERRIDE_DEALS,
  CF_MIN_SELECTED_NONZERO_DEALS,
  CF_MU_MIN,
  CF_NEVER_OVERRIDE,
  CF_THRESHOLD_GRID,
  cfChooseOverride,
  cfHeldoutVerdict,
  cfSelectThreshold,
  cfThresholdOutcome,
  type CfScoredRoot,
} from "../../benchmarks/cf-selector.js";

/** A t-quantile good enough to derive expectations from, without scipy. */
function normalQuantile(probability: number): number {
  // Acklam's inverse normal CDF; enough to check the shape of the interval.
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416];
  const p = probability;
  if (p < 0.02425) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - 0.02425) {
    return -normalQuantile(1 - p);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

const root = (
  snapshotId: string,
  groupId: string,
  candidates: readonly Readonly<{ score: number; label: -1 | 0 | 1 }>[],
): CfScoredRoot => Object.freeze({
  snapshotId,
  groupId,
  candidates: Object.freeze(candidates.map((candidate, order) => Object.freeze({
    candidateOrder: order,
    score: candidate.score,
    label: candidate.label,
  }))),
});

describe("cf selector: override semantics", () => {
  it("requires the score to be strictly above the threshold", () => {
    const subject = root("s", "g", [{ score: 0.02, label: 1 }]);
    expect(cfChooseOverride(subject, 0.01).overrode).toBe(true);
    // Exactly at the threshold is *not* an override.
    expect(cfChooseOverride(subject, 0.02).overrode).toBe(false);
    expect(cfChooseOverride(subject, 0.03).overrode).toBe(false);
    expect(cfChooseOverride(subject, CF_NEVER_OVERRIDE).overrode).toBe(false);
  });

  it("returns the production action's own zero when it does not override", () => {
    const subject = root("s", "g", [{ score: 0.01, label: -1 }]);
    expect(cfChooseOverride(subject, 0.5)).toMatchObject({ overrode: false, z: 0 });
    expect(cfChooseOverride(subject, 0).overrode).toBe(true);
    expect(cfChooseOverride(subject, 0).z).toBe(-1);
  });

  it("breaks ties by the frozen production candidate order", () => {
    const tied = root("s", "g", [
      { score: 0.5, label: -1 },
      { score: 0.5, label: 1 },
    ]);
    expect(cfChooseOverride(tied, 0)).toMatchObject({ z: -1 });
  });

  it("counts one outcome per root, never one per threshold-crossing candidate", () => {
    const many = root("s", "g", [
      { score: 0.9, label: 1 },
      { score: 0.8, label: 1 },
      { score: 0.7, label: 1 },
    ]);
    const outcome = cfThresholdOutcome(
      [cfChooseOverride(many, 0)],
      ["g"],
      new Map([["g", 1]]),
      0,
      normalQuantile,
    );
    expect(outcome.overrides).toBe(1);
  });
});

describe("cf selector: group-level primary", () => {
  it("keeps every registered group in the denominator, empty ones included", () => {
    const choices = [cfChooseOverride(root("s", "g1", [{ score: 1, label: 1 }]), 0)];
    const outcome = cfThresholdOutcome(
      choices,
      ["g1", "g2", "g3", "g4"],
      new Map([["g1", 1]]),
      0,
      normalQuantile,
    );
    expect(outcome.groups).toBe(4);
    expect(outcome.perGroup).toEqual([1, 0, 0, 0]);
    expect(outcome.mean).toBeCloseTo(0.25, 12);
  });

  it("averages a group's roots before averaging groups, so a busy group cannot dominate", () => {
    const choices = [
      cfChooseOverride(root("a1", "gA", [{ score: 1, label: 1 }]), 0),
      cfChooseOverride(root("a2", "gA", [{ score: 1, label: 1 }]), 0),
      cfChooseOverride(root("a3", "gA", [{ score: 1, label: 1 }]), 0),
      cfChooseOverride(root("b1", "gB", [{ score: 1, label: -1 }]), 0),
    ];
    const outcome = cfThresholdOutcome(choices, ["gA", "gB"], new Map([["gA", 3], ["gB", 1]]), 0, normalQuantile);
    expect(outcome.perGroup).toEqual([1, -1]);
    expect(outcome.mean).toBeCloseTo(0, 12);
    // Not 3/4, which is what a row-level mean would have produced.
  });

  it("separates override deals from deals whose override actually carried a label", () => {
    const choices = [
      cfChooseOverride(root("a", "g1", [{ score: 1, label: 0 }]), 0),
      cfChooseOverride(root("b", "g2", [{ score: 1, label: 1 }]), 0),
      cfChooseOverride(root("c", "g3", [{ score: 1, label: -1 }]), 0),
      cfChooseOverride(root("d", "g4", [{ score: -1, label: 1 }]), 0),
    ];
    const outcome = cfThresholdOutcome(
      choices,
      ["g1", "g2", "g3", "g4"],
      new Map([["g1", 1], ["g2", 1], ["g3", 1], ["g4", 1]]),
      0,
      normalQuantile,
    );
    expect(outcome.overrideDeals).toBe(3);
    expect(outcome.selectedNonzeroDeals).toBe(2);
    expect(outcome.goodOverrides).toBe(1);
    expect(outcome.badOverrides).toBe(1);
    expect(outcome.conditional).toBeCloseTo(0, 12);
    expect(outcome.coverage).toBeCloseTo(0.75, 12);
  });

  it("derives the conservative bound from the sample sd, not the outcome range", () => {
    const choices = [
      cfChooseOverride(root("a", "g1", [{ score: 1, label: 1 }]), 0),
      cfChooseOverride(root("b", "g2", [{ score: 1, label: 1 }]), 0),
      cfChooseOverride(root("c", "g3", [{ score: 1, label: 1 }]), 0),
      cfChooseOverride(root("d", "g4", [{ score: 1, label: -1 }]), 0),
    ];
    const outcome = cfThresholdOutcome(
      choices,
      ["g1", "g2", "g3", "g4"],
      new Map(),
      0,
      normalQuantile,
    );
    const values = outcome.perGroup;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const sd = Math.sqrt(
      values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1),
    );
    expect(outcome.mean).toBeCloseTo(mean, 12);
    expect(outcome.sd).toBeCloseTo(sd, 12);
    expect(outcome.se).toBeCloseTo(sd / 2, 12);
    expect(outcome.lower).toBeLessThan(outcome.mean);
  });
});

describe("cf selector: threshold choice", () => {
  const outcome = (
    threshold: number,
    lower: number,
    overrideDeals: number,
    selectedNonzeroDeals: number,
  ) => Object.freeze({
    threshold,
    perGroup: Object.freeze([]),
    groups: 4000,
    overrideDeals,
    selectedNonzeroDeals,
    coverage: 0,
    overrides: 0,
    goodOverrides: 0,
    badOverrides: 0,
    conditional: 0,
    mean: lower + 1,
    sd: 1,
    se: 0,
    lower,
  });

  it("picks the largest conservative lower bound among supported thresholds", () => {
    const decision = cfSelectThreshold([
      outcome(0, -0.001, 900, 300),
      outcome(0.01, 0.004, 600, 210),
      outcome(0.02, 0.006, 400, 150),
      outcome(0.04, 0.002, 220, 80),
      outcome(0.08, -0.01, 90, 30),
      outcome(0.16, -0.02, 10, 4),
    ]);
    expect(decision.reason).toBe("selected");
    expect(decision.selected).toBe(0.02);
    expect(decision.eligible).toEqual([0, 0.01, 0.02, 0.04]);
  });

  it("prefers the larger threshold on an exact tie", () => {
    const decision = cfSelectThreshold([
      outcome(0.01, 0.003, 500, 200),
      outcome(0.04, 0.003, 300, 120),
    ]);
    expect(decision.selected).toBe(0.04);
  });

  it("declares NO-GO when no supported threshold has a positive lower bound", () => {
    const decision = cfSelectThreshold([
      outcome(0, -0.004, 900, 300),
      outcome(0.02, -0.002, 400, 150),
    ]);
    expect(decision.reason).toBe("calibration-no-go");
    expect(decision.selected).toBe(CF_NEVER_OVERRIDE);
  });

  it("declares NO-GO when no threshold clears the support floors, however good it looks", () => {
    const decision = cfSelectThreshold([
      outcome(0, 0.5, CF_MIN_OVERRIDE_DEALS - 1, 5),
      outcome(0.02, 0.9, 900, CF_MIN_SELECTED_NONZERO_DEALS - 1),
    ]);
    expect(decision.reason).toBe("calibration-no-go");
    expect(decision.eligible).toEqual([]);
  });

  it("offers exactly the six frozen finite thresholds", () => {
    expect(CF_THRESHOLD_GRID).toEqual([0, 0.01, 0.02, 0.04, 0.08, 0.16]);
    expect(CF_CALIBRATION_ALPHA / CF_THRESHOLD_GRID.length).toBeCloseTo(0.05 / 6, 12);
  });
});

describe("cf selector: held-out rule", () => {
  it("is a two-sided 97.5% interval, looser than a 95% one would be", () => {
    const values = Array.from({ length: 400 }, (_, index) => (index % 5 === 0 ? 1 : 0));
    const verdict = cfHeldoutVerdict(values, 300, 80, true, normalQuantile);
    expect(verdict.upper - verdict.mean).toBeCloseTo(verdict.mean - verdict.lower, 12);
    const ninetyFive = normalQuantile(0.975);
    const ninetySeven = normalQuantile(CF_HELDOUT_TAIL);
    expect(ninetySeven).toBeGreaterThan(ninetyFive);
  });

  it("passes only when every clause holds at once", () => {
    const strong = Array.from({ length: 1000 }, (_, index) => (index % 10 === 0 ? 1 : 0));
    expect(cfHeldoutVerdict(strong, 300, 80, true, normalQuantile).status).toBe("pass");
    expect(cfHeldoutVerdict(strong, 300, 80, false, normalQuantile).status).toBe("inconclusive");
    expect(cfHeldoutVerdict(strong, 199, 80, true, normalQuantile).status).toBe("inconclusive");
    expect(cfHeldoutVerdict(strong, 300, 49, true, normalQuantile).status).toBe("inconclusive");
  });

  it("fails outright when the whole interval sits below the minimum effect", () => {
    const weak = new Array<number>(1000).fill(0);
    const verdict = cfHeldoutVerdict(weak, 500, 100, true, normalQuantile);
    expect(verdict.upper).toBeLessThan(CF_MU_MIN);
    expect(verdict.status).toBe("fail");
  });

  it("keeps the frozen minimum effect and tail where they were preregistered", () => {
    expect(CF_MU_MIN).toBe(0.005);
    expect(CF_HELDOUT_TAIL).toBe(0.9875);
  });
});
