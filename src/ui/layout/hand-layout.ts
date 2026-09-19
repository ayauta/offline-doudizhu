import type { CardId } from "../../core/cards/index.js";

export function handNaturalWidth(count: number): string {
  const visibleCount = Number.isFinite(count) ? Math.max(1, Math.trunc(count)) : 1;
  if (visibleCount === 1) {
    return "var(--hand-card-width)";
  }
  return `calc(var(--hand-card-width)${" + var(--hand-card-step)".repeat(visibleCount - 1)})`;
}

export interface RegroupInput {
  readonly previousPositions: ReadonlyMap<CardId, number>;
  readonly currentPositions: ReadonlyMap<CardId, number>;
  readonly previousCount: number | null;
  readonly currentCount: number;
  readonly reducedMotion: boolean;
}

export interface RegroupOffset {
  readonly cardId: CardId;
  readonly offset: number;
}

// Cards only ever regroup after a play removed cards, so a hand that kept its
// length or grew is not animating. Cards the previous hand never held have no
// earlier position to travel from, and sub-pixel drift is not worth an animation.
export function regroupOffsets(input: RegroupInput): readonly RegroupOffset[] {
  if (
    input.previousCount === null ||
    input.currentCount >= input.previousCount ||
    input.reducedMotion
  ) {
    return [];
  }
  const offsets: RegroupOffset[] = [];
  for (const [cardId, currentLeft] of input.currentPositions) {
    const previousLeft = input.previousPositions.get(cardId);
    if (previousLeft === undefined) {
      continue;
    }
    const offset = previousLeft - currentLeft;
    if (Math.abs(offset) < 0.5) {
      continue;
    }
    offsets.push({ cardId, offset });
  }
  return offsets;
}
