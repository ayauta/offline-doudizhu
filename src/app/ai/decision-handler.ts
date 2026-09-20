import {
  EXPERT_AI_STRATEGY,
  SCORING_CASUAL_AI_STRATEGY,
  rankMasterPlayActions,
  rankScoredPlayActions,
} from "../../core/ai/enhanced.js";
import type {
  AiDecisionContext,
  AiStrategy,
} from "../../core/ai/index.js";
import type { GameCommand } from "../../core/game/index.js";
import type {
  AiDecisionOutcome,
  EnhancedAiType,
} from "../ports/ai-decision-service.js";

export const ENHANCED_AI_BUDGET_MS: Readonly<Record<EnhancedAiType, number>> =
  Object.freeze({
    casual: 16,
    master: 120,
  });

/**
 * Master's rollout sizing, named and exported because more than the handler
 * reads it: the benchmark's world-cap canary and the device probe both measure
 * against it. An inline literal here is how a shipped size and its check drift
 * apart silently.
 *
 * 8 worlds, not the 32 an earlier tier shipped. Two paired-deal measurements
 * put it here (both in docs/research/ai-experiment-results.md): cutting
 * 32 → 8 → 4 moves the win rate by −0.17pp [−0.62, +0.29] and −0.42pp
 * [−1.08, +0.25] over 400 deals, inside the harness's own resolution, while the
 * target phone wants ~208 ms for 32 worlds against a 120 ms budget and ~45 ms
 * for 8.
 *
 * The sample count is therefore a cost cap, not a strength knob. Do not derive
 * it from the budget: `shouldContinue` already truncates the rollout at runtime,
 * so deriving one from the other would encode the time cap twice.
 */
export const ENHANCED_AI_SEARCH = Object.freeze({
  maxWorlds: 8,
  rolloutDepth: 3,
  rootAnalyzerNodes: 220,
} as const);

export type EnhancedAiWorkerRequest = Readonly<{
  requestId: number;
  aiType: EnhancedAiType;
  context: AiDecisionContext;
  seed: number;
}>;

export type EnhancedAiWorkerResponse = Readonly<{
  requestId: number;
  outcome: AiDecisionOutcome;
}>;

/**
 * An optional post-decision overlay for a master play decision.
 *
 * It is handed the command production master actually chose — including the
 * deadline fallback — and returns the command to play. The shipped worker never
 * provides one, so production behaviour is unchanged by construction: the seam
 * is part of the runtime, exactly like the clock, and the worker's runtime has
 * only a clock.
 *
 * Anything the overlay throws is caught here and the production command is
 * played. A selector that cannot answer must never be able to block a legal
 * move.
 */
export type PlayDecisionOverlay = (
  context: Extract<AiDecisionContext, { readonly kind: "play" }>,
  productionCommand: GameCommand,
) => GameCommand;

export type AiDecisionRuntime = Readonly<{
  deadline: number;
  now: () => number;
  /** Absent in production. Present only when an experiment installs one. */
  overlay?: PlayDecisionOverlay;
}>;

function actionCommand(
  context: Extract<AiDecisionContext, { readonly kind: "play" }>,
  action: ReturnType<typeof rankScoredPlayActions>[number]["action"] | undefined,
): GameCommand {
  if (action === undefined || action.type === "pass") {
    return Object.freeze({ type: "pass", seat: context.view.seat });
  }
  return Object.freeze({
    type: "play",
    seat: context.view.seat,
    cards: Object.freeze([...action.play.cards]),
  });
}

function strategyCommand(context: AiDecisionContext, strategy: AiStrategy): GameCommand {
  return strategy.chooseCommand(context);
}

/**
 * What master answers when its own budget is already spent: the expert ranking
 * it would have built its shortlist from, with no deadline of its own — there
 * is no time left to interrupt. Exported so the test can compare against the
 * real seam instead of re-deriving its `analyzerNodes`.
 */
export function expertFallbackPlayCommand(
  context: Extract<AiDecisionContext, { readonly kind: "play" }>,
): GameCommand {
  return actionCommand(
    context,
    rankScoredPlayActions(context, "expert", {
      analyzerNodes: ENHANCED_AI_SEARCH.rootAnalyzerNodes,
    })[0]?.action,
  );
}

function overlayed(
  runtime: AiDecisionRuntime,
  context: Extract<AiDecisionContext, { readonly kind: "play" }>,
  productionCommand: GameCommand,
): GameCommand {
  const overlay = runtime.overlay;
  if (overlay === undefined) {
    return productionCommand;
  }
  try {
    return overlay(context, productionCommand);
  } catch {
    // A selector that cannot answer plays production's move. It never blocks.
    return productionCommand;
  }
}

export function decideEnhancedAi(
  request: EnhancedAiWorkerRequest,
  runtime: AiDecisionRuntime,
): AiDecisionOutcome {
  try {
    const { context } = request;
    // Refuse a tier this handler cannot price. The worker computes its deadline
    // as `started + ENHANCED_AI_BUDGET_MS[aiType]`, so an unknown one gives
    // `NaN`: every budget check compares false and the search quietly degrades
    // to one candidate and zero rollout worlds, reported as `ok: true`. The
    // caller's fallback is a real answer; this silence is not.
    if (!Object.prototype.hasOwnProperty.call(ENHANCED_AI_BUDGET_MS, request.aiType)) {
      return Object.freeze({ ok: false, reason: "failed" });
    }
    if (context.kind === "bid") {
      const strategy = request.aiType === "casual"
        ? SCORING_CASUAL_AI_STRATEGY
        : EXPERT_AI_STRATEGY;
      return Object.freeze({ ok: true, command: strategyCommand(context, strategy) });
    }

    if (request.aiType === "casual") {
      return Object.freeze({
        ok: true,
        command: actionCommand(
          context,
          rankScoredPlayActions(context, "casual", {
            analyzerNodes: 24,
            shouldContinue: () => runtime.now() < runtime.deadline,
          })[0]?.action,
        ),
      });
    }
    if (runtime.now() >= runtime.deadline) {
      return Object.freeze({
        ok: true,
        command: overlayed(runtime, context, expertFallbackPlayCommand(context)),
      });
    }

    const ranked = rankMasterPlayActions(context, {
      ...ENHANCED_AI_SEARCH,
      seed: request.seed,
      shouldContinue: () => runtime.now() < runtime.deadline,
    });
    return Object.freeze({
      ok: true,
      command: overlayed(runtime, context, actionCommand(context, ranked[0]?.action)),
    });
  } catch {
    return Object.freeze({ ok: false, reason: "failed" });
  }
}
