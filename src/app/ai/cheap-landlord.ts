/**
 * The frozen CHEAP landlord policy, in the application layer because the
 * shipped Worker runs it.
 *
 * It sits here rather than in `benchmarks/` for the reason
 * `src/app/ai/cf-selector.ts` states about the farmer selector: there must be
 * exactly one implementation. The 403-column schema it builds rows from lives
 * in `src/core/ai/fa-features.ts` and is shared with the research harness, so
 * "the policy the confirmation measured" and "the policy the product runs"
 * cannot drift by a feature definition.
 *
 * What is deliberately *not* here:
 *
 *   - **No candidate shortlist.** The policy scores every action in
 *     `context.legalActions`, which the session fills with production's own
 *     `generateLegalActions` call. Nothing calls `rankMasterPlayActions` or
 *     `cfProposal`, so the old top-three filter, the expert anchor and the
 *     `defaultPolicyPrior` re-ranking are not merely bypassed — they are never
 *     computed. There is no path by which they could reach the choice.
 *   - **No blend with the incumbent.** The chosen action replaces the
 *     production command or nothing does. A score is never mixed into
 *     `expertScore`.
 *   - **No internal deadline.** The scoring pass is atomic: stopping it
 *     half-way yields a table of scores whose maximum is not the policy's
 *     answer, which is a different policy, not a cheaper one. The real
 *     deadline is the client's response budget, and it is enforced one layer
 *     up by `enhanced-ai-turn.ts`, exactly as it is for master today.
 *   - **No silent fallback.** Every refusal is a named reason on the returned
 *     decision, so a caller can count them separately instead of inferring
 *     them from a command that looks plausible.
 */
import type { CardId } from "../../core/cards/index.js";
import type { GameCommand, Seat } from "../../core/game/index.js";
import type { ValidatedPlayAction } from "../../core/rules/index.js";
import type { AiDecisionContext } from "../../core/ai/index.js";
import { scoreTrees, type TreeModel } from "../../core/ai/cf-model.js";
import {
  selfplayRowFromState,
  stateFeaturesOf,
  type SelfPlayStateFeatures,
} from "../../core/ai/fa-features.js";

/**
 * The identity of the rule this module implements. Bumping it is a policy
 * change, not a refactor: the confirmation measured this rule.
 */
export const CHEAP_LANDLORD_POLICY_VERSION = "fa-landlord-v1";

/**
 * The frozen argmax.
 *
 * Strict `>` keeps the **earliest** index on a tie, which — because
 * `context.legalActions` arrives in `generateLegalActions` order — is the
 * frozen tie-break. It is written as a loop rather than `reduce`/`Math.max`
 * because both of those hand the tie to a different index and neither says so.
 */
export function landlordArgmax(scores: readonly number[]): number {
  let best = 0;
  for (let index = 1; index < scores.length; index += 1) {
    const candidate = scores[index] ?? Number.NEGATIVE_INFINITY;
    const incumbent = scores[best] ?? Number.NEGATIVE_INFINITY;
    if (candidate > incumbent) {
      best = index;
    }
  }
  return best;
}

/** `action -> GameCommand`, the same shape the farmer selector returns. */
export function landlordActionCommand(seat: Seat, action: ValidatedPlayAction): GameCommand {
  return action.type === "pass"
    ? Object.freeze({ type: "pass" as const, seat })
    : Object.freeze({
        type: "play" as const,
        seat,
        cards: Object.freeze([...action.play.cards]) as readonly CardId[],
      });
}

/**
 * Why the policy declined. Every one of these is an operational failure or a
 * scope test; none of them is "the incumbent looked better".
 */
export type LandlordDeclineReason =
  /** The context is a bid, or the seat is not the landlord. Not a failure. */
  | "out-of-scope"
  /** No model was supplied or it failed to load. */
  | "model-unavailable"
  /** The session handed an empty legal-action set, which no real decision has. */
  | "empty-legal-set"
  /** A row did not match the model's declared width. The schema is wrong. */
  | "schema-mismatch"
  /** Scoring threw for any other reason. */
  | "scoring-failed";

