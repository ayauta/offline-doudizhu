/**
 * Guards for the π1→π2 corpus driver's exhaustive §7 battery
 * (`benchmarks/cf-pi-corpus.ts`).
 *
 * The driver validates every row of a corpus that takes hours to generate and
 * is then trusted for the rest of the round. So the battery itself needs a
 * guard, and the guard has to run somewhere cheap: this file exercises the
 * whole thing over a **retired** deal (`50_011`, the Phase 2 v1 dataset, spent
 * and permanently retired), so proving the battery works costs the round
 * nothing. Not one fresh seed is dealt here.
 *
 * Each case breaks exactly one preregistered rule and asserts the battery
 * rejects it. A case that stayed green would mean that gate is decoration.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { dealDeck } from "../../benchmarks/ai-tournament.js";
import { armSchedule, dealGameSeed, scheduleFor } from "../../benchmarks/ai-tournament.js";
import { CF_GROUP_SNAPSHOT_CAP, type CfGroupResult } from "../../benchmarks/cf-dataset.js";
import { cfAuditStructure, cfSplitOf } from "../../benchmarks/cf-corpus.js";
import {
  CF_PI_DATASET_VERSION,
  CF_PI_GROUP_SNAPSHOT_CAP,
  CF_PI_MODEL_SHA256,
  CF_PI_THRESHOLD,
  cfPiSplitOf,
  cfPiCaptureGroup,
  type CfPiBaseline,
} from "../../benchmarks/cf-policy-iteration.js";
import {
  CF_PI_GROUP_EXPECTATION,
  cfPiAssertGroup,
  cfPiFrozenBaseline,
  type CfPiGroupExpectation,
} from "../../benchmarks/cf-pi-corpus.js";
import { CF_MODEL_JSON } from "../../src/app/ai/cf-model-data.js";
import { parseTreeModel } from "../../src/core/ai/cf-model.js";

// Capturing real roots plays whole games to terminal, so this suite cannot live
// inside vitest's 5 s default: a fixture costs seconds on an idle machine and
// tens of seconds when a 15-shard corpus generation is using every core. That
// was always true — it only became visible when the corpus ran alongside
// `pnpm check` and every capture-heavy test crossed the limit at once. Stated
// per file rather than inherited.
vi.setConfig({ testTimeout: 300_000 });


/**
 * The round's expectation, retargeted at a spent pool. Only the window and the
 * resolvers move; every structural rule is the same code the driver runs.
 */
const RETIRED: CfPiGroupExpectation = Object.freeze({
  universeStart: 50_001,
  universeEnd: 70_000,
  splitOf: cfSplitOf,
  poolOf: () => "dataset",
  expectedPool: "dataset",
});

const DEAL = 50_011;

function frozenBaseline(): CfPiBaseline {
  return Object.freeze({
    model: parseTreeModel(JSON.parse(CF_MODEL_JSON) as Parameters<typeof parseTreeModel>[0]),
    threshold: 0.01,
  });
}

/** The retired deal's arm-B farmer variants, shaped as `cfPiGroupSpecFor` builds them. */
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
    cache = cfPiCaptureGroup(dealDeck(DEAL), retiredSpec(), frozenBaseline());
  }
  return cache;
}

/** A mutable deep copy — every object in a capture is frozen. */
function copy(group: CfGroupResult = captured()): CfGroupResult {
  return JSON.parse(JSON.stringify(group)) as CfGroupResult;
}

function accepts(group: CfGroupResult): boolean {
  try {
    cfPiAssertGroup(group, cfSplitOf(DEAL) ?? "train", {}, RETIRED);
    return true;
  } catch {
    return false;
  }
}

describe("pi2 corpus: the exhaustive battery accepts a real π1 capture", () => {
  it("accepts the retired deal's own capture, so the mutations below mean something", () => {
    const group = captured();
    expect(group.snapshots.length).toBeGreaterThan(0);
    expect(accepts(group)).toBe(true);
    // Non-vacuity: π1 really overrode somewhere on this deal. A battery that
    // only ever saw declining roots would never exercise §7.1 at all.
    const overridden = group.snapshots.filter(
      (snapshot) => snapshot.meta.rawProductionIndex !== snapshot.productionIndex,
    );
    expect(overridden.length).toBeGreaterThan(0);
  });

  it("is configured for the round's own universe by default", () => {
    // The driver passes no expectation, so the default must be this round's.
    expect(CF_PI_GROUP_EXPECTATION.universeStart).toBe(100_001);
    expect(CF_PI_GROUP_EXPECTATION.universeEnd).toBe(120_000);
    expect(CF_PI_GROUP_EXPECTATION.expectedPool).toBe("dataset");
    expect(CF_PI_GROUP_SNAPSHOT_CAP).toBe(3);
    // …and the retired window this file uses is genuinely outside it, so the
    // battery proven here is not accidentally the same one the driver runs on
    // data this file just created.
    expect(accepts(captured())).toBe(true);
    expect(() => cfPiAssertGroup(captured(), cfSplitOf(DEAL) ?? "train", {})).toThrow(/§7.16/);
  });
});

