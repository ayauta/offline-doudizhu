import { describe, expect, it } from "vitest";

import { asCardId } from "../../src/core/cards/index.js";
import {
  coalescedPointerPoints,
  hitRegionsFromRects,
  HAND_POINTER_CORRIDOR,
} from "../../src/ui/input/pointer-geometry.js";

describe("coalesced pointer points", () => {
  it("falls back to the final point when the browser reports no coalesced events", () => {
    expect(coalescedPointerPoints({ clientX: 10, clientY: 20 })).toEqual([{ x: 10, y: 20 }]);
    expect(
      coalescedPointerPoints({ clientX: 10, clientY: 20, getCoalescedEvents: () => [] }),
    ).toEqual([{ x: 10, y: 20 }]);
  });

  it("keeps the coalesced trail in order", () => {
    expect(
      coalescedPointerPoints({
        clientX: 30,
        clientY: 40,
        getCoalescedEvents: () => [{ clientX: 10, clientY: 20 }],
      }),
    ).toEqual([{ x: 10, y: 20 }, { x: 30, y: 40 }]);
  });

  it("does not repeat a final point the coalesced trail already ended on", () => {
    expect(
      coalescedPointerPoints({
        clientX: 30,
        clientY: 40,
        getCoalescedEvents: () => [{ clientX: 30, clientY: 40 }],
      }),
    ).toEqual([{ x: 30, y: 40 }]);
  });
});

describe("hand pointer hit regions", () => {
  const card = (id: number, left: number, right: number) => ({
    cardId: asCardId(id),
    rectangle: { bottom: 100, left, right, top: 20 },
  });

  it("has no regions for an empty hand", () => {
    expect(hitRegionsFromRects([], HAND_POINTER_CORRIDOR)).toEqual([]);
  });

  it("extends the last card to its own edge and reuses the shared corridor", () => {
    expect(hitRegionsFromRects([card(0, 10, 60)], HAND_POINTER_CORRIDOR)).toEqual([
      { bottom: 116, cardId: asCardId(0), left: 10, right: 60, top: 4 },
    ]);
  });

  it("ends each region where the next card begins and spans the whole row", () => {
    const regions = hitRegionsFromRects(
      [card(0, 10, 60), card(1, 30, 80), card(2, 50, 100)],
      HAND_POINTER_CORRIDOR,
    );

    expect(regions.map(({ cardId, left, right }) => [cardId, left, right])).toEqual([
      [asCardId(0), 10, 30],
      [asCardId(1), 30, 50],
      [asCardId(2), 50, 100],
    ]);
    expect(new Set(regions.map(({ top, bottom }) => `${top}:${bottom}`)).size).toBe(1);
  });
});
