import { describe, expect, it } from "vitest";

import { asCardId } from "../../src/core/cards/index.js";
import { regroupOffsets } from "../../src/ui/layout/hand-layout.js";

function input(overrides: Partial<Parameters<typeof regroupOffsets>[0]> = {}) {
  return {
    currentCount: 18,
    currentPositions: new Map([[asCardId(0), 100]]),
    previousCount: 19,
    previousPositions: new Map([[asCardId(0), 120]]),
    reducedMotion: false,
    ...overrides,
  };
}

describe("hand regroup offsets", () => {
  it("does nothing before the first measured hand", () => {
    expect(regroupOffsets(input({ previousCount: null }))).toEqual([]);
  });

  it("only regroups a hand that got shorter", () => {
    expect(regroupOffsets(input({ currentCount: 19 }))).toEqual([]);
    expect(regroupOffsets(input({ currentCount: 20 }))).toEqual([]);
  });

  it("stands down when reduced motion is requested", () => {
    expect(regroupOffsets(input({ reducedMotion: true }))).toEqual([]);
  });

  it("skips cards that stayed put and cards the previous hand never had", () => {
    expect(
      regroupOffsets(input({
        currentPositions: new Map([[asCardId(0), 100], [asCardId(1), 50]]),
        previousPositions: new Map([[asCardId(0), 100.2], [asCardId(1), 50]]),
      })),
    ).toEqual([]);

    expect(
      regroupOffsets(input({
        currentPositions: new Map([[asCardId(7), 50]]),
        previousPositions: new Map([[asCardId(0), 120]]),
      })),
    ).toEqual([]);
  });

  it("moves each surviving card by the distance it travelled, in hand order", () => {
    expect(
      regroupOffsets(input({
        currentPositions: new Map([[asCardId(0), 100], [asCardId(1), 40]]),
        previousPositions: new Map([[asCardId(0), 130], [asCardId(1), 60]]),
      })),
    ).toEqual([
      { cardId: asCardId(0), offset: 30 },
      { cardId: asCardId(1), offset: 20 },
    ]);
  });
});
