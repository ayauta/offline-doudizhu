import type { CardId } from "../../core/cards/index.js";
import type { PointerHitRegion, PointerPoint } from "./pointer-selection.js";

// The hit corridor reaches this far above and below the row of cards, so a finger
// that drifts off the top or bottom edge keeps selecting.
export const HAND_POINTER_CORRIDOR = 16;

export interface MeasuredCard {
  readonly cardId: CardId;
  readonly rectangle: Readonly<{
    readonly bottom: number;
    readonly left: number;
    readonly right: number;
    readonly top: number;
  }>;
}

// Cards overlap, so a card's clickable span runs from its own left edge to where
// the next card begins; the last card keeps its full width.
export function hitRegionsFromRects(
  measured: readonly MeasuredCard[],
  corridor: number,
): readonly PointerHitRegion<CardId>[] {
  if (measured.length === 0) {
    return [];
  }
  const top = Math.min(...measured.map(({ rectangle }) => rectangle.top)) - corridor;
  const bottom = Math.max(...measured.map(({ rectangle }) => rectangle.bottom)) + corridor;
  return measured.map(({ cardId, rectangle }, index) => ({
    bottom,
    cardId,
    left: rectangle.left,
    right: measured[index + 1]?.rectangle.left ?? rectangle.right,
    top,
  }));
}

export interface CoalescedPointerLike {
  readonly clientX: number;
  readonly clientY: number;
  readonly getCoalescedEvents?: () => readonly Readonly<{
    readonly clientX: number;
    readonly clientY: number;
  }>[];
}

// A fast swipe coalesces several moves into one event. Every intermediate point
// matters, and the final point must be present even when the browser omitted it.
export function coalescedPointerPoints(event: CoalescedPointerLike): readonly PointerPoint[] {
  const coalesced = typeof event.getCoalescedEvents === "function"
    ? event.getCoalescedEvents()
    : [];
  const points = coalesced.map(({ clientX: x, clientY: y }) => ({ x, y }));
  const finalPoint = { x: event.clientX, y: event.clientY };
  if (points.length === 0) {
    return [finalPoint];
  }
  const lastPoint = points[points.length - 1]!;
  if (lastPoint.x !== finalPoint.x || lastPoint.y !== finalPoint.y) {
    points.push(finalPoint);
  }
  return points;
}
