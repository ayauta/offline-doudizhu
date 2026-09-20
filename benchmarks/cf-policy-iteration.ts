/**
 * Phase 2 Night Lab: the π1→π2 policy iteration mechanism (spec 064).
 *
 * This is not product code and nothing in `src/` imports it. It exists so that
 * the one question this round asks — "with π1 already changing the play, does a
 * model trained on π1's own visits, against π1's own executed action, add
 * anything on top?" — is answered by machinery that can be inspected before a
 * single fresh seed is drawn.
 *
 * Three things live here.
 *
 * 1. **The runtime challenger** (§5). Two layers over *one* proposal: π1 scores
 *    `C \ {b0}`, π2 scores `C \ {b1}`. Both use the shared seam
 *    `cfScoreAlternatives`, so "the composition added one model traversal and
 *    nothing else" is a statement about one function rather than about two
 *    copies of a rule.
 *
 * 2. **π1 as a capture policy** (§4, §6). π1 is π0 plus the frozen selector at
 *    exactly one seat. It is expressed as a transformation of the production
 *    command rather than as a second decision function, which keeps the
 *    decision counter and the seed derivation in the one place `cf-dataset.ts`
 *    already had them.
 *
 * 3. **The round's pools and split** (§8). The fresh ranges are declared here,
 *    and `cfPiGroupSpecFor` refuses to build a group anywhere else — a pool
 *    boundary that is only enforced by the operator remembering it is not
 *    enforced.
 *
 * The frozen π1 model, threshold and schema are *imported*, never restated:
 * `CF_MODEL_SHA256` and `CF_SELECTOR_THRESHOLD` come from the generated
 * artifact module, and the schema hash is re-derived from the column names by
 * `cfSchemaHash()`. A second copy of `0.01` in this file would be a second
 * source of truth, and the copy that drifts is always the one nobody re-reads.
 */
import type { CardId } from "../src/core/cards/index.js";
import type { GameCommand, Seat } from "../src/core/game/index.js";
import type { AiDecisionContext, AiStrategy } from "../src/core/ai/index.js";
import { CF_MODEL_SHA256, CF_SELECTOR_THRESHOLD } from "../src/app/ai/cf-model-data.js";
import {
  CF_CANDIDATE_LIMIT,
  cfActionCommand,
  cfCommandKey,
  cfProposal,
  cfScoreAlternatives,
  cfSelectFarmerAction,
  type CfProposal,
  type SelectorEvent,
  type TreeModel,
} from "../src/app/ai/cf-selector.js";
import {
  CF_GROUP_SNAPSHOT_CAP,
  CF_SPLIT_COUNTS,
  CfInvalidError,
  cfCaptureGroup,
  cfSplitTable,
  type CfGroupResult,
  type CfGroupSpec,
  type CfPolicy,
  type CfSplit,
} from "./cf-dataset.js";
import { armSchedule, dealGameSeed, scheduleFor } from "./ai-tournament.js";

type PlayContext = Extract<AiDecisionContext, { readonly kind: "play" }>;

export { CF_MODEL_SHA256, CF_SELECTOR_THRESHOLD };
export { cfTraceDivergence, type CfGroupResult, type CfGroupSpec } from "./cf-dataset.js";

// ---------------------------------------------------------------------------
// The frozen π1 baseline
// ---------------------------------------------------------------------------

/**
 * Frozen π1, as this round uses it. Both roles — the paired baseline arm and
 * the data-generation policy — read the same two fields, so they cannot be
 * pointed at different models.
 *
 * Deliberately no challenger field: the baseline arm has nowhere to put a π2
 * model, which is the structural half of "the baseline arm constructs no π2
 * model" (§7.15).
 */
export type CfPiBaseline = Readonly<{
  model: TreeModel;
  /** Exactly the frozen artifact's `0.01`. Imported, never retyped. */
  threshold: number;
}>;

export const CF_PI_THRESHOLD = CF_SELECTOR_THRESHOLD;

