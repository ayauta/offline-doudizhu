/**
 * Spec 065's own §7 battery — the integrity checks for the *top5* corpus.
 *
 * This is a deliberate copy of `cf-pi-corpus.ts`, not an import of it. That
 * file validated the Spec 064 π2 corpus end to end — 20,000 groups, recorded,
 * and cited as the evidence that the corpus was sound — and it is frozen.
 * Widening its signature so a second round could reuse it would mean the
 * validator that produced a recorded result is no longer the validator that is
 * on disk, which is a worse property to lose than a few hundred duplicated
 * lines are to keep.
 *
 * Duplication is safe *here* and only here: a validator has no side effects on
 * the data. The same argument does **not** apply to `cf-dataset.ts`, whose
 * generator is parameterised with a default instead of copied — two generators
 * of the same corpus can drift, and the corpus is what every later number rests
 * on. See Spec 065 `stage0.md` §3.2.
 *
 * Every check below mirrors its counterpart one for one; the only differences
 * are the round's universe, split resolver, candidate width, dataset version
 * and proposal function. `tests/core/cf-top5-battery.test.ts` runs the whole
 * thing over a retired deal and mutation-tests each gate.
 */
import { generateLegalActions } from "../src/core/rules/index.js";
import type { Seat } from "../src/core/game/index.js";
import {
  cfActionCommand,
  cfCommandKey,
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
// The frozen π1 baseline is *imported*, not copied: it is the same champion
// both rounds measure against, and a second copy could drift from the one the
// product ships.
import { cfPiFrozenBaseline } from "./cf-pi-corpus.js";
import { CF_TOP5_DATASET_VERSION, CF_TOP5_LIMIT, cfProposal5 } from "./cf-top5.js";
import {
  CF_TOP5_UNIVERSE_END,
  CF_TOP5_UNIVERSE_START,
  cfTop5PoolOf,
  cfTop5SplitOf,
} from "./cf-top5-corpus.js";

export { cfPiFrozenBaseline };

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
export type CfTop5GroupExpectation = Readonly<{
  universeStart: number;
  universeEnd: number;
  splitOf: (dealIndex: number) => CfSplit | undefined;
  poolOf: (dealIndex: number) => string | null;
  /** The only pool a corpus group may come from. */
  expectedPool: string;
}>;

export const CF_TOP5_BATTERY_EXPECTATION: CfTop5GroupExpectation = Object.freeze({
  universeStart: CF_TOP5_UNIVERSE_START,
  universeEnd: CF_TOP5_UNIVERSE_END,
  splitOf: cfTop5SplitOf,
  poolOf: cfTop5PoolOf,
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
export function cfTop5ProposalMatches(snapshot: CfSnapshot): boolean {
  const legalActions = generateLegalActions({
    hand: snapshot.view.hand,
    currentPlay: snapshot.view.currentPlay,
  });
  const proposal: CfProposal = cfProposal5(Object.freeze({
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
export function cfTop5LegalityHolds(snapshot: CfSnapshot): boolean {
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
export function cfTop5AssertGroup(
  group: CfGroupResult,
  split: CfSplit,
  failures: Record<string, number>,
  expectation: CfTop5GroupExpectation = CF_TOP5_BATTERY_EXPECTATION,
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
    if (meta.datasetVersion !== CF_TOP5_DATASET_VERSION) {
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
    if (snapshot.candidates.length < 2 || snapshot.candidates.length > CF_TOP5_LIMIT) {
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

    if (!cfTop5LegalityHolds(snapshot)) {
      throw new CfInvalidError(`§7.14 ${meta.snapshotId} is not legal under the engine's own generator.`);
    }
    if (!cfTop5ProposalMatches(snapshot)) {
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

