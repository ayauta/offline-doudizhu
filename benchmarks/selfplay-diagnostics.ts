/**
 * Diagnostics for the full-action Q models.
 *
 * The question this file exists to answer is not "how small is the regression
 * error". A model can drive that error to near zero by learning one number per
 * state — "this hand was going to win anyway" — and still rank the actions
 * inside a state at random, which is useless for a policy that has to choose
 * one. Three measurements separate those two possibilities:
 *
 *   - **within-state vs between-state dispersion.** If the scores of the legal
 *     actions at a fixed state barely differ, while the average score varies a
 *     lot across states, the model learned state strength and nothing else.
 *   - **how often the argmax leaves the behaviour policy**, and whether the
 *     actions it leaves to are ones the old candidate set never contained.
 *   - **the development counterfactual**: from one simulator state, force each
 *     of three actions and finish the game under one frozen continuation. If the
 *     model's ranking carries no action information, the arm it picks is no
 *     better than the arm a preregistered rule picks.
 *
 * Nothing here reads a hidden hand to choose which action to test, and nothing
 * here is allowed to feed back into a formal verdict. This is a development
 * diagnostic.
 */
import { scoreTrees, type TreeModel } from "../src/core/ai/cf-model.js";
import { cfProposal, CF_CANDIDATE_LIMIT } from "../src/app/ai/cf-selector.js";
import type { PlayDecisionContext } from "./selfplay-policy.js";
import { generateLegalActions, type ValidatedPlayAction } from "../src/core/rules/index.js";
import { actionIdentity } from "./selfplay-actions.js";
import { selfplayRowFromState, stateFeaturesOf } from "./selfplay-features.js";
import { argmaxAction } from "./selfplay-policy.js";
import type { DatasetRow } from "./selfplay-dataset.js";

export interface DispersonSummary {
  readonly states: number;
  readonly actionsPerState: number;
  /** Mean over states of the standard deviation of the scores inside the state. */
  readonly withinStateSd: number;
  /** Standard deviation over states of the state's mean score. */
  readonly betweenStateSd: number;
  /** `withinStateSd / betweenStateSd`. Near zero means "state strength only". */
  readonly ratio: number;
  /** Mean over states of max(score) - min(score). */
  readonly meanSpread: number;
  readonly meanTop: number;
  readonly meanBottom: number;
}

export function scoreAllActions(
  model: TreeModel,
  context: PlayDecisionContext,
): { readonly actions: readonly ValidatedPlayAction[]; readonly scores: readonly number[] } {
  const actions = context.legalActions;
  const state = stateFeaturesOf(context.view);
  const scores = actions.map((action) =>
    scoreTrees(model, selfplayRowFromState(context.view, state, action)),
  );
  return { actions, scores };
}

export function dispersionOf(
  model: TreeModel,
  contexts: readonly PlayDecisionContext[],
): DispersonSummary {
  const withinSds: number[] = [];
  const stateMeans: number[] = [];
  let spread = 0;
  let top = 0;
  let bottom = 0;
  let actionTotal = 0;

  for (const context of contexts) {
    const { scores } = scoreAllActions(model, context);
    if (scores.length === 0) {
      continue;
    }
    const mean = scores.reduce((sum, value) => sum + value, 0) / scores.length;
    const variance = scores.reduce((sum, value) => sum + (value - mean) ** 2, 0) / scores.length;
    withinSds.push(Math.sqrt(variance));
    stateMeans.push(mean);
    spread += Math.max(...scores) - Math.min(...scores);
    top += Math.max(...scores);
    bottom += Math.min(...scores);
    actionTotal += scores.length;
  }

  const states = stateMeans.length;

  if (states === 0) {
    return {
      states: 0,
      actionsPerState: Number.NaN,
      withinStateSd: Number.NaN,
      betweenStateSd: Number.NaN,
      ratio: Number.NaN,
      meanSpread: Number.NaN,
      meanTop: Number.NaN,
      meanBottom: Number.NaN,
    };
  }

  const meanOf = (values: readonly number[]): number =>
    values.reduce((sum, value) => sum + value, 0) / values.length;
  const sdOf = (values: readonly number[]): number => {
    const mean = meanOf(values);
    return Math.sqrt(meanOf(values.map((value) => (value - mean) ** 2)));
  };

  const meanWithin = meanOf(withinSds);
  const betweenStateSd = sdOf(stateMeans);
  return {
    states,
    actionsPerState: actionTotal / states,
    withinStateSd: meanWithin,
    betweenStateSd,
    ratio: meanWithin / betweenStateSd,
    meanSpread: spread / states,
    meanTop: top / states,
    meanBottom: bottom / states,
  };
}