describe("pi2 corpus: the structural audit uses the round's own split resolver", () => {
  /**
   * A group skeleton at a π2-universe index, with no snapshots.
   *
   * Deliberately synthetic: the point is which *resolver* the audit consults,
   * and that is decided by `dealIndex` alone. Building this from an object
   * literal costs no seed — no deck is dealt and no game is played — which
   * matters because the index has to be one the v1 resolver has never heard of
   * for the two resolvers to disagree at all.
   */
  const skeleton = (dealIndex: number): CfGroupResult => Object.freeze({
    groupId: `deal-${dealIndex}`,
    dealIndex,
    totalFarmerRoots: 0,
    usefulFarmerRoots: 0,
    sampledRoots: 0,
    sourceVariantCounts: Object.freeze({}),
    snapshots: Object.freeze([]),
    forkGames: 0,
    variantWinners: Object.freeze({}),
  });

  it("consults the resolver it is given, not the one v1 is bound to", () => {
    // Auditing the π2 corpus with v1's resolver reported 12,000/4,000/4,000
    // mismatches — every group — because `cfSplitOf` resolves over 50001..70000
    // and has never heard of a 100001+ index. The number read like a data
    // defect and was a property of the caller.
    //
    // Note the earlier version of this guard passed `cfSplitOf` explicitly
    // *and* used the retired deal 50_011 — where both resolvers agree, so the
    // parameter was never exercised and a mutation that ignored it survived.
    // The index below is one only the round's resolver can answer.
    const piSplit = cfPiSplitOf(100_011);
    expect(piSplit).toBeDefined();
    const split = piSplit ?? "train";

    expect(cfAuditStructure([skeleton(100_011)], split, cfPiSplitOf).splitMismatches).toBe(0);
    // The default is still v1's resolver, and on this index it disagrees —
    // which is precisely the false alarm, pinned so it cannot return unnoticed.
    expect(cfAuditStructure([skeleton(100_011)], split).splitMismatches).toBe(1);
    // The two resolvers are genuinely different functions over these universes.
    expect(cfSplitOf(100_011)).toBeUndefined();
    expect(cfSplitOf(DEAL)).toBeDefined();
    // Stage 1's pool is not training data and has no split anywhere.
    expect(cfPiSplitOf(120_001)).toBeUndefined();
  });
});

describe("pi2 corpus: the baseline artifact identity is checkable", () => {
  it("accepts the artifact the product ships", () => {
    const baseline = cfPiFrozenBaseline();
    expect(baseline.threshold).toBe(CF_PI_THRESHOLD);
    expect(CF_PI_MODEL_SHA256).toBe(
      "010a8a4a00524f0694d5881bacdd885d99243acf4d71e2b2fdcae7ae82fc3359");
    expect(Object.keys(baseline.model).length).toBeGreaterThan(0);
  });

  it("rejects an artifact claiming a different model", () => {
    const tampered = JSON.parse(CF_MODEL_JSON) as { modelSha256: string };
    tampered.modelSha256 = "0".repeat(64);
    expect(() => cfPiFrozenBaseline(JSON.stringify(tampered))).toThrow(/claims model/);
  });

  it("rejects an artifact whose tree table does not match its claimed depth", () => {
    const tampered = JSON.parse(CF_MODEL_JSON) as { trees: unknown[] };
    tampered.trees.pop();
    expect(() => cfPiFrozenBaseline(JSON.stringify(tampered))).toThrow(/trees/);
  });

  it("rejects an artifact whose feature order drifted from the frozen schema", () => {
    const tampered = JSON.parse(CF_MODEL_JSON) as { featureNames: string[] };
    const [head, second] = tampered.featureNames;
    if (head === undefined || second === undefined) {
      throw new Error("Guard setup lost the feature names.");
    }
    tampered.featureNames[0] = second;
    tampered.featureNames[1] = head;
    expect(() => cfPiFrozenBaseline(JSON.stringify(tampered))).toThrow(/feature order/);
  });

  it("rejects an artifact whose declared width is not the frozen schema's", () => {
    const tampered = JSON.parse(CF_MODEL_JSON) as { numFeatures: number };
    tampered.numFeatures = 85;
    expect(() => cfPiFrozenBaseline(JSON.stringify(tampered))).toThrow(/width|trees/);
  });
});

