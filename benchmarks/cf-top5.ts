/**
 * Spec 065: the counterfactual candidate interface widened from top3 to top5.
 *
 * This is a new mechanism family, not a variation of Spec 064. The champion
 * stays frozen π1 at `ai-v1`, and the only thing that changes is how many
 * candidates the *challenger's* layer is allowed to see.
 *
 * Everything here rests on one property of the shipped ranking, and it is worth
 * stating precisely because the whole experiment is meaningless without it:
 *
 *   `cfProposal` calls `rankPlayActionsWithProposal`, which scores the **full**
 *   legal action set, and only then does `anchored.slice(0, CF_CANDIDATE_LIMIT)`.
 *   The per-action analyzer budget is `floor(analyzerNodes / legalActions.length)`
 *   (see `evaluateLegalActions`), so it does not depend on the limit either.
 *
 * Therefore `anchored.slice(0, 5)` **extends** `anchored.slice(0, 3)` rather
 * than replacing it, and `C3` is exactly the first three entries of `C5`. That
 * is what lets π1 keep its byte-identical behaviour while the challenger's
 * horizon widens — and `cfTop5IncludesTop3` asserts it rather than assuming it.
 *
 * **`src/` is not touched.** The top5 proposal is built here, in the benchmark,
 * from `rankPlayActionsWithProposal`, which `src/core` already exports. The
 * shipped `cfProposal` and `CF_CANDIDATE_LIMIT` are read, never modified, and
 * the worker keeps its top3 behaviour exactly.
 */
import type { AiDecisionContext } from "../src/core/ai/index.js";
import { rankPlayActionsWithProposal } from "../src/core/ai/scoring-policy.js";
import {
  CF_CANDIDATE_LIMIT,
  cfActionCommand,
  cfCommandKey,
  cfProposal,
  cfScoreAlternatives,
  type CfAlternativeChoice,
  type CfProposal,
  type TreeModel,
} from "../src/app/ai/cf-selector.js";
import { ENHANCED_AI_SEARCH } from "../src/app/ai/decision-handler.js";
import type { CardId } from "../src/core/cards/index.js";
import { cfCaptureGroup, type CfGroupResult, type CfGroupSpec } from "./cf-dataset.js";
import { cfPiPolicy } from "./cf-policy-iteration.js";
import type { GameCommand, Seat } from "../src/core/game/index.js";

type PlayContext = Extract<AiDecisionContext, { readonly kind: "play" }>;

/** The round's widened interface. Spec 065 §5: this value is the variable. */
export const CF_TOP5_LIMIT = 5;

/** π1's horizon, pinned to the shipped limit rather than retyped. */
export const CF_TOP3_LIMIT = CF_CANDIDATE_LIMIT;

/**
 * The top-`limit` candidates from the same ranking the shipped selector uses.
 *
 * `limit` is explicit because this module needs both widths: five for the
 * challenger's layer, three for π1's. Building them from one call rather than
 * two is what makes "the two layers share one proposal" true by construction
 * instead of by bookkeeping.
 */
export function cfProposalN(context: PlayContext, limit: number): CfProposal {
  const proposal = rankPlayActionsWithProposal(context, "expert", {
    analyzerNodes: ENHANCED_AI_SEARCH.rootAnalyzerNodes,
  });
  const top = proposal.anchored.slice(0, limit);
  const actions: CfProposal["actions"][number][] = [];
  const anchoredScores: number[] = [];
  const baseScores: number[] = [];
  for (const entry of top) {
    const detail = proposal.details.find((candidate) => candidate.action === entry.action);
    actions.push(entry.action);
    anchoredScores.push(entry.score);
    baseScores.push(detail?.baseScore ?? entry.score);
  }
  return Object.freeze({
    actions: Object.freeze(actions),
    anchoredScores: Object.freeze(anchoredScores),
    baseScores: Object.freeze(baseScores),
  });
}

/** The five-wide counterfactual proposal. */
export function cfProposal5(context: PlayContext): CfProposal {
  return cfProposalN(context, CF_TOP5_LIMIT);
}

/**
 * The first three candidates of `proposal`, as a proposal in their own right.
 *
 * π1 must be offered exactly `C3`, so the layers cannot simply be handed `C5`
 * with a smaller bound: `cfScoreAlternatives` walks whatever proposal it is
 * given. A prefix slice is a valid `CfProposal`, and because it is a *prefix*,
 * an index into it is also the index into `C5` — which is what keeps the two
 * layers' coordinates interchangeable.
 */