/** The artifact identity the run must report, for the baseline-identity gate. */
export const CF_PI_MODEL_SHA256 = CF_MODEL_SHA256;

// ---------------------------------------------------------------------------
// Pools and split (§8)
// ---------------------------------------------------------------------------

/**
 * A π2 corpus is not a v1 corpus and must never be read as one. The row shape
 * is identical by design (§7.18); the *provenance* is not.
 */
export const CF_PI_DATASET_VERSION = 3;

/** 100001–120000: train / calibration / held-out = 12,000 / 4,000 / 4,000. */
export const CF_PI_UNIVERSE_START = 100_001;
export const CF_PI_UNIVERSE_END = 120_000;
export const CF_PI_SPLIT_COUNTS = CF_SPLIT_COUNTS;
export const CF_PI_SPLIT_SALT = "phase2-pi1-split";
export const CF_PI_SNAPSHOT_SALT = "phase2-pi1-snapshot";

/** Exactly 200 groups, the screen. Never merged with Stage 2. */
export const CF_PI_STAGE1_START = 120_001;
export const CF_PI_STAGE1_END = 120_200;
/** Exactly 1,200 groups, the one formal decision of this round. */
export const CF_PI_STAGE2_START = 130_001;
export const CF_PI_STAGE2_END = 131_200;

/** Unchanged from v1 (§4): at most three useful snapshots per group. */
export const CF_PI_GROUP_SNAPSHOT_CAP = CF_GROUP_SNAPSHOT_CAP;

/**
 * The tournament's `seedBase`. The corpus builds a deck from `dealSeed`, the
 * tournament from `seedBase + dealIndex`; at zero those are the same number,
 * which is what makes §7.10 checkable at all. A non-zero base would put the
 * corpus and the strength run on different decks while every other number
 * still looked right.
 */
export const CF_PI_SEED_BASE = 0;

export function assertPiSeedBase(seedBase: number): void {
  if (seedBase !== CF_PI_SEED_BASE) {
    throw new CfInvalidError(
      `Night Lab preregisters seedBase ${CF_PI_SEED_BASE}; received ${seedBase}. ` +
      "A different base puts the corpus and the tournament on different decks.",
    );
  }
}

/**
 * Every range this round may not touch, including the two *gaps* between its
 * own pools. The gaps are listed rather than merely left out because "nobody
 * allocated it" and "somebody checked it" are different guarantees, and only
 * one of them survives a tired operator at 04:00.
 */
export const CF_PI_UNAVAILABLE_RANGES: readonly Readonly<{
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
  Object.freeze({ start: 120_201, end: 130_000, label: "unallocated gap" }),
  Object.freeze({ start: 131_201, end: Number.MAX_SAFE_INTEGER, label: "unallocated tail" }),
]);

/** The three pools of this round, in ascending order. */
export const CF_PI_POOLS: readonly Readonly<{ name: string; start: number; end: number }>[] =
  Object.freeze([
    Object.freeze({ name: "dataset", start: CF_PI_UNIVERSE_START, end: CF_PI_UNIVERSE_END }),
    Object.freeze({ name: "stage1", start: CF_PI_STAGE1_START, end: CF_PI_STAGE1_END }),
    Object.freeze({ name: "stage2", start: CF_PI_STAGE2_START, end: CF_PI_STAGE2_END }),
  ]);

/**
 * Which pool-relative question a deal index belongs to, or `null` when this
 * round has no business with it. Note the *shape*: the answer is an identity,
 * not a split, because the screen and the confirmation are not training data.
 */
export function cfPiPoolOf(dealIndex: number): string | null {
  for (const pool of CF_PI_POOLS) {
    if (dealIndex >= pool.start && dealIndex <= pool.end) {
      return pool.name;
    }
  }
  return null;
}

let splitTable: ReadonlyMap<number, CfSplit> | null = null;

