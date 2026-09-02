import type { CardId } from "../cards/index.js";
import { classifyPlay } from "./classify-play.js";
import { comparePlays } from "./compare-plays.js";
import type {
  ClassifiedPlay,
  ClassificationErrorCode,
} from "./types.js";

export type PlayAction =
  | Readonly<{ type: "pass" }>
  | Readonly<{ type: "play"; cards: readonly CardId[] }>;

export type PlayContext = Readonly<{
  hand: readonly CardId[];
  currentPlay: ClassifiedPlay | null;
}>;

export type ValidatedPlayAction =
  | Readonly<{ type: "pass" }>
  | Readonly<{ type: "play"; play: ClassifiedPlay }>;

export type PlayValidationErrorCode =
  | ClassificationErrorCode
  | "card-not-in-hand"
  | "cannot-pass-when-leading"
  | "play-does-not-beat-current";

export type PlayValidationError = Readonly<{
  code: PlayValidationErrorCode;
}>;

export type PlayValidationResult =
  | Readonly<{ ok: true; action: ValidatedPlayAction }>
  | Readonly<{ ok: false; error: PlayValidationError }>;

function failure(code: PlayValidationErrorCode): PlayValidationResult {
  const error: PlayValidationError = Object.freeze({ code });
  return Object.freeze({ ok: false, error });
}

export function validatePlay(
  context: PlayContext,
  action: PlayAction,
): PlayValidationResult {
  if (action.type === "pass") {
    if (context.currentPlay === null) {
      return failure("cannot-pass-when-leading");
    }
    const validatedAction: ValidatedPlayAction = Object.freeze({ type: "pass" });
    return Object.freeze({ ok: true, action: validatedAction });
  }

  const classification = classifyPlay(action.cards);
  if (!classification.ok) {
    return Object.freeze({ ok: false, error: classification.error });
  }

  const hand = new Set<CardId>(context.hand);
  if (classification.play.cards.some((cardId) => !hand.has(cardId))) {
    return failure("card-not-in-hand");
  }

  if (context.currentPlay !== null) {
    const comparison = comparePlays(classification.play, context.currentPlay);
    if (comparison.outcome !== "higher") {
      return failure("play-does-not-beat-current");
    }
  }

  const validatedAction: ValidatedPlayAction = Object.freeze({
    type: "play",
    play: classification.play,
  });
  return Object.freeze({ ok: true, action: validatedAction });
}