export function cfTop3Prefix(proposal: CfProposal): CfProposal {
  return Object.freeze({
    actions: Object.freeze(proposal.actions.slice(0, CF_TOP3_LIMIT)),
    anchoredScores: Object.freeze(proposal.anchoredScores.slice(0, CF_TOP3_LIMIT)),
    baseScores: Object.freeze(proposal.baseScores.slice(0, CF_TOP3_LIMIT)),
  });
}

/**
 * Spec 065 §7.19 — the widened set really is a superset of the frozen one.
 *
 * Compares `C5`'s first three candidates against the **shipped** `cfProposal`
 * command for command. This is the load-bearing assumption of the whole round:
 * if it ever fails, the thing that changed is the ranking rather than the
 * width, and π1 is no longer π1.
 */
export function cfTop5IncludesTop3(context: PlayContext, proposal5?: CfProposal): boolean {
  const shipped = cfProposal(context);
  const five = proposal5 ?? cfProposal5(context);
  if (five.actions.length < shipped.actions.length) {
    return false;
  }
  return shipped.actions.every((action, index) => {
    const widened = five.actions[index];
    return widened !== undefined &&
      cfCommandKey(cfActionCommand(context.view.seat, widened)) ===
        cfCommandKey(cfActionCommand(context.view.seat, action));
  });
}

/** Index of the production command among `proposal`'s candidates, or -1. */
function indexOfCommand(
  proposal: CfProposal,
  seat: Seat,
  command: GameCommand,
): number {
  const key = cfCommandKey(command);
  return proposal.actions.findIndex(
    (action) => cfCommandKey(cfActionCommand(seat, action)) === key,
  );
}

export type Top5Options = Readonly<{
  /** Frozen π1. Layer 1, and the arm this composition is measured against. */
  baselineModel: TreeModel;
  /** The top5-trained model. Layer 2. */
  challengerModel: TreeModel;
  /** Exactly the frozen `0.01`, applied strictly in both layers. */
  threshold: number;
  /** The one seat this composition is bound to. */
  seat: Seat;
  /** The shared five-wide proposal. Counted by the guard. */
  proposalOf?: (context: PlayContext) => CfProposal;
  enabled?: boolean;
}>;

export type Top5Outcome = Readonly<{
  /** What the composition plays. The caller's own object whenever it declines. */
  command: GameCommand;
  /** Candidate-set computations. One on the running path, zero on every decline. */
  proposals: number;
  /** π1-layer traversals. Zero whenever `b0` is not in `C3`. */
  baselineRows: number;
  /** π2-layer traversals. */
  challengerRows: number;
  /** `b0`'s index in `C5`, or -1 when the whole composition declined. */
  rawIndex: number;
  /** `b0`'s index in `C3`, or -1 — π1 cannot see past the third candidate. */
  rawIndexTop3: number;
  /** `b1`'s index in `C5`, or -1. */
  baselineIndex: number;
  /** True only when `b0` was inside `C3` and π1 replaced it. */
  baselineOverrode: boolean;
  /** The composition's chosen index in `C5`, or -1. */
  challengerIndex: number;
  overrode: boolean;
}>;

const DECLINED: Omit<Top5Outcome, "command"> = Object.freeze({
  proposals: 0,
  baselineRows: 0,
  challengerRows: 0,
  rawIndex: -1,
  rawIndexTop3: -1,
  baselineIndex: -1,
  baselineOverrode: false,
  challengerIndex: -1,
  overrode: false,
});

function decline(productionCommand: GameCommand): Top5Outcome {
  return Object.freeze({ command: productionCommand, ...DECLINED });
}

/**
 * The two-layer challenger over a five-wide candidate set (Spec 065 §4):
 *
 * ```
 * b0 = the production command the caller already has
 * C5 = cfProposal5(context)                ← once, shared by both layers
 * C3 = C5[0..2]                            ← π1's horizon, unchanged from ai-v1
 * i0 = index of b0 in C5                   ; -1 declines the whole thing
 * c1 = π1 scores C3 \ {b0}                 ; b1 = c1.overrode ? C3[c1.index] : b0
 * c2 = π2 scores C5 \ {b1}                 ; out = c2.overrode ? C5[c2.index] : b1
 * ```
 *
 * The one subtle case is `b0 ∉ C3` while `b0 ∈ C5`. π1 is offered `C3` and
 * nothing else, so it cannot see a production action sitting at index 3 or 4:
 * it declines exactly as it always did, and `b1` stays `b0`. The challenger's
 * layer is still given all of `C5 \ {b0}`, which is precisely where the fourth
 * and fifth candidates get their chance. Letting π1 peek at them instead would
 * change π1, and π1 is the comparator.
 */
