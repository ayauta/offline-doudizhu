/**
 * Exhaustive integrity checks for the π1→π2 corpus (spec 064 §7).
 *
 * Kept apart from the driver (`cf-pi-corpus.test.ts`) for the same reason
 * `cf-corpus.ts` is apart from `cf-corpus.test.ts`: this module is pure, so the
 * guards in `tests/` can import it and prove it rejects bad input, while the
 * driver is the thing that touches the filesystem and runs for hours.
 *
 * **Every check here is exhaustive, never sampled.** Spec §7.16 says so in
 * words — "机械断言，不是抽样" — and the reason is that a corpus is generated
 * once and then trusted for the rest of the round: a defect that survives into
 * the merged file is not caught later by any downstream check, because the
 * downstream checks read the same rows and agree with themselves.
 *
 * Each assertion names the §7 gate it enforces, so a failure points at a
 * preregistered rule rather than at a line number.
 */
import { CF_MODEL_JSON, CF_MODEL_SHA256 } from "../src/app/ai/cf-model-data.js";
import { parseTreeModel } from "./cf-model.js";
import { generateLegalActions } from "../src/core/rules/index.js";
import type { Seat } from "../src/core/game/index.js";
import {
  CF_CANDIDATE_LIMIT,
  cfActionCommand,
  cfCommandKey,
  cfProposal,
  type CfProposal,
} from "../src/app/ai/cf-selector.js";
import {
  CF_FEATURE_NAMES,
  CF_FEATURE_SCHEMA_VERSION,
  CF_RULES_VERSION,
  CfInvalidError,
  cfRow,
  cfRows,
  type CfGroupResult,
  type CfSnapshot,
  type CfSplit,
} from "./cf-dataset.js";
import {
  CF_PI_DATASET_VERSION,
  CF_PI_MODEL_SHA256,
  CF_PI_THRESHOLD,
  CF_PI_UNIVERSE_END,
  CF_PI_UNIVERSE_START,
  cfPiPoolOf,
  cfPiSplitOf,
  type CfPiBaseline,
} from "./cf-policy-iteration.js";

const SEAT_ORDER = Object.freeze(["human", "ai-one", "ai-two"] as const);

/**
 * Which pool a group is expected to belong to.
 *
 * Parameterised rather than hard-coded to this round's universe so the guards
 * in `tests/` can run the whole battery over a **retired** deal. A guard that
 * could only ever be exercised on fresh seeds is a guard nobody can afford to
 * test, and an untested guard is the thing this whole module exists to avoid.
 * The round's own values are the default, so a production call site cannot get
 * this wrong by forgetting to pass it.
 */
export type CfPiGroupExpectation = Readonly<{
  universeStart: number;
  universeEnd: number;
  splitOf: (dealIndex: number) => CfSplit | undefined;
  poolOf: (dealIndex: number) => string | null;
  /** The only pool a corpus group may come from. */
  expectedPool: string;
}>;

export const CF_PI_GROUP_EXPECTATION: CfPiGroupExpectation = Object.freeze({
  universeStart: CF_PI_UNIVERSE_START,
  universeEnd: CF_PI_UNIVERSE_END,
  splitOf: cfPiSplitOf,
  poolOf: cfPiPoolOf,
  expectedPool: "dataset",
});

export type CfPiAudit = Readonly<{
  groups: number;
  snapshots: number;
  rows: number;
  variants: number;
  /** Roots where π1 overrode production — the mechanism actually firing. */
  overridden: number;
  /** Rows rejected, by gate. All zero on a valid corpus. */
  failures: Readonly<Record<string, number>>;
}>;

function bump(failures: Record<string, number>, gate: string): void {
  failures[gate] = (failures[gate] ?? 0) + 1;
}

/**
 * §7.1, §7.3 — the candidate set is the production shortlist `C`, in `C`'s own
 * order, with the reference removed; and `b0` is still one of the alternatives
 * whenever it differs from `b1`.
 *
 * Re-derived from the snapshot's own redacted view by calling the frozen
 * `cfProposal` again, so a stored set that was reordered, filtered or padded
 * fails here. `cfProposal` is a pure function of the view, which is what makes
 * this a check rather than a restatement.
 *
 * The length equality below is load-bearing and is not implied by the
 * element-wise loop that follows it: the loop only walks as far as the *stored*
 * array goes, so a shortlist truncated from three candidates to two compares
 * equal on its remaining elements and would otherwise pass. Measured, not
 * assumed — dropping this line takes a 3→2 truncation from rejected 3/3 to
 * rejected 0/3, and `pi2 corpus: every gate rejects its own violation` has a
 * case that pins exactly that.
 */