export type LandlordDecisionTiming = Readonly<{
  /** Producing the 403-column row for one action, summed over all actions. */
  featureMs: number;
  /** `scoreTrees` over every row, summed. */
  inferenceMs: number;
  /** Argument selection and command construction, excluding the two above. */
  selectMs: number;
}>;

export type CheapLandlordDecision =
  | Readonly<{
      kind: "cheap";
      command: GameCommand;
      /** Index into `context.legalActions` of the played action. */
      chosenIndex: number;
      /** How many actions were scored — the full legal set, never a shortlist. */
      scored: number;
      scores: readonly number[];
      /** Gap between the best and second-best score; `Infinity` with one action. */
      margin: number;
      timing: LandlordDecisionTiming;
    }>
  | Readonly<{
      kind: "declined";
      reason: LandlordDeclineReason;
      timing: LandlordDecisionTiming;
    }>;

export type CheapLandlordOptions = Readonly<{
  model: TreeModel;
  /**
   * The model digest, carried so a caller can assert it is the confirmed one.
   * It is never a feature and never reaches a score.
   */
  modelSha256: string;
}>;

const ZERO_TIMING: LandlordDecisionTiming = Object.freeze({
  featureMs: 0,
  inferenceMs: 0,
  selectMs: 0,
});

function declines(reason: LandlordDeclineReason): CheapLandlordDecision {
  return Object.freeze({ kind: "declined" as const, reason, timing: ZERO_TIMING });
}

/**
 * The landlord's decision, as a pure function of the visible context and the
 * frozen model.
 *
 * Returns a decision rather than a command so that "the policy played this"
 * and "the policy could not answer" are different values. A caller that only
 * wants the command must handle the declined case explicitly.
 */
export function cheapLandlordDecision(
  context: AiDecisionContext,
  options: CheapLandlordOptions,
): CheapLandlordDecision {
  if (context.kind !== "play") {
    return declines("out-of-scope");
  }
  const view = context.view;
  if (view.seat !== view.landlord) {
    return declines("out-of-scope");
  }
  const model = options.model;
  if (model === undefined || model === null) {
    return declines("model-unavailable");
  }
  const actions = context.legalActions;
  if (actions.length === 0) {
    return declines("empty-legal-set");
  }

  const selectStart = performance.now();
  let state: SelfPlayStateFeatures;
  try {
    state = stateFeaturesOf(view);
  } catch {
    return declines("scoring-failed");
  }

  const scores: number[] = [];
  let featureMs = 0;
  let inferenceMs = 0;
  for (const action of actions) {
    const featureStart = performance.now();
    let row: readonly number[];
    try {
      row = selfplayRowFromState(view, state, action);
    } catch {
      return declines("scoring-failed");
    }
    const inferenceStart = performance.now();
    featureMs += inferenceStart - featureStart;
    // `scoreTrees` walks whatever width it is handed; it does not know how wide
    // a row should be. A model built on another schema would not fail — it
    // would read the wrong columns and return a confident number. This is the
    // only place a full-action policy can catch that, so it does, and it
    // declines rather than guessing.
    if (row.length !== model.numFeatures) {
      return declines("schema-mismatch");
    }
    let score: number;
    try {
      score = scoreTrees(model, row);
    } catch {
      return declines("scoring-failed");
    }
    inferenceMs += performance.now() - inferenceStart;
    scores.push(score);
  }

  const chosenIndex = landlordArgmax(scores);
  const chosen = actions[chosenIndex];
  if (chosen === undefined) {
    return declines("scoring-failed");
  }
  const best = scores[chosenIndex] ?? Number.NEGATIVE_INFINITY;
  let second = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < scores.length; index += 1) {
    if (index === chosenIndex) {
      continue;
    }
    const value = scores[index] ?? Number.NEGATIVE_INFINITY;
    if (value > second) {
      second = value;
    }
  }
  const selectMs = performance.now() - selectStart - featureMs - inferenceMs;
  return Object.freeze({
    kind: "cheap" as const,
    command: landlordActionCommand(view.seat, chosen),
    chosenIndex,
    scored: actions.length,
    scores: Object.freeze(scores),
    margin: second === Number.NEGATIVE_INFINITY ? Number.POSITIVE_INFINITY : best - second,
    timing: Object.freeze({ featureMs, inferenceMs, selectMs }),
  });
}
