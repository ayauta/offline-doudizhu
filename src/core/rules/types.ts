import type { CardId, Rank, StandardRank } from "../cards/index.js";

export const CLASSIFICATION_ERROR_CODES = Object.freeze([
  "empty-selection",
  "invalid-card-id",
  "duplicate-card-id",
  "too-many-cards",
  "unsupported-pattern",
] as const);

export type ClassificationErrorCode = (typeof CLASSIFICATION_ERROR_CODES)[number];

export type ClassificationError = Readonly<{
  code: ClassificationErrorCode;
}>;

interface RankedPattern<
  Kind extends Exclude<PlayPatternKind, "rocket">,
  MainRank extends Rank = Rank,
> {
  readonly kind: Kind;
  readonly mainRank: MainRank;
}

interface SequencePattern<
  Kind extends "straight" | "consecutive-pairs" | AirplanePatternKind,
> extends RankedPattern<Kind, StandardRank> {
  readonly sequenceLength: number;
}

export type AirplanePatternKind =
  | "airplane"
  | "airplane-with-singles"
  | "airplane-with-pairs";

export type PlayPatternKind =
  | "single"
  | "pair"
  | "triple"
  | "triple-with-single"
  | "triple-with-pair"
  | "straight"
  | "consecutive-pairs"
  | AirplanePatternKind
  | "four-with-two-cards"
  | "four-with-two-pairs"
  | "bomb"
  | "rocket";

export type PlayPattern =
  | RankedPattern<"single">
  | RankedPattern<"pair", StandardRank>
  | RankedPattern<"triple", StandardRank>
  | RankedPattern<"triple-with-single", StandardRank>
  | RankedPattern<"triple-with-pair", StandardRank>
  | SequencePattern<"straight">
  | SequencePattern<"consecutive-pairs">
  | SequencePattern<"airplane">
  | SequencePattern<"airplane-with-singles">
  | SequencePattern<"airplane-with-pairs">
  | RankedPattern<"four-with-two-cards", StandardRank>
  | RankedPattern<"four-with-two-pairs", StandardRank>
  | RankedPattern<"bomb", StandardRank>
  | Readonly<{ kind: "rocket" }>;

export interface ClassifiedPlay {
  readonly cards: readonly CardId[];
  readonly pattern: PlayPattern;
}

export type ClassificationResult =
  | Readonly<{ ok: true; play: ClassifiedPlay }>
  | Readonly<{ ok: false; error: ClassificationError }>;

export type ComparableOutcome = "higher" | "equal" | "lower";
export type IncomparableReason = "different-pattern" | "different-length";

export type ComparisonResult =
  | Readonly<{ outcome: ComparableOutcome }>
  | Readonly<{ outcome: "incomparable"; reason: IncomparableReason }>;