export interface PolicyChangeSummary {
  readonly decisions: number;
  readonly changedFromGreedy: number;
  readonly chosenOutsideC3: number;
  readonly chosenOutsideC5: number;
  readonly withProposal: number;
  readonly meanLegalActions: number;
  readonly byRole: Readonly<Record<string, { decisions: number; changed: number }>>;
  readonly byStage: Readonly<Record<string, { decisions: number; changed: number }>>;
}

/** Stage buckets by the learning seat's own decision index within the episode. */
export function stageOf(seatDecisionIndex: number): string {
  if (seatDecisionIndex < 4) {
    return "opening";
  }
  if (seatDecisionIndex < 9) {
    return "middle";
  }
  return "endgame";
}

/**
 * A row's `greedyActionIdentity` is what the behaviour policy would have played
 * at that state, so "did the model change the action" needs no second policy
 * run — the collector already recorded the comparison's other side.
 */
export function policyChangeOf(
  model: TreeModel,
  rows: readonly DatasetRow[],
  options: { readonly auditProposal: boolean },
): PolicyChangeSummary {
  let changed = 0;
  let outsideC3 = 0;
  let outsideC5 = 0;
  let withProposal = 0;
  let legalTotal = 0;
  const byRole: Record<string, { decisions: number; changed: number }> = {};
  const byStage: Record<string, { decisions: number; changed: number }> = {};

  for (const row of rows) {
    const view = viewFromRow(row);
    const actions = generateLegalActions({ hand: view.hand, currentPlay: view.currentPlay });
    const context: PlayDecisionContext = Object.freeze({
      kind: "play",
      view,
      legalActions: actions,
    });
    const { scores } = scoreAllActions(model, context);
    const chosen = actionIdentity(actions[argmaxAction(scores)]!);
    legalTotal += actions.length;

    const role = row.provenance.role;
    const stage = stageOf(row.provenance.seatDecisionIndex);
    byRole[role] = byRole[role] ?? { decisions: 0, changed: 0 };
    byStage[stage] = byStage[stage] ?? { decisions: 0, changed: 0 };
    byRole[role]!.decisions += 1;
    byStage[stage]!.decisions += 1;

    if (chosen !== row.provenance.greedyActionIdentity) {
      changed += 1;
      byRole[role]!.changed += 1;
      byStage[stage]!.changed += 1;
    }

    if (options.auditProposal) {
      const proposal = proposalOf(context);
      if (proposal !== null) {
        withProposal += 1;
        if (!proposal.c3.has(chosen)) {
          outsideC3 += 1;
        }
        if (!proposal.c5.has(chosen)) {
          outsideC5 += 1;
        }
      }
    }
  }

  return {
    decisions: rows.length,
    changedFromGreedy: changed,
    chosenOutsideC3: outsideC3,
    chosenOutsideC5: outsideC5,
    withProposal,
    meanLegalActions: rows.length === 0 ? Number.NaN : legalTotal / rows.length,
    byRole,
    byStage,
  };
}

function proposalOf(context: PlayDecisionContext): {
  readonly c3: ReadonlySet<string>;
  readonly c5: ReadonlySet<string>;
} | null {
  try {
    const proposal = cfProposal(context);
    return {
      c3: new Set(
        proposal.actions.slice(0, CF_CANDIDATE_LIMIT).map((action) => actionIdentity(action)),
      ),
      c5: new Set(proposal.actions.map((action) => actionIdentity(action))),
    };
  } catch {
    return null;
  }
}

function viewFromRow(row: DatasetRow): PlayDecisionContext["view"] {
  return row.view;
}

/** Mean-squared error of the model on rows it was not fitted on. */
export function regressionError(
  model: TreeModel,
  rows: readonly DatasetRow[],
): { readonly mse: number; readonly constantBaselineMse: number; readonly mean: number } {
  if (rows.length === 0) {
    return { mse: Number.NaN, constantBaselineMse: Number.NaN, mean: Number.NaN };
  }
  let sum = 0;
  for (const row of rows) {
    sum += row.reward;
  }
  const mean = sum / rows.length;
  let squared = 0;
  let baseline = 0;
  for (const row of rows) {
    const view = viewFromRow(row);
    const actions = generateLegalActions({ hand: view.hand, currentPlay: view.currentPlay });
    const executed =
      actions.find((action) => actionIdentity(action) === row.provenance.executedActionIdentity) ??
      null;
    if (executed === null) {
      continue;
    }
    const state = stateFeaturesOf(view);
    const predicted = scoreTrees(model, selfplayRowFromState(view, state, executed));
    squared += (predicted - row.reward) ** 2;
    baseline += (mean - row.reward) ** 2;
  }
  return {
    mse: squared / rows.length,
    constantBaselineMse: baseline / rows.length,
    mean,
  };
}