export function cfPiProposalMatches(snapshot: CfSnapshot): boolean {
  const legalActions = generateLegalActions({
    hand: snapshot.view.hand,
    currentPlay: snapshot.view.currentPlay,
  });
  const proposal: CfProposal = cfProposal(Object.freeze({
    kind: "play" as const,
    view: snapshot.view,
    legalActions,
  }));
  if (proposal.actions.length !== snapshot.candidates.length) {
    return false;
  }
  const seat = snapshot.meta.seat;
  for (let index = 0; index < snapshot.candidates.length; index += 1) {
    const candidate = snapshot.candidates[index];
    if (candidate === undefined) {
      return false;
    }
    const stored = snapshot.actions[candidate.actionIndex];
    const derived = proposal.actions[index];
    if (stored === undefined || derived === undefined) {
      return false;
    }
    if (cfCommandKey(cfActionCommand(seat, stored)) !== cfCommandKey(cfActionCommand(seat, derived))) {
      return false;
    }
  }
  return true;
}

/**
 * §7.14 — legality, against the engine's own generator rather than a second
 * notion invented here.
 *
 * The stored `actions` array must be exactly what `generateLegalActions`
 * produces for this snapshot's own view, and every candidate, `b0` and `b1`
 * must be one of those actions. Anything else is INVALID, never a skipped row.
 */
export function cfPiLegalityHolds(snapshot: CfSnapshot): boolean {
  const legalActions = generateLegalActions({
    hand: snapshot.view.hand,
    currentPlay: snapshot.view.currentPlay,
  });
  if (legalActions.length !== snapshot.actions.length) {
    return false;
  }
  const seat = snapshot.meta.seat;
  for (let index = 0; index < legalActions.length; index += 1) {
    const derived = legalActions[index];
    const stored = snapshot.actions[index];
    if (derived === undefined || stored === undefined) {
      return false;
    }
    if (cfCommandKey(cfActionCommand(seat, stored)) !== cfCommandKey(cfActionCommand(seat, derived))) {
      return false;
    }
  }
  const rawIndex = snapshot.meta.rawProductionIndex;
  for (const candidateIndex of [snapshot.productionIndex, rawIndex]) {
    if (candidateIndex === undefined) {
      return false;
    }
    const candidate = snapshot.candidates[candidateIndex];
    if (candidate === undefined || snapshot.actions[candidate.actionIndex] === undefined) {
      return false;
    }
  }
  return true;
}

/**
 * Validates one group exhaustively. Returns the number of snapshots and rows
 * accepted; throws on the first violation so a bad shard never reaches disk.
 */