describe("pi2 corpus: every gate rejects its own violation", () => {
  const first = (group: CfGroupResult) => {
    const snapshot = group.snapshots[0];
    if (snapshot === undefined) {
      throw new Error("Guard setup captured no snapshot.");
    }
    return snapshot;
  };

  it("rejects a deal outside the corpus universe", () => {
    const group = copy();
    (group as { dealIndex: number }).dealIndex = 99_999;
    expect(accepts(group)).toBe(false);
  });

  it("rejects a group whose deal disagrees with its own groupId", () => {
    const group = copy();
    (group as { groupId: string }).groupId = "deal-50999";
    expect(accepts(group)).toBe(false);
  });

  it("rejects a variant id that does not carry the deal index", () => {
    const group = copy();
    const winners = group.variantWinners as Record<string, string>;
    const [firstKey] = Object.keys(winners);
    if (firstKey === undefined) {
      throw new Error("Guard setup captured no variants.");
    }
    winners["50099:human:ai-one"] = winners[firstKey] ?? "human";
    expect(accepts(group)).toBe(false);
  });

  it("rejects a variant that studies the landlord root", () => {
    const group = copy();
    const winners = group.variantWinners as Record<string, string>;
    const [firstKey] = Object.keys(winners);
    if (firstKey === undefined) {
      throw new Error("Guard setup captured no variants.");
    }
    winners[`${DEAL}:human:human`] = winners[firstKey] ?? "human";
    expect(accepts(group)).toBe(false);
  });

  it("rejects a snapshot that names an unrecorded variant", () => {
    const group = copy();
    (first(group).meta as { variantId: string }).variantId = "nobody";
    expect(accepts(group)).toBe(false);
  });

  it("rejects a foreign dataset version (§7.18)", () => {
    const group = copy();
    (first(group).meta as { datasetVersion: number }).datasetVersion = CF_PI_DATASET_VERSION + 1;
    expect(accepts(group)).toBe(false);
  });

  it("rejects a snapshot taken at the landlord seat (§7.9)", () => {
    const group = copy();
    (first(group).meta as { seat: string }).seat = first(group).meta.landlord;
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

  it("rejects a shortlist truncated to one fewer candidate (§7.3)", () => {
    // The case the element-wise loop cannot see. `cfPiProposalMatches` walks
    // only as far as the stored array goes, so removing its length equality
    // lets a 3→2 truncation through: measured at rejected 3/3 with the line and
    // rejected 0/3 without it. This case is what makes that line load-bearing.
    const group = copy();
    const threeWide = group.snapshots.find((snapshot) => snapshot.candidates.length === 3);
    if (threeWide === undefined) {
      throw new Error("Guard setup captured no three-wide shortlist.");
    }
    (threeWide.candidates as unknown[]).pop();
    expect(threeWide.candidates.length).toBe(2);
    expect(accepts(group)).toBe(false);
  });

  it("rejects a repeated candidate (§7.3)", () => {
    const group = copy();
    const snapshot = first(group);
    const candidates = snapshot.candidates as unknown as Array<{ actionIndex: number }>;
    const head = candidates[0];
    const second = candidates[1];
    if (head === undefined || second === undefined) {
      throw new Error("Guard setup captured no candidates.");
    }
    second.actionIndex = head.actionIndex;
    expect(accepts(group)).toBe(false);
  });

  it("rejects a candidate that is not a legal action (§7.14)", () => {
    const group = copy();
    const snapshot = first(group);
    // Truncating the legal action set makes the stored candidates illegal
    // against the engine's own generator, which is what §7.14 pins.
    (snapshot.actions as unknown[]).pop();
    expect(accepts(group)).toBe(false);
  });

  it("rejects a candidate count below the two-action minimum (§7.3)", () => {
    const group = copy();
    const snapshot = first(group);
    (snapshot.candidates as unknown[]).length = 1;
    expect(accepts(group)).toBe(false);
  });

  it("rejects a label outside {-1, 0, +1} (§7.18)", () => {
    const group = copy();
    const snapshot = first(group);
    const index = snapshot.productionIndex === 0 ? 1 : 0;
    (snapshot.labels as number[])[index] = 7;
    expect(accepts(group)).toBe(false);
  });

  it("rejects a split that does not match the deal's own assignment (§7.16)", () => {
    const group = copy();
    const other = cfSplitOf(DEAL) === "train" ? "calibration" : "train";
    expect(() => cfPiAssertGroup(group, other, {}, RETIRED)).toThrow(/§7.16/);
  });
});

describe("pi2 protocol: a no-peek stage runner must not stream intermediate results", () => {
  /**
   * Stage 1 was invalidated on 2026-09-22 by exactly this: `runArm` passed
   * `quiet: false`, so `runPairTournament` printed a cumulative win total and
   * win rate after every deal, and the redirected stdout left 40/200 deals'
   * running numbers on disk where they were read.
   *
   * §14's no-peek rule is a statement about what is *readable*, not about
   * whether anyone reads it. A source assertion is a blunt instrument, but the
   * property being protected is blunt: this file must never turn intermediate
   * results into text. The guard also pins that the results are still produced
   * — a runner that stopped calling `runPairTournament` at all would satisfy
   * "no streaming" while measuring nothing.
   */
  const RUNNERS = ["benchmarks/cf-pi-stage1.test.ts", "benchmarks/cf-top5-stage1.test.ts"];
  const sources = (): readonly (readonly [string, string])[] =>
    RUNNERS.map((path) => [path, readFileSync(path, "utf8")] as const);

  it("never passes quiet: false in any stage runner", () => {
    for (const [path, source] of sources()) {
      expect(source, path).not.toMatch(/^\s*quiet:\s*false/m);
    }
  });

  it("still passes quiet: true, and still runs the paired tournament", () => {
    for (const [path, source] of sources()) {
      expect(source, path).toMatch(/^\s*quiet:\s*true/m);
      expect(source, path).toContain("runPairTournament(");
    }
  });
});
