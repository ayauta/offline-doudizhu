import {
  CASUAL_AI_STRATEGY,
  runAiTurn,
  type AiDecisionContext,
  type AiStrategy,
  type AiTurnResult,
} from "../../core/ai/index.js";
import type { GameState } from "../../core/game/index.js";
import type {
  AiDecisionOutcome,
  EnhancedAiDecisionService,
  EnhancedAiType,
} from "../ports/ai-decision-service.js";

export const ENHANCED_AI_PRESENTATION_BEAT_MS = 520;
export const ENHANCED_AI_RESPONSE_WINDOW_MS = ENHANCED_AI_PRESENTATION_BEAT_MS - 40;

export type EnhancedAiFallbackScope = "match" | "none" | "turn";

export type EnhancedAiTurnResolution = Readonly<{
  result: AiTurnResult;
  fallbackScope: EnhancedAiFallbackScope;
}>;

export interface EnhancedAiTurnRunner {
  readonly beginMatch: () => void;
  readonly request: (
    decisionState: GameState,
    aiType: EnhancedAiType,
    context: AiDecisionContext,
    complete: (resolution: EnhancedAiTurnResolution) => void,
  ) => () => void;
  readonly dispose: () => void;
}

type Schedule = (delayMs: number, callback: () => void) => () => void;

function fallbackResolution(
  decisionState: GameState,
  scope: Exclude<EnhancedAiFallbackScope, "none">,
  fallbackStrategy: AiStrategy,
): EnhancedAiTurnResolution {
  return Object.freeze({
    result: runAiTurn(decisionState, fallbackStrategy),
    fallbackScope: scope,
  });
}

function resolveOutcome(
  decisionState: GameState,
  outcome: AiDecisionOutcome,
  fallbackStrategy: AiStrategy,
): EnhancedAiTurnResolution {
  if (outcome.ok) {
    const returnedStrategy: AiStrategy = Object.freeze({
      chooseCommand() {
        return outcome.command;
      },
    });
    const returned = runAiTurn(decisionState, returnedStrategy);
    if (returned.ok) {
      return Object.freeze({ result: returned, fallbackScope: "none" });
    }
    return fallbackResolution(decisionState, "turn", fallbackStrategy);
  }
  return fallbackResolution(
    decisionState,
    outcome.reason === "unavailable" ? "match" : "turn",
    fallbackStrategy,
  );
}

export function createEnhancedAiTurnRunner(options: Readonly<{
  decisionService?: EnhancedAiDecisionService | undefined;
  schedule: Schedule;
  fallbackStrategy?: AiStrategy;
}>): EnhancedAiTurnRunner {
  const fallbackStrategy = options.fallbackStrategy ?? CASUAL_AI_STRATEGY;
  let disposed = false;

  return Object.freeze({
    beginMatch() {
      if (!disposed) {
        options.decisionService?.beginMatch();
      }
    },
    request(
      decisionState: GameState,
      aiType: EnhancedAiType,
      context: AiDecisionContext,
      complete: (resolution: EnhancedAiTurnResolution) => void,
    ) {
      let active = true;
      let beatReady = false;
      let resolution: EnhancedAiTurnResolution | null = null;
      let beatCancel: () => void = () => undefined;
      let timeoutCancel: () => void = () => undefined;
      let requestCancel: () => void = () => undefined;

      const cancel = () => {
        if (!active) {
          return;
        }
        active = false;
        beatCancel();
        timeoutCancel();
        requestCancel();
      };
      const commitIfReady = () => {
        if (!active || !beatReady || resolution === null) {
          return;
        }
        active = false;
        timeoutCancel();
        requestCancel();
        complete(resolution);
      };
      const receive = (outcome: AiDecisionOutcome) => {
        if (!active || resolution !== null) {
          return;
        }
        timeoutCancel();
        resolution = resolveOutcome(decisionState, outcome, fallbackStrategy);
        commitIfReady();
      };

      beatCancel = options.schedule(ENHANCED_AI_PRESENTATION_BEAT_MS, () => {
        beatReady = true;
        commitIfReady();
      });
      timeoutCancel = options.schedule(ENHANCED_AI_RESPONSE_WINDOW_MS, () => {
        requestCancel();
        receive(Object.freeze({ ok: false, reason: "failed" }));
      });
      if (options.decisionService === undefined) {
        receive(Object.freeze({ ok: false, reason: "unavailable" }));
      } else {
        requestCancel = options.decisionService.request(aiType, context, receive);
      }
      return cancel;
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      options.decisionService?.dispose();
    },
  });
}