export function cfPiAssertGroup(
  group: CfGroupResult,
  split: CfSplit,
  failures: Record<string, number>,
  expectation: CfPiGroupExpectation = CF_PI_GROUP_EXPECTATION,
): Readonly<{ snapshots: number; rows: number; overridden: number }> {
  const dealIndex = group.dealIndex;

  // §7.16 — this group belongs to the dataset pool and to nothing else. The
  // gaps between this round's own pools are checked too, because "nobody
  // allocated it" and "somebody checked it" are different guarantees.
  if (dealIndex < expectation.universeStart || dealIndex > expectation.universeEnd) {
    throw new CfInvalidError(`§7.16 deal ${dealIndex} is outside the corpus universe.`);
  }
  if (expectation.poolOf(dealIndex) !== expectation.expectedPool) {
    throw new CfInvalidError(`§7.16 deal ${dealIndex} is not in the ${expectation.expectedPool} pool.`);
  }
  if (expectation.splitOf(dealIndex) !== split) {
    throw new CfInvalidError(`§7.16 deal ${dealIndex} is not in the ${split} split.`);
  }
  if (group.groupId !== `deal-${dealIndex}`) {
    throw new CfInvalidError(`Group ${group.groupId} does not match deal ${dealIndex}.`);
  }

  // The deal's own identity: the seed is the absolute index, and each variant's
  // game seed is the tournament's function of it. A corpus built on a different
  // mapping would describe games the strength run never plays (§7.10).
  const variantIds = Object.keys(group.variantWinners);
  if (variantIds.length === 0) {
    throw new CfInvalidError(`§7.10 deal ${dealIndex} recorded no variant winner.`);
  }
  for (const variantId of variantIds) {
    const parts = variantId.split(":");
    if (parts.length !== 3 || Number.parseInt(parts[0] ?? "", 10) !== dealIndex) {
      throw new CfInvalidError(`§7.10 variant ${variantId} does not belong to deal ${dealIndex}.`);
    }
    const landlord = parts[1] as Seat;
    const studiedSeat = parts[2] as Seat;
    if (landlord === studiedSeat) {
      throw new CfInvalidError(`§7.16 variant ${variantId} studies the landlord root.`);
    }
    if (!SEAT_ORDER.includes(studiedSeat) || !SEAT_ORDER.includes(landlord)) {
      throw new CfInvalidError(`§7.10 variant ${variantId} names an unknown seat.`);
    }
  }

  let rows = 0;
  let overridden = 0;
  for (const snapshot of group.snapshots) {
    const meta = snapshot.meta;
    if (meta.datasetVersion !== CF_PI_DATASET_VERSION) {
      throw new CfInvalidError(`§7.18 ${meta.snapshotId} carries dataset version ${meta.datasetVersion}.`);
    }
    if (meta.featureSchemaVersion !== CF_FEATURE_SCHEMA_VERSION) {
      throw new CfInvalidError(`§7.18 ${meta.snapshotId} carries schema version ${meta.featureSchemaVersion}.`);
    }
    if (meta.rulesVersion !== CF_RULES_VERSION) {
      throw new CfInvalidError(`§7.18 ${meta.snapshotId} carries rules version ${meta.rulesVersion}.`);
    }
    if (meta.dealIndex !== dealIndex || meta.groupId !== group.groupId) {
      throw new CfInvalidError(`§7.16 ${meta.snapshotId} belongs to a different group.`);
    }
    // §7.9 — a snapshot is only ever taken at the studied seat, and never at
    // the landlord.
    if (meta.seat === meta.landlord) {
      throw new CfInvalidError(`§7.9 ${meta.snapshotId} was taken at the landlord seat.`);
    }
    if (!variantIds.includes(meta.variantId)) {
      throw new CfInvalidError(`§7.10 ${meta.snapshotId} names an unrecorded variant.`);
    }
    const variantWinner = group.variantWinners[meta.variantId];
    if (variantWinner === undefined) {
      throw new CfInvalidError(`§7.10 ${meta.snapshotId}'s variant has no winner.`);
    }

    // §7.6 — the reference branch consumed exactly one studied-seat decision.
    if (meta.continuationCounters[meta.seat] !== meta.seatDecisionIndex + 1) {
      throw new CfInvalidError(`§7.6 ${meta.snapshotId} did not consume exactly one decision.`);
    }

    // §7.3 — at least two candidates, never wider than the frozen cap.
    if (snapshot.candidates.length < 2 || snapshot.candidates.length > CF_CANDIDATE_LIMIT) {
      throw new CfInvalidError(`§7.3 ${meta.snapshotId} has ${snapshot.candidates.length} candidates.`);
    }
    const keys = new Set<string>();
    for (const candidate of snapshot.candidates) {
      const action = snapshot.actions[candidate.actionIndex];
      if (action === undefined) {
        throw new CfInvalidError(`§7.14 ${meta.snapshotId} has a candidate outside its legal actions.`);
      }
      keys.add(cfCommandKey(cfActionCommand(meta.seat, action)));
    }
    if (keys.size !== snapshot.candidates.length) {
      throw new CfInvalidError(`§7.3 ${meta.snapshotId} repeats a candidate.`);
    }

    if (!cfPiLegalityHolds(snapshot)) {
      throw new CfInvalidError(`§7.14 ${meta.snapshotId} is not legal under the engine's own generator.`);
    }
    if (!cfPiProposalMatches(snapshot)) {
      throw new CfInvalidError(`§7.3 ${meta.snapshotId} does not reproduce the frozen candidate order.`);
    }

    // §7.2 — the reference's own label is zero by construction, and the
    // reference branch reproduced the game the snapshot was taken from.
    if (snapshot.labels[snapshot.productionIndex] !== 0) {
      throw new CfInvalidError(`§7.2 ${meta.snapshotId} does not label its reference zero.`);
    }
    if (snapshot.winners[snapshot.productionIndex] !== variantWinner) {
      throw new CfInvalidError(`§7.7 ${meta.snapshotId}'s reference branch did not reproduce its game.`);
    }

    // §7.1 — `b0` is recorded beside `b1`, and is one of the candidates.
    const rawIndex = meta.rawProductionIndex;
    if (rawIndex === undefined) {
      throw new CfInvalidError(`§7.1 ${meta.snapshotId} did not record the raw production action.`);
    }
    if (rawIndex < 0 || rawIndex >= snapshot.candidates.length) {
      throw new CfInvalidError(`§7.1 ${meta.snapshotId} records b0 outside the candidate set.`);
    }
    if (rawIndex !== snapshot.productionIndex) {
      overridden += 1;
    }

    // §7.18 — v1's own reader consumes these rows unchanged.
    const snapshotRows = cfRows(snapshot, split);
    if (snapshotRows.length !== snapshot.candidates.length - 1) {
      throw new CfInvalidError(`§7.18 ${meta.snapshotId} produced ${snapshotRows.length} rows.`);
    }
    const referenceIndex = snapshot.candidates[snapshot.productionIndex]?.actionIndex;
    const reference = referenceIndex === undefined ? undefined : snapshot.actions[referenceIndex];
    if (reference === undefined) {
      throw new CfInvalidError(`§7.2 ${meta.snapshotId} has no reference action.`);
    }
    snapshot.candidates.forEach((candidate, index) => {
      if (index === snapshot.productionIndex) {
        return;
      }
      const action = snapshot.actions[candidate.actionIndex];
      const label = snapshot.labels[index];
      if (action === undefined || label === undefined) {
        throw new CfInvalidError(`§7.18 ${meta.snapshotId} candidate ${index} is incomplete.`);
      }
      if (label !== -1 && label !== 0 && label !== 1) {
        throw new CfInvalidError(`§7.18 ${meta.snapshotId} candidate ${index} has label ${label}.`);
      }
      const row = cfRow(snapshot.view, action, reference);
      if (row.length !== CF_FEATURE_NAMES.length) {
        throw new CfInvalidError(
          `§7.18 ${meta.snapshotId} built a ${row.length}-column row, ` +
          `the frozen schema has ${CF_FEATURE_NAMES.length}.`,
        );
      }
      for (const value of row) {
        if (typeof value !== "number") {
          throw new CfInvalidError(`§7.18 ${meta.snapshotId} built a non-numeric column.`);
        }
      }
    });
    rows += snapshotRows.length;
  }

  bump(failures, "accepted");
  return Object.freeze({ snapshots: group.snapshots.length, rows, overridden });
}