/**
 * The training split, a function of the group alone. Materialised once —
 * building it per lookup is O(n²) over 20,000 groups.
 */
export function cfPiSplitOf(dealIndex: number): CfSplit | undefined {
  if (splitTable === null) {
    splitTable = cfSplitTable(
      CF_PI_UNIVERSE_START,
      CF_PI_UNIVERSE_END,
      CF_PI_SPLIT_COUNTS,
      CF_PI_SPLIT_SALT,
    );
  }
  return splitTable.get(dealIndex);
}

/**
 * The arm-B group spec for one deal of the π2 universe.
 *
 * Refuses anything that is not a dataset-universe index outright rather than
 * returning `null`: the stage pools and the gaps are *other experiments*, and a
 * generator that quietly skipped them would look like it had finished.
 *
 * Arm A is excluded for the same reason v1 excluded it — the strong seat holds
 * the landlord, where no override exists, so those games can never yield a row.
 */
export function cfPiGroupSpecFor(dealIndex: number, policyCommit: string): CfGroupSpec {
  if (cfPiSplitOf(dealIndex) === undefined) {
    const pool = cfPiPoolOf(dealIndex);
    throw new CfInvalidError(
      pool === null
        ? `Deal ${dealIndex} is outside the π1→π2 dataset universe ` +
          `(${CF_PI_UNIVERSE_START}..${CF_PI_UNIVERSE_END}).`
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
      // The same function the tournament calls, so the corpus and the strength
      // run cannot disagree about which game a deal index names.
      gameSeed: dealGameSeed(dealSeed, slot.strongSeat, slot.landlord),
      tiers: scheduleFor("master", "default", slot.strongSeat),
    }));
  return Object.freeze({
    groupId: `deal-${dealIndex}`,
    dealIndex,
    dealSeed,
    variants: Object.freeze(variants),
    snapshotCap: CF_PI_GROUP_SNAPSHOT_CAP,
    policyCommit,
  });
}

// ---------------------------------------------------------------------------
// π1 as a policy: π0 plus the frozen selector at exactly one seat
// ---------------------------------------------------------------------------

export type CfPiDecision = Readonly<{
  /** What production proposed here — π1's `b0`. */
  raw: GameCommand;
  /** What the frozen selector executed — π1's `b1`, object-identical to `raw` when it declined. */
  executed: GameCommand;
  /** True when the selector replaced `b0` with a different candidate. */
  overrode: boolean;
  /** `b1`'s index in `C`, or -1 when the selector declined or had no proposal. */
  executedIndex: number;
}>;

/**
 * One π1 decision: run the *shipped* selector and report what it did.
 *
 * `cfSelectFarmerAction` is called rather than re-implemented — its eligibility
 * gate (a two-action minimum, the production action present in its own
 * shortlist, the seat identity) has branches a fixture will not reach, and a
 * second copy of that gate is how a data-generation policy and the product
 * start disagreeing about what π1 is.
 *
 * The executed index is read off the selector's own observer instead of being
 * recomputed, which keeps this to one proposal per decision rather than two.
 */
export function cfPiDecision(
  context: AiDecisionContext,
  raw: GameCommand,
  seat: Seat,
  baseline: CfPiBaseline,
): CfPiDecision {
  const sink: { event: SelectorEvent | null } = { event: null };
  const executed = cfSelectFarmerAction(context, raw, {
    model: baseline.model,
    threshold: baseline.threshold,
    seat,
    observe: (event) => {
      sink.event = event;
    },
  });
  const event = sink.event;
  const overrode = event !== null && event.overrode;
  return Object.freeze({
    raw,
    executed,
    overrode,
    executedIndex: overrode && event !== null ? event.rank : -1,
  });
}

/**
 * π1 for one seat: every other seat gets the production command back, object
 * for object, which is what makes "π1 is π0 plus one override" true by
 * construction rather than by inspection.
 */
