/**
 * Node-side plumbing for the Gate A v1 corpus: shard planning, group specs,
 * checksums, the manifest, and the blind-reporting rules.
 *
 * Kept apart from `cf-dataset.ts` on purpose: that module stays clock-free and
 * IO-free so the leakage guards can run inside `pnpm check`. Everything that
 * touches the filesystem, the clock or `node:crypto` lives here, and nothing
 * here is reachable from `src/`.
 */
import { createHash } from "node:crypto";

import { SEAT_ORDER, type Seat } from "../src/core/game/index.js";
import { armSchedule, scheduleFor } from "./ai-tournament.js";
import {
  CF_FEATURE_NAMES,
  CF_FEATURE_SCHEMA_VERSION,
  CF_GROUP_SNAPSHOT_CAP,
  CF_SPLIT_COUNTS,
  CF_SPLIT_SALT,
  CF_UNIVERSE_END,
  CF_UNIVERSE_START,
  cfRows,
  cfSplitTable,
  type CfGroupResult,
  type CfLabel,
  type CfGroupSpec,
  type CfRow,
  type CfSplit,
} from "./cf-dataset.js";

/** LightGBM configuration version this corpus was frozen against. */
export const CF_LGBM_CONFIG_VERSION = "gateA-v1-frozen";

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The frozen schema hash: a digest of the column names in their frozen order,
 * plus the schema version. A corpus whose manifest schema hash does not match
 * the running code is unusable and must be regenerated, not patched.
 */
export function cfSchemaHash(): string {
  return sha256(JSON.stringify({
    version: CF_FEATURE_SCHEMA_VERSION,
    names: CF_FEATURE_NAMES,
  }));
}

/**
 * The arm-B group spec for one initial deal.
 *
 * Arm A is excluded deliberately: there the studied tier holds the landlord
 * seat, no override exists for it, and including it would only dilute the
 * per-group cost model with games that can never yield a row. The studied seat
 * therefore rotates across the two farmer seats as the deal index advances,
 * which is what covers both farmer positions.
 */
export function cfGroupSpecFor(dealIndex: number, policyCommit: string): CfGroupSpec | null {
  const dealSeed = dealIndex;
  const variants = armSchedule(dealIndex)
    .filter((slot) => slot.arm === "B" && slot.strongSeat !== slot.landlord)
    .map((slot) => Object.freeze({
      variantId: `${dealIndex}:${slot.landlord}:${slot.strongSeat}`,
      landlord: slot.landlord,
      studiedSeat: slot.strongSeat,
      gameSeed: dealSeed * 100 +
        SEAT_ORDER.indexOf(slot.strongSeat) * 10 +
        SEAT_ORDER.indexOf(slot.landlord),
      tiers: scheduleFor("master", "default", slot.strongSeat),
    }));
  if (variants.length === 0) {
    return null;
  }
  return Object.freeze({
    groupId: `deal-${dealIndex}`,
    dealIndex,
    dealSeed,
    variants: Object.freeze(variants),
    snapshotCap: CF_GROUP_SNAPSHOT_CAP,
    policyCommit,
  });
}

/** Contiguous, balanced deal windows; remainders fall on the later shards. */
export function cfShardWindows(
  start: number,
  count: number,
  shards: number,
): readonly Readonly<{ start: number; count: number }>[] {
  const windows: Array<Readonly<{ start: number; count: number }>> = [];
  let offset = 0;
  for (let index = 0; index < shards; index += 1) {
    const end = Math.floor(((index + 1) * count) / shards);
    if (end > offset) {
      windows.push(Object.freeze({ start: start + offset, count: end - offset }));
    }
    offset = end;
  }
  return Object.freeze(windows);
}

export type CfShardFile = Readonly<{
  /**
   * Provenance only — deliberately no job count. Sharding must not be visible
   * anywhere in the output, so that "jobs=1 and jobs=16 produced the same
   * bytes" is a statement about the whole file and not about a subset of it.
   */
  shard: Readonly<{ dealStart: number; deals: number }>;
  versions: Readonly<Record<string, string | number>>;
  groups: readonly CfGroupResult[];
}>;

export type CfCorpusFile = Readonly<{
  split: CfSplit;
  schemaHash: string;
  groups: readonly CfGroupResult[];
}>;

let splitTable: ReadonlyMap<number, CfSplit> | null = null;

/** The frozen split, materialised once — building it per lookup is O(n²). */
export function cfSplitOf(dealIndex: number): CfSplit | undefined {
  if (splitTable === null) {
    splitTable = cfSplitTable(
      CF_UNIVERSE_START,
      CF_UNIVERSE_END,
      CF_SPLIT_COUNTS,
      CF_SPLIT_SALT,
    );
  }
  return splitTable.get(dealIndex);
}

