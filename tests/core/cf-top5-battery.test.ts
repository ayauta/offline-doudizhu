/**
 * Guards for Spec 065's top5 battery (`benchmarks/cf-top5-battery.ts`).
 *
 * That file is a deliberate copy of the frozen `cf-pi-corpus.ts` battery, made
 * so the validator which produced Spec 064's recorded result stays
 * byte-identical. A copy is only worth having if it is proven, so this suite
 * does for it what `cf-pi-corpus-guards.test.ts` does for the original: runs
 * the whole battery over a real capture from a **retired** deal, then breaks
 * one rule at a time and asserts each break is rejected.
 *
 * Retired seeds only (`50_011`). Spec 065's pool is not touched here.
 */
import { describe, expect, it } from "vitest";

import { armSchedule, dealDeck, dealGameSeed, scheduleFor } from "../../benchmarks/ai-tournament.js";
import { CF_GROUP_SNAPSHOT_CAP, type CfGroupResult } from "../../benchmarks/cf-dataset.js";
import { cfSplitOf } from "../../benchmarks/cf-corpus.js";
import { cfPiFrozenBaseline } from "../../benchmarks/cf-pi-corpus.js";
import { CF_TOP5_DATASET_VERSION, CF_TOP5_LIMIT, cfTop5CaptureGroup } from "../../benchmarks/cf-top5.js";
import {
  CF_TOP5_BATTERY_EXPECTATION,
  cfTop5AssertGroup,
  type CfTop5GroupExpectation,
} from "../../benchmarks/cf-top5-battery.js";

const DEAL = 50_011;

/** The retired window this file validates against. */
const RETIRED: CfTop5GroupExpectation = Object.freeze({
  universeStart: 50_001,
  universeEnd: 70_000,
  splitOf: cfSplitOf,
  poolOf: () => "dataset",
  expectedPool: "dataset",
});

function retiredSpec() {
  const variants = armSchedule(DEAL)
    .filter((slot) => slot.arm === "B" && slot.strongSeat !== slot.landlord)
    .map((slot) => Object.freeze({
      variantId: `${DEAL}:${slot.landlord}:${slot.strongSeat}`,
      landlord: slot.landlord,
      studiedSeat: slot.strongSeat,
      gameSeed: dealGameSeed(DEAL, slot.strongSeat, slot.landlord),
      tiers: scheduleFor("master", "default", slot.strongSeat),
    }));
  return Object.freeze({
    groupId: `deal-${DEAL}`,
    dealIndex: DEAL,
    dealSeed: DEAL,
    variants: Object.freeze(variants),
    snapshotCap: CF_GROUP_SNAPSHOT_CAP,
    policyCommit: "guard",
  });
}

let cache: CfGroupResult | null = null;

function captured(): CfGroupResult {
  if (cache === null) {
    cache = cfTop5CaptureGroup(dealDeck(DEAL), retiredSpec(), cfPiFrozenBaseline());
  }
  return cache;
}

function copy(): CfGroupResult {
  return JSON.parse(JSON.stringify(captured())) as CfGroupResult;
}

function accepts(group: CfGroupResult): boolean {
  try {
    cfTop5AssertGroup(group, cfSplitOf(DEAL) ?? "train", {}, RETIRED);
    return true;
  } catch {
    return false;
  }
}

const first = (group: CfGroupResult) => {
  const snapshot = group.snapshots[0];
  if (snapshot === undefined) {
    throw new Error("Guard setup captured no snapshot.");
  }
  return snapshot;
};

describe("spec065 battery: accepts a real top5 capture", () => {
  it("accepts the retired deal's capture, at the widened width", () => {
    const group = captured();
    expect(group.snapshots.length).toBeGreaterThan(0);
    expect(accepts(group)).toBe(true);
    // The capture really is five-wide on at least one root, otherwise this
    // suite would be proving the top3 contract under a new name.
    expect(group.snapshots.some((s) => s.candidates.length > 3)).toBe(true);
    expect(group.snapshots.every((s) => s.candidates.length <= CF_TOP5_LIMIT)).toBe(true);
  });

  it("is configured for the round's own universe by default", () => {
    expect(CF_TOP5_BATTERY_EXPECTATION.universeStart).toBe(140_001);
    expect(CF_TOP5_BATTERY_EXPECTATION.universeEnd).toBe(160_000);
    expect(CF_TOP5_BATTERY_EXPECTATION.expectedPool).toBe("dataset");
    expect(CF_TOP5_DATASET_VERSION).toBe(4);
  });
});

