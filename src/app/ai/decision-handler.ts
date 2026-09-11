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
    expert: 40,
    master: 120,
  });

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

export type AiDecisionRuntime = Readonly<{
  deadline: number;
  now: () => number;
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

function expertPlayCommand(
  context: Extract<AiDecisionContext, { readonly kind: "play" }>,
  shouldContinue?: () => boolean,
): GameCommand {
  return actionCommand(
    context,
    rankScoredPlayActions(context, "expert", {
      analyzerNodes: 220,
      ...(shouldContinue === undefined ? {} : { shouldContinue }),
    })[0]?.action,
  );
}

export function decideEnhancedAi(
  request: EnhancedAiWorkerRequest,
  runtime: AiDecisionRuntime,
): AiDecisionOutcome {
  try {
    const { context } = request;
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
    if (request.aiType === "expert") {
      return Object.freeze({
        ok: true,
        command: expertPlayCommand(context, () => runtime.now() < runtime.deadline),
      });
    }
    if (runtime.now() >= runtime.deadline) {
      return Object.freeze({ ok: true, command: expertPlayCommand(context) });
    }

    const ranked = rankMasterPlayActions(context, {
      maxWorlds: 32,
      rolloutDepth: 3,
      rootAnalyzerNodes: 220,
      seed: request.seed,
      shouldContinue: () => runtime.now() < runtime.deadline,
    });
    return Object.freeze({
      ok: true,
      command: actionCommand(context, ranked[0]?.action),
    });
  } catch {
    return Object.freeze({ ok: false, reason: "failed" });
  }
}