export function cfSelectTop5FarmerAction(
  context: AiDecisionContext,
  productionCommand: GameCommand,
  options: Top5Options,
): Top5Outcome {
  if (options.enabled === false || context.kind !== "play") {
    return decline(productionCommand);
  }
  const view = context.view;
  // Identity and role, both required — the same gate the frozen selector uses.
  if (view.seat !== options.seat || view.seat === view.landlord) {
    return decline(productionCommand);
  }

  const proposalOf = options.proposalOf ?? cfProposal5;
  const proposal = proposalOf(context);

  if (proposal.actions.length < 2) {
    return Object.freeze({ command: productionCommand, ...DECLINED, proposals: 1 });
  }
  const rawIndex = indexOfCommand(proposal, view.seat, productionCommand);
  if (rawIndex < 0) {
    // Production's own action is not among production's own shortlist. That
    // cannot happen on the shipped path, and guessing would be worse.
    return Object.freeze({ command: productionCommand, ...DECLINED, proposals: 1 });
  }

  const top3 = cfTop3Prefix(proposal);
  const rawIndexTop3 = indexOfCommand(top3, view.seat, productionCommand);

  let baseline: CfAlternativeChoice | null = null;
  if (rawIndexTop3 >= 0) {
    baseline = cfScoreAlternatives(
      view, top3, rawIndexTop3, options.baselineModel, options.threshold);
  }
  const baselineIndex = baseline !== null && baseline.overrode ? baseline.index : rawIndex;
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

  // Rebuild only when a layer actually moved. When neither did, `b1` *is* the
  // caller's production command — the frozen selector returns that object
  // itself — and rebuilding it would break the identity the landlord arm and
  // every declining root depend on.
  const command = challenger.overrode || (baseline?.overrode ?? false)
    ? cfActionCommand(view.seat, chosen)
    : productionCommand;

  return Object.freeze({
    command,
    proposals: 1,
    baselineRows: baseline?.scored ?? 0,
    challengerRows: challenger.scored,
    rawIndex,
    rawIndexTop3,
    baselineIndex,
    baselineOverrode: baseline?.overrode ?? false,
    challengerIndex,
    overrode: challenger.overrode,
  });
}

// ---------------------------------------------------------------------------
// Spec 065 corpus plumbing
// ---------------------------------------------------------------------------

/**
 * A top5 corpus is not a top3 corpus and must never be read as one. The row
 * schema is identical by construction — that is the point — so the *provenance*
 * is what keeps them apart.
 */
export const CF_TOP5_DATASET_VERSION = 4;

/** This round's salts. Reusing Spec 064's would resample the same roots. */
export const CF_TOP5_SPLIT_SALT = "spec065-top5-split";
export const CF_TOP5_SNAPSHOT_SALT = "spec065-top5-snapshot";

export type CfTop5Baseline = Readonly<{
  model: TreeModel;
  /** Exactly the frozen artifact's `0.01`, imported, never retyped. */
  threshold: number;
}>;

/**
 * One top5 group capture.
 *
 * The visit, the reference and the continuation are **frozen π1** — the same
 * policy constructor Spec 064 uses, because π1 is the same champion. The single
 * difference from `cfPiCaptureGroup` is `proposalFor: cfProposal5`: the
 * snapshot's candidate set is five wide instead of three.
 *
 * Note the asymmetry that makes the experiment meaningful: π1 *inside* the walk
 * still computes its own top3 proposal through `cfSelectFarmerAction`, so the
 * games being visited are the games ai-v1 would play. Only the data collected
 * at each root is wider.
 */
export function cfTop5CaptureGroup(
  deck: readonly CardId[],
  spec: CfGroupSpec,
  baseline: CfTop5Baseline,
): CfGroupResult {
  return cfCaptureGroup(deck, spec, {
    policyFor: (variant) => cfPiPolicy(baseline, variant.studiedSeat),
    proposalFor: cfProposal5,
    snapshotSalt: CF_TOP5_SNAPSHOT_SALT,
    datasetVersion: CF_TOP5_DATASET_VERSION,
    recordRawProduction: true,
  });
}