export function cfPiPolicy(baseline: CfPiBaseline, seat: Seat): CfPolicy {
  return (context, productionCommand) =>
    cfPiDecision(context, productionCommand, seat, baseline).executed;
}

/**
 * One π1 group capture: visit, fork and continue under π1, take `b1` as the
 * reference, and keep the raw production action `b0` recorded alongside it so
 * the two can be told apart afterwards.
 *
 * The v1 machinery does the work — same eligibility rule, same keyed priority,
 * same per-group cap, same one-decision-per-fork accounting. Only the salt, the
 * dataset version and the policy differ, and all three are the round's frozen
 * values rather than caller-supplied.
 */
export function cfPiCaptureGroup(
  deck: readonly CardId[],
  spec: CfGroupSpec,
  baseline: CfPiBaseline,
): CfGroupResult {
  return cfCaptureGroup(deck, spec, {
    policyFor: (variant) => cfPiPolicy(baseline, variant.studiedSeat),
    snapshotSalt: CF_PI_SNAPSHOT_SALT,
    datasetVersion: CF_PI_DATASET_VERSION,
    recordRawProduction: true,
  });
}

// ---------------------------------------------------------------------------
// The runtime challenger (§5)
// ---------------------------------------------------------------------------

export type TwoLayerOptions = Readonly<{
  /** Frozen π1. Layer 1, and the arm this composition is measured against. */
  baselineModel: TreeModel;
  /** π2. Layer 2. */
  challengerModel: TreeModel;
  /** Exactly the frozen `0.01`, applied strictly in both layers. */
  threshold: number;
  /** The one seat this composition is bound to. */
  seat: Seat;
  /**
   * The shared proposal. Defaults to the frozen `cfProposal`; the guard
   * injects a counting wrapper around that same function so "one proposal, not
   * two" is a count of real calls rather than a number this module reports
   * about itself.
   */
  proposalOf?: (context: PlayContext) => CfProposal;
  /** Set false for a pure pass-through. */
  enabled?: boolean;
}>;

export type TwoLayerOutcome = Readonly<{
  /** What the composition plays. The caller's own object whenever it declines. */
  command: GameCommand;
  /** `cfProposal` calls made. One on the running path, zero on every decline. */
  proposals: number;
  /** Model traversals by layer 1. Zero whenever layer 1 did not run. */
  baselineRows: number;
  /** Model traversals by layer 2. Zero whenever layer 2 did not run. */
  challengerRows: number;
  /** `b0`'s index in `C`, or -1 when the whole composition declined. */
  rawIndex: number;
  /** `b1`'s index in `C`, or -1. */
  baselineIndex: number;
  /** The composition's chosen index in `C`, or -1. */
  challengerIndex: number;
  baselineOverrode: boolean;
  overrode: boolean;
}>;

const DECLINED: Omit<TwoLayerOutcome, "command"> = Object.freeze({
  proposals: 0,
  baselineRows: 0,
  challengerRows: 0,
  rawIndex: -1,
  baselineIndex: -1,
  challengerIndex: -1,
  baselineOverrode: false,
  overrode: false,
});

function decline(productionCommand: GameCommand): TwoLayerOutcome {
  return Object.freeze({ command: productionCommand, ...DECLINED });
}

/**
 * The two-layer farmer challenger, exactly as §5 states it:
 *
 * ```
 * b0 = the production command the caller already has
 * C  = cfProposal(context)                 ← once, shared by both layers
 * i0 = index of b0 in C                    ; -1 declines the whole thing
 * c1 = π1 scores C \ {b0}                  ; b1 = c1.overrode ? C[c1.index] : b0
 * c2 = π2 scores C \ {b1}                  ; out = c2.overrode ? C[c2.index] : b1
 * ```
 *
 * The fallback in the last line is the point of the whole exercise: a π2 that
 * declines must leave π1's action standing, not production's. Returning `b0`
 * there would be Gate A's experiment wearing this round's name.
 *
 * Ties go to the original `C` order in both layers — `cfScoreAlternatives`
 * scans from the front with a strict `>`, so the first strictly-greatest
 * candidate wins, which is the frozen rule rather than a re-statement of it.
 */
