import type { AiType } from "../settings/ai-settings.js";
import type { AiDecisionContext } from "../../core/ai/index.js";
import type { GameCommand } from "../../core/game/index.js";

export type { AiDecisionContext };

export type EnhancedAiType = Exclude<AiType, "default">;

export type AiDecisionOutcome =
  | Readonly<{ ok: true; command: GameCommand }>
  | Readonly<{ ok: false }>;

export interface EnhancedAiDecisionService {
  readonly request: (
    aiType: EnhancedAiType,
    context: AiDecisionContext,
    complete: (outcome: AiDecisionOutcome) => void,
  ) => () => void;
  readonly dispose: () => void;
}
