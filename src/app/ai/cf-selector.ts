/**
 * The frozen Phase 2 farmer selector, in the application layer because the
 * shipped Worker runs it.
 *
 * It sits here rather than in `benchmarks/` for one reason: there is exactly
 * one implementation. The corpus generator, the Gate A/B benchmarks and the
 * product all call this function, so "the selector the experiment measured" and
 * "the selector the product runs" cannot drift apart — they are the same file.
 *
 * The rules are the ones frozen by
 * `docs/specs/062-counterfactual-policy-improvement/spec.md`:
 *
 *   - the candidate set is production's own shortlist, top three, recorded
 *     order, never widened and never re-scored;
 *   - `a0` is whatever production actually chose, and it must be one of them;
 *   - the model's score replaces the choice. It is never blended back into
 *     `expertScore`, which continues to do the only job it has here — propose;
 *   - the override is a **strict** `score > threshold`;
 *   - ties go to the lower production candidate order.
 *
 * Everything it cannot answer for itself, it declines: a shortlist with no
 * alternative, an action that is not in its own shortlist, a non-farmer seat, a
 * seat that is not the one it was bound to. Declining returns the production
 * command object itself, never a rebuild of it.
 */
import type { CardId } from "../../core/cards/index.js";
import type { GameCommand, Seat } from "../../core/game/index.js";
import type { ValidatedPlayAction } from "../../core/rules/index.js";
import type { AiDecisionContext, PlayingPlayerView } from "../../core/ai/index.js";
import { rankPlayActionsWithProposal } from "../../core/ai/scoring-policy.js";
import { cfRow } from "../../core/ai/cf-features.js";
import { scoreTrees, type TreeModel } from "../../core/ai/cf-model.js";

// Re-exported so the platform worker can reach the evaluator through the
// application layer; platform adapters must not import `core` directly.
export { parseTreeModel, scoreTrees, type TreeModel } from "../../core/ai/cf-model.js";
import { ENHANCED_AI_SEARCH } from "./decision-handler.js";

type PlayContext = Extract<AiDecisionContext, { readonly kind: "play" }>;

/** Mirrors the literal in `master-policy.ts` (`expert.slice(0, 3)`). */
export const CF_CANDIDATE_LIMIT = 3;

export type CfProposal = Readonly<{
  /** The shipped expert shortlist, in the shipped ordering, capped at 3. */
  actions: readonly ValidatedPlayAction[];
  /** Diagnostic storage only. Never a feature. */
  anchoredScores: readonly number[];
  baseScores: readonly number[];
}>;

/** A canonical identity for a command: card order carries no meaning. */
export function cfCommandKey(command: GameCommand): string {
  switch (command.type) {
    case "pass":
      return "pass";
    case "play":
      return [...command.cards].sort((left, right) => left - right).join(",");
    case "deal":
      return "deal";
    case "bid":
      return `bid:${command.seat}:${command.decision}`;
    case "restart":
      return "restart";
  }
}

export function cfActionCommand(seat: Seat, action: ValidatedPlayAction): GameCommand {
  return action.type === "pass"
    ? Object.freeze({ type: "pass" as const, seat })
    : Object.freeze({
        type: "play" as const,
        seat,
        cards: Object.freeze([...action.play.cards]) as readonly CardId[],
      });
}

/**
 * Production's own shortlist: the expert ranking's top three, in the shipped
 * ordering. Nothing here re-scores, re-orders or widens it.
 */