export function cfSelectTwoLayerFarmerAction(
  context: AiDecisionContext,
  productionCommand: GameCommand,
  options: TwoLayerOptions,
): TwoLayerOutcome {
  if (options.enabled === false || context.kind !== "play") {
    return decline(productionCommand);
  }
  const view = context.view;
  // Identity and role, both required — the same gate the frozen selector uses,
  // repeated here so a mis-bound call site cannot widen the blast radius.
  if (view.seat !== options.seat || view.seat === view.landlord) {
    return decline(productionCommand);
  }

  const proposalOf = options.proposalOf ?? cfProposal;
  const proposal = proposalOf(context);

  if (proposal.actions.length < 2) {
    return Object.freeze({ command: productionCommand, ...DECLINED, proposals: 1 });
  }
  const productionKey = cfCommandKey(productionCommand);
  const rawIndex = proposal.actions.findIndex(
    (action) => cfCommandKey(cfActionCommand(view.seat, action)) === productionKey,
  );
  if (rawIndex < 0) {
    // Production's own action is not among production's own shortlist. That
    // cannot happen on the shipped path, and guessing here would be worse than
    // declining.
    return Object.freeze({ command: productionCommand, ...DECLINED, proposals: 1 });
  }

  const baseline = cfScoreAlternatives(
    view, proposal, rawIndex, options.baselineModel, options.threshold);
  const baselineIndex = baseline.overrode ? baseline.index : rawIndex;
  const afterBaseline = proposal.actions[baselineIndex];
  if (afterBaseline === undefined) {
    return Object.freeze({ command: productionCommand, ...DECLINED, proposals: 1 });
  }

  const challenger = cfScoreAlternatives(
    view, proposal, baselineIndex, options.challengerModel, options.threshold);
  const challengerIndex = challenger.overrode ? challenger.index : baselineIndex;
  const chosen = proposal.actions[challengerIndex];
  if (chosen === undefined) {
    return Object.freeze({ command: productionCommand, ...DECLINED, proposals: 1 });
  }

  // `b1` is rebuilt only when layer 1 actually overrode. When it did not, `b1`
  // *is* the caller's production command — the frozen selector returns that
  // object itself — and rebuilding it would break the identity the landlord arm
  // and every declining root depend on.
  const command = challenger.overrode || baseline.overrode
    ? cfActionCommand(view.seat, chosen)
    : productionCommand;

  return Object.freeze({
    command,
    proposals: 1,
    baselineRows: baseline.scored,
    challengerRows: challenger.scored,
    rawIndex,
    baselineIndex,
    challengerIndex,
    baselineOverrode: baseline.overrode,
    overrode: challenger.overrode,
  });
}

/**
 * The composition in the form the tournament installs on one seat.
 *
 * `production.chooseCommand` is called exactly once per decision — the raw
 * production action is the input to layer 1, not something layer 2 goes and
 * gets again.
 */
export function createTwoLayerStrategy(
  production: AiStrategy,
  options: TwoLayerOptions,
): AiStrategy {
  return Object.freeze({
    chooseCommand(context: AiDecisionContext): GameCommand {
      const raw = production.chooseCommand(context);
      return cfSelectTwoLayerFarmerAction(context, raw, options).command;
    },
  });
}

/**
 * The paired baseline arm: the frozen selector and nothing else.
 *
 * Deliberately built from `cf-challenger.ts`'s shipped wrapper rather than from
 * anything in this file, so the arm the challenger is measured against is the
 * same code Gate B measured.
 */
export { createChallengerStrategy, createFrozenOverlay } from "./cf-challenger.js";

/** The frozen candidate width, re-exported so a guard can pin it without a second literal. */
export { CF_CANDIDATE_LIMIT };
