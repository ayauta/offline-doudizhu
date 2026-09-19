/**
 * The t-quantile that the frozen Gate A intervals are built from.
 *
 * The reference values are scipy's (`scipy.stats.t.ppf`), captured once and
 * written down here: scipy is a convenience for *checking* this implementation,
 * never a dependency of it. A wrong quantile would silently move every interval
 * in the preregistered decision, so it is pinned against an outside authority
 * rather than against itself.
 */
import { describe, expect, it } from "vitest";

import { incompleteBeta, tCdf, tQuantile } from "../../benchmarks/cf-tquantile.js";

describe("Student-t quantile", () => {
  it("reproduces scipy's critical values", () => {
    const cases: readonly (readonly [number, number, number])[] = [
      [0.975, 1, 12.706_204_736_432_095],
      [0.975, 10, 2.228_138_851_964_938_5],
      [0.95, 20, 1.724_718_242_920_785_7],
      [0.995, 30, 2.749_995_653_567_030_5],
      [0.975, 100, 1.983_971_518_449_633_4],
      [0.999, 1000, 3.098_402_163_912_875_4],
    ];
    for (const [probability, df, expected] of cases) {
      expect(tQuantile(probability, df)).toBeCloseTo(expected, 9);
    }
  });

  it("reproduces the two quantiles Gate A v1 actually uses", () => {
    // Bonferroni over six thresholds, one-sided, on the calibration split.
    expect(tQuantile(1 - 0.05 / 6, 3999)).toBeCloseTo(2.394_987_593_768_938, 8);
    // Two-sided 97.5%, on the held-out split.
    expect(tQuantile(0.9875, 3999)).toBeCloseTo(2.242_247_116_874_774, 8);
  });

  it("inverts its own cdf and stays monotone", () => {
    for (const probability of [0.6, 0.8, 0.9, 0.95, 0.99]) {
      expect(tCdf(tQuantile(probability, 17), 17)).toBeCloseTo(probability, 10);
    }
    expect(tQuantile(0.95, 30)).toBeGreaterThan(tQuantile(0.90, 30));
    expect(tQuantile(0.95, 30)).toBeLessThan(tQuantile(0.95, 5));
  });

  it("is symmetric and centred", () => {
    expect(tQuantile(0.5, 12)).toBe(0);
    expect(tQuantile(0.1, 12)).toBeCloseTo(-tQuantile(0.9, 12), 9);
  });

  it("agrees with the incomplete beta at its edges", () => {
    expect(incompleteBeta(2, 3, 0)).toBe(0);
    expect(incompleteBeta(2, 3, 1)).toBe(1);
    // I_x(a,b) is monotone in x.
    let previous = -1;
    for (let x = 0.05; x <= 0.95; x += 0.05) {
      const value = incompleteBeta(2, 3, x);
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
  });

  it("refuses probabilities and degrees of freedom outside its domain", () => {
    expect(() => tQuantile(0, 10)).toThrow(RangeError);
    expect(() => tQuantile(1, 10)).toThrow(RangeError);
    expect(() => tQuantile(0.95, 0)).toThrow(RangeError);
  });
});