/**
 * The frozen π1 record, built from the artifact the *product ships* and checked
 * against its published identity. Reading it from `.local/` would make "the
 * baseline is frozen π1" a claim about whatever file happened to be on disk.
 *
 * Takes the artifact text as an argument so the guards in `tests/` can point the
 * same checks at a tampered copy and watch them reject it.
 *
 * `CF_MODEL_SHA256` identifies the **LightGBM booster text**, not this JSON
 * wrapper: `cf-export-model.py` copies the booster's digest into the generated
 * module as `modelSha256`, and that is the field to bind against. Hashing the
 * wrapper and comparing it to the constant is a check that can only ever fail —
 * it did, on the first attempt at this file, before a single seed was dealt.
 *
 * What is verified here is everything this side of the boundary can verify: the
 * digest the artifact claims is the frozen one, the tree table is the width and
 * depth it claims, and the column order is the frozen schema's. That the table
 * reproduces LightGBM's own predictions is `cf-model-equivalence.test.ts`.
 */
export function cfPiFrozenBaseline(artifactJson: string = CF_MODEL_JSON): CfPiBaseline {
  const parsed = JSON.parse(artifactJson) as {
    modelSha256?: string;
    numTrees?: number;
    numFeatures?: number;
    trees?: readonly unknown[];
    featureNames?: readonly string[];
  };
  if (parsed.modelSha256 !== CF_MODEL_SHA256) {
    throw new Error(
      `The shipped artifact claims model ${String(parsed.modelSha256)}, ` +
      `expected ${CF_MODEL_SHA256}.`,
    );
  }
  if (CF_PI_MODEL_SHA256 !== CF_MODEL_SHA256) {
    throw new Error("The π2 round's baseline is not the frozen artifact.");
  }
  if (parsed.trees?.length !== parsed.numTrees || parsed.numTrees === undefined) {
    throw new Error(
      `The shipped artifact carries ${String(parsed.trees?.length)} trees, claims ${String(parsed.numTrees)}.`,
    );
  }
  if (parsed.featureNames?.length !== CF_FEATURE_NAMES.length ||
    parsed.featureNames.some((name, index) => name !== CF_FEATURE_NAMES[index])) {
    throw new Error("The shipped artifact's feature order is not the frozen schema's.");
  }
  if (parsed.numFeatures !== CF_FEATURE_NAMES.length) {
    throw new Error("The shipped artifact disagrees with the frozen schema width.");
  }
  return Object.freeze({
    model: parseTreeModel(JSON.parse(artifactJson) as Parameters<typeof parseTreeModel>[0]),
    threshold: CF_PI_THRESHOLD,
  });
}
