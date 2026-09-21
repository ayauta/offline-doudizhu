/**
 * Spec 065 corpus plumbing: pools, split, and the round's integrity expectation.
 *
 * Deliberately thin. The exhaustive §7 battery itself is `cf-pi-corpus.ts`,
 * which was validated over 20,000 groups in Spec 064; this module only supplies
 * the four things that differ for a widened interface — the universe, the split
 * salt, and the two expectation fields the battery needs (`proposalFor`,
 * `candidateLimit`). Rewriting the battery for this round would discard a
 * validator that has already been proven, and the point of a new mechanism
 * family is to change one thing, not to re-derive the safety net.
 */
import { CF_GROUP_SNAPSHOT_CAP, cfSplitTable, type CfSplit } from "./cf-dataset.js";
import { CF_SPLIT_COUNTS } from "./cf-dataset.js";
import { CF_TOP5_DATASET_VERSION, CF_TOP5_SPLIT_SALT } from "./cf-top5.js";
import { CfInvalidError } from "./cf-dataset.js";
import { armSchedule, dealGameSeed, scheduleFor } from "./ai-tournament.js";

export { CF_TOP5_DATASET_VERSION };

/** 140001–160000: train / calibration / held-out = 12,000 / 4,000 / 4,000. */
export const CF_TOP5_UNIVERSE_START = 140_001;
export const CF_TOP5_UNIVERSE_END = 160_000;

/** Exactly 200 groups, the screen. */
export const CF_TOP5_STAGE1_START = 160_001;
export const CF_TOP5_STAGE1_END = 160_200;
/** Exactly 1,200 groups, the one formal decision of this round. */
export const CF_TOP5_STAGE2_START = 170_001;
export const CF_TOP5_STAGE2_END = 171_200;

export const CF_TOP5_SEED_BASE = 0;

/** Every range this round may not touch, gaps included — see spec §8. */
export const CF_TOP5_UNAVAILABLE_RANGES: readonly Readonly<{
  start: number;
  end: number;
  label: string;
}>[] = Object.freeze([
  Object.freeze({ start: 301, end: 700, label: "retired / exposed" }),
  Object.freeze({ start: 5_001, end: 5_400, label: "mechanical prototype" }),
  Object.freeze({ start: 10_001, end: 10_400, label: "Phase 2 v1 final validation" }),
  Object.freeze({ start: 20_001, end: 20_400, label: "retired / exposed" }),
  Object.freeze({ start: 30_001, end: 30_400, label: "retired / exposed" }),
  Object.freeze({ start: 40_001, end: 41_200, label: "Gate B Discovery V4" }),
  Object.freeze({ start: 50_001, end: 70_000, label: "Phase 2 v1 dataset" }),
  Object.freeze({ start: 70_001, end: 78_000, label: "Spec 062 test-only reserve" }),
  // Spec 064's pools. This mechanism line may not touch any of them again.
  Object.freeze({ start: 100_001, end: 120_000, label: "Spec 064 pi2 dataset" }),
  Object.freeze({ start: 120_001, end: 120_200, label: "Spec 064 Stage 1 (invalid, retired)" }),
  Object.freeze({ start: 120_201, end: 130_000, label: "Spec 064 unallocated gap" }),
  Object.freeze({ start: 130_001, end: 131_200, label: "Spec 064 Stage 2 (unused)" }),
  Object.freeze({ start: 131_201, end: 140_000, label: "unallocated gap" }),
  Object.freeze({ start: 160_201, end: 170_000, label: "unallocated gap" }),
  Object.freeze({ start: 171_201, end: Number.MAX_SAFE_INTEGER, label: "unallocated tail" }),
]);

/** The three pools of this round, in ascending order. */
export const CF_TOP5_POOLS: readonly Readonly<{ name: string; start: number; end: number }>[] =
  Object.freeze([
    Object.freeze({ name: "dataset", start: CF_TOP5_UNIVERSE_START, end: CF_TOP5_UNIVERSE_END }),
    Object.freeze({ name: "stage1", start: CF_TOP5_STAGE1_START, end: CF_TOP5_STAGE1_END }),
    Object.freeze({ name: "stage2", start: CF_TOP5_STAGE2_START, end: CF_TOP5_STAGE2_END }),
  ]);

export function cfTop5PoolOf(dealIndex: number): string | null {
  for (const pool of CF_TOP5_POOLS) {
    if (dealIndex >= pool.start && dealIndex <= pool.end) {
      return pool.name;
    }
  }
  return null;
}

let splitTable: ReadonlyMap<number, CfSplit> | null = null;

export function cfTop5SplitOf(dealIndex: number): CfSplit | undefined {
  if (splitTable === null) {
    splitTable = cfSplitTable(
      CF_TOP5_UNIVERSE_START,
      CF_TOP5_UNIVERSE_END,
      CF_SPLIT_COUNTS,
      CF_TOP5_SPLIT_SALT,
    );
  }
  return splitTable.get(dealIndex);
}

export function assertTop5SeedBase(seedBase: number): void {
  if (seedBase !== CF_TOP5_SEED_BASE) {
    throw new CfInvalidError(
      `Spec 065 preregisters seedBase ${CF_TOP5_SEED_BASE}; received ${seedBase}. ` +
      "A different base puts the corpus and the tournament on different decks.",
    );
  }
}

export { CF_GROUP_SNAPSHOT_CAP };

/** Unchanged from v1: at most three useful snapshots per group. */
export const CF_TOP5_GROUP_SNAPSHOT_CAP = CF_GROUP_SNAPSHOT_CAP;

/** Unchanged from v1: train / calibration / held-out = 12,000 / 4,000 / 4,000. */
export const CF_TOP5_SPLIT_COUNTS = CF_SPLIT_COUNTS;

/**
 * The arm-B group spec for one deal of the top5 universe.
 *
 * Identical in shape to Spec 064's builder — same arm-B farmer variants, same
 * `dealGameSeed` the tournament uses — and it refuses anything outside the
 * dataset pool outright, because the stage pools and the gaps are other
 * experiments and a generator that quietly skipped them would look finished.
 */
export function cfTop5GroupSpecFor(dealIndex: number, policyCommit: string): import("./cf-dataset.js").CfGroupSpec {
  if (cfTop5SplitOf(dealIndex) === undefined) {
    const pool = cfTop5PoolOf(dealIndex);
    throw new CfInvalidError(
      pool === null
        ? `Deal ${dealIndex} is outside the top5 dataset universe ` +
          `(${CF_TOP5_UNIVERSE_START}..${CF_TOP5_UNIVERSE_END}).`
        : `Deal ${dealIndex} belongs to the ${pool} pool, which is not training data.`,
    );
  }
  const dealSeed = dealIndex;
  const variants = armSchedule(dealIndex)
    .filter((slot) => slot.arm === "B" && slot.strongSeat !== slot.landlord)
    .map((slot) => Object.freeze({
      variantId: `${dealIndex}:${slot.landlord}:${slot.strongSeat}`,
      landlord: slot.landlord,
      studiedSeat: slot.strongSeat,
      gameSeed: dealGameSeed(dealSeed, slot.strongSeat, slot.landlord),
      tiers: scheduleFor("master", "default", slot.strongSeat),
    }));
  return Object.freeze({
    groupId: `deal-${dealIndex}`,
    dealIndex,
    dealSeed,
    variants: Object.freeze(variants),
    snapshotCap: CF_GROUP_SNAPSHOT_CAP,
    policyCommit,
  });
}