export function cfProposal(context: PlayContext): CfProposal {
  const proposal = rankPlayActionsWithProposal(context, "expert", {
    analyzerNodes: ENHANCED_AI_SEARCH.rootAnalyzerNodes,
  });
  const top = proposal.anchored.slice(0, CF_CANDIDATE_LIMIT);
  const actions: ValidatedPlayAction[] = [];
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

/**
 * What the selector saw when it decided. Optional: the benchmark collects it,
 * the product passes nothing. Keeping it here rather than in the benchmark is
 * what lets one loop serve both.
 */
export type SelectorEvent = Readonly<{
  seat: Seat;
  proposalMs: number;
  featureMs: number;
  inferenceMs: number;
  /** True when the shortlist offered something to compare against. */
  eligible: boolean;
  overrode: boolean;
  /** Production candidate order of the chosen action, or -1 when declining. */
  rank: number;
  score: number;
  threshold: number;
  minRemaining: number;
  farmerPosition: number;
}>;

export type FarmerSelectorOptions = Readonly<{
  model: TreeModel;
  threshold: number;
  /**
   * The seat this selector is bound to. Activation requires both this identity
   * and the farmer role: a global "is a farmer" test would change the other
   * farmer too and break the landlord arm's invariance.
   */
  seat: Seat;
  observe?: (event: SelectorEvent) => void;
  /** Set false for a pure pass-through. */
  enabled?: boolean;
}>;

function farmerPositionOf(view: PlayingPlayerView): number {
  const seats: readonly Seat[] = ["human", "ai-one", "ai-two"];
  return (seats.indexOf(view.seat) - seats.indexOf(view.landlord) + 3) % 3;
}

function minRemainingOf(view: PlayingPlayerView): number {
  return Math.min(
    view.remainingCardCounts.human,
    view.remainingCardCounts["ai-one"],
    view.remainingCardCounts["ai-two"],
  );
}

/**
 * The override decision, as a pure function of the visible context and the
 * production command.
 */
export function cfSelectFarmerAction(
  context: AiDecisionContext,
  productionCommand: GameCommand,
  options: FarmerSelectorOptions,
): GameCommand {
  const observe = options.observe;
  if (options.enabled === false || context.kind !== "play") {
    return productionCommand;
  }
  const view = context.view;
  // Identity and role, both required. The identity half is also enforced by the
  // caller binding this to one seat; it is repeated here so a mis-bound call
  // site cannot silently widen the blast radius.
  if (view.seat !== options.seat || view.seat === view.landlord) {
    return productionCommand;
  }

  const proposalStart = performance.now();
  const proposal = cfProposal(context);
  const proposalEnd = performance.now();
  const proposalMs = proposalEnd - proposalStart;

  const report = (event: Omit<SelectorEvent, "seat" | "proposalMs" | "featureMs" |
    "inferenceMs" | "threshold" | "minRemaining" | "farmerPosition">): void => {
    observe?.(Object.freeze({
      seat: view.seat,
      proposalMs,
      featureMs: 0,
      inferenceMs: 0,
      threshold: options.threshold,
      minRemaining: minRemainingOf(view),
      farmerPosition: farmerPositionOf(view),
      ...event,
    }));
  };

  if (proposal.actions.length < 2) {
    report({ eligible: false, overrode: false, rank: -1, score: 0 });
    return productionCommand;
  }
  const productionKey = cfCommandKey(productionCommand);
  const productionIndex = proposal.actions.findIndex(
    (action) => cfCommandKey(cfActionCommand(view.seat, action)) === productionKey,
  );
  if (productionIndex < 0) {
    // Production's action is not among its own shortlist. That cannot happen on
    // the shipped path, and guessing here would be worse than declining.
    report({ eligible: false, overrode: false, rank: -1, score: 0 });
    return productionCommand;
  }
  const reference = proposal.actions[productionIndex];
  if (reference === undefined) {
    report({ eligible: false, overrode: false, rank: -1, score: 0 });
    return productionCommand;
  }

  let bestIndex = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  let featureMs = 0;
  let inferenceMs = 0;
  for (let index = 0; index < proposal.actions.length; index += 1) {
    if (index === productionIndex) {
      continue;
    }
    const action = proposal.actions[index];
    if (action === undefined) {
      continue;
    }
    const featureStart = performance.now();
    const row = cfRow(view, action, reference);
    const inferenceStart = performance.now();
    const score = scoreTrees(options.model, row);
    const end = performance.now();
    featureMs += inferenceStart - featureStart;
    inferenceMs += end - inferenceStart;
    // Strict `>` keeps the first maximum, which — because the candidates arrive
    // in production candidate order — is the frozen tie-break.
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  const overrode = bestIndex >= 0 && bestScore > options.threshold;
  observe?.(Object.freeze({
    seat: view.seat,
    proposalMs,
    featureMs,
    inferenceMs,
    eligible: true,
    overrode,
    rank: overrode ? bestIndex : -1,
    score: bestScore,
    threshold: options.threshold,
    minRemaining: minRemainingOf(view),
    farmerPosition: farmerPositionOf(view),
  }));

  if (!overrode) {
    return productionCommand;
  }
  const chosen = proposal.actions[bestIndex];
  return chosen === undefined ? productionCommand : cfActionCommand(view.seat, chosen);
}