/**
 * Structural validation that is allowed to touch a sealed split: shape,
 * membership, legality and checksums — never an outcome.
 */
export type CfStructuralAudit = Readonly<{
  groups: number;
  groupsWithSnapshots: number;
  snapshots: number;
  rows: number;
  zeroSnapshotGroups: number;
  maxSnapshotsPerGroup: number;
  splitMismatches: number;
  schemaMismatches: number;
  labelIntegrityFailures: number;
  productionIndexFailures: number;
}>;

/**
 * Audits a set of groups *without reading labels*. The returned record has no
 * label field by construction, so a caller that wants held-out outcome
 * statistics has to go and get them on purpose rather than being handed them by
 * a friendly summary.
 *
 * `splitOf` is parameterised because a split resolver is bound to *its own*
 * universe, and this helper is used by more than one round. The v1 default
 * resolves over `50001..70000`, so auditing a π2 corpus with it reports every
 * single group as a split mismatch — not because a group is misfiled, but
 * because the resolver has never heard of that index. That is a silent
 * false-alarm generator: the number looks like a data defect and is actually a
 * property of the caller. Rounds other than v1 pass their own resolver.
 */
export function cfAuditStructure(
  groups: readonly CfGroupResult[],
  split: CfSplit,
  splitOf: (dealIndex: number) => CfSplit | undefined = cfSplitOf,
): CfStructuralAudit {
  let snapshots = 0;
  let rows = 0;
  let groupsWithSnapshots = 0;
  let maxSnapshotsPerGroup = 0;
  let splitMismatches = 0;
  let schemaMismatches = 0;
  let labelIntegrityFailures = 0;
  let productionIndexFailures = 0;
  for (const result of groups) {
    const expected = splitOf(result.dealIndex);
    if (expected !== split) {
      splitMismatches += 1;
    }
    if (result.snapshots.length > 0) {
      groupsWithSnapshots += 1;
    }
    maxSnapshotsPerGroup = Math.max(maxSnapshotsPerGroup, result.snapshots.length);
    snapshots += result.snapshots.length;
    for (const snapshot of result.snapshots) {
      if (snapshot.meta.featureSchemaVersion !== CF_FEATURE_SCHEMA_VERSION) {
        schemaMismatches += 1;
      }
      if (snapshot.labels[snapshot.productionIndex] !== 0) {
        productionIndexFailures += 1;
      }
      if (snapshot.labels.length !== snapshot.candidates.length) {
        labelIntegrityFailures += 1;
      }
    }
    rows += cfRowsForGroup(result, split).length;
  }
  return Object.freeze({
    groups: groups.length,
    groupsWithSnapshots,
    snapshots,
    rows,
    zeroSnapshotGroups: groups.length - groupsWithSnapshots,
    maxSnapshotsPerGroup,
    splitMismatches,
    schemaMismatches,
    labelIntegrityFailures,
    productionIndexFailures,
  });
}

/**
 * Counts labels into the three buckets the spec names.
 *
 * Written as an exported, tested function because the first version of this
 * tally keyed its map on `String(label)` — which produces `"1"`, not `"+1"` —
 * while the report read `counts["+1"]`. Every positive label was counted and
 * then never displayed, and the corpus looked like it contained no `+1` at all.
 * The data was fine; only the reading of it was wrong, which is the most
 * expensive kind of bug to notice late.
 */
export function cfLabelTally(
  labels: Iterable<CfLabel>,
): Readonly<{ "+1": number; "0": number; "-1": number }> {
  const tally = { "+1": 0, "0": 0, "-1": 0 };
  for (const label of labels) {
    if (label > 0) {
      tally["+1"] += 1;
    } else if (label < 0) {
      tally["-1"] += 1;
    } else {
      tally["0"] += 1;
    }
  }
  return Object.freeze(tally);
}

export function cfRowsForGroup(result: CfGroupResult, split: CfSplit): readonly CfRow[] {
  return result.snapshots.flatMap((snapshot) => cfRows(snapshot, split));
}

/** Every farmer seat that appears, so a corpus covering only one seat is visible. */
export function cfSeatCoverage(groups: readonly CfGroupResult[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const result of groups) {
    for (const snapshot of result.snapshots) {
      counts[snapshot.meta.seat] = (counts[snapshot.meta.seat] ?? 0) + 1;
    }
  }
  return Object.freeze(counts);
}

export function cfFarmerPositions(seat: Seat, landlord: Seat): number {
  return (SEAT_ORDER.indexOf(seat) - SEAT_ORDER.indexOf(landlord) + 3) % 3;
}