describe("spec065 battery: every gate rejects its own violation", () => {
  it("rejects a foreign dataset version (§7.18)", () => {
    const group = copy();
    (first(group).meta as { datasetVersion: number }).datasetVersion = CF_TOP5_DATASET_VERSION + 1;
    expect(accepts(group)).toBe(false);
  });

  it("rejects a shortlist widened past five (§7.3)", () => {
    const group = copy();
    const snapshot = first(group);
    const candidates = snapshot.candidates as unknown as Array<{ actionIndex: number }>;
    candidates.push({ ...(candidates[0] as { actionIndex: number }) });
    candidates.push({ ...(candidates[1] as { actionIndex: number }) });
    expect(candidates.length).toBeGreaterThan(CF_TOP5_LIMIT);
    expect(accepts(group)).toBe(false);
  });

  it("rejects a shortlist truncated by one candidate (§7.3)", () => {
    // The case the element-wise loop cannot see: `cfTop5ProposalMatches` walks
    // only as far as the stored array goes, so its length equality is what
    // catches a truncation. Inherited from the identical hole found in the
    // Spec 064 battery.
    const group = copy();
    const wide = group.snapshots.find((snapshot) => snapshot.candidates.length >= 3);
    if (wide === undefined) {
      throw new Error("Guard setup captured no shortlist of three or more.");
    }
    (wide.candidates as unknown[]).pop();
    expect(accepts(group)).toBe(false);
  });

  it("rejects a candidate set that is not the frozen shortlist order (§7.3)", () => {
    const group = copy();
    const snapshot = first(group);
    const candidates = snapshot.candidates as unknown as Array<{ actionIndex: number }>;
    const head = candidates[0];
    const tail = candidates[candidates.length - 1];
    if (head === undefined || tail === undefined) {
      throw new Error("Guard setup captured no candidates.");
    }
    const swap = head.actionIndex;
    head.actionIndex = tail.actionIndex;
    tail.actionIndex = swap;
    expect(accepts(group)).toBe(false);
  });

  it("rejects a reference whose own label is not zero (§7.2)", () => {
    const group = copy();
    const snapshot = first(group);
    (snapshot.labels as number[])[snapshot.productionIndex] = 1;
    expect(accepts(group)).toBe(false);
  });

  it("rejects a reference branch whose winner is not its variant's (§7.7)", () => {
    const group = copy();
    const snapshot = first(group);
    (snapshot.winners as string[])[snapshot.productionIndex] = "nobody";
    expect(accepts(group)).toBe(false);
  });

  it("rejects a missing raw production index (§7.1)", () => {
    const group = copy();
    delete (first(group).meta as { rawProductionIndex?: number }).rawProductionIndex;
    expect(accepts(group)).toBe(false);
  });

  it("rejects a raw production index outside the candidate set (§7.1)", () => {
    const group = copy();
    (first(group).meta as { rawProductionIndex: number }).rawProductionIndex =
      first(group).candidates.length;
    expect(accepts(group)).toBe(false);
  });

  it("rejects a reference branch that did not consume exactly one decision (§7.6)", () => {
    const group = copy();
    const meta = first(group).meta as {
      seat: string;
      seatDecisionIndex: number;
      continuationCounters: Record<string, number>;
    };
    meta.continuationCounters[meta.seat] = meta.seatDecisionIndex;
    expect(accepts(group)).toBe(false);
  });

  it("rejects a candidate that is not a legal action (§7.14)", () => {
    const group = copy();
    (first(group).actions as unknown[]).pop();
    expect(accepts(group)).toBe(false);
  });

  it("rejects a split that does not match the deal's own assignment (§7.16)", () => {
    const other = cfSplitOf(DEAL) === "train" ? "calibration" : "train";
    expect(() => cfTop5AssertGroup(copy(), other, {}, RETIRED)).toThrow(/§7.16/);
  });

  it("rejects a group outside the corpus universe (§7.16)", () => {
    const group = copy();
    (group as { dealIndex: number }).dealIndex = 139_999;
    expect(accepts(group)).toBe(false);
  });
});
