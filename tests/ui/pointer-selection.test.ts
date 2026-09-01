import { describe, expect, it } from "vitest";

import {
  INITIAL_POINTER_SELECTION_STATE,
  reducePointerSelection,
  type PointerSelectionState,
} from "../../src/ui/input/pointer-selection.js";

type CardId = "a" | "b" | "c";

function start(
  state: PointerSelectionState<CardId>,
  cardId: CardId,
  selected: boolean,
  pointerId = 1,
) {
  return reducePointerSelection(state, {
    cardId,
    point: { x: 10, y: 10 },
    pointerId,
    selected,
    type: "start",
  });
}

describe("continuous pointer selection", () => {
  it("toggles one card when a pointer ends below the movement threshold", () => {
    const begun = start(INITIAL_POINTER_SELECTION_STATE, "a", false);
    const moved = reducePointerSelection(begun.state, {
      cardId: "a",
      point: { x: 14, y: 13 },
      pointerId: 1,
      type: "move",
    });
    const ended = reducePointerSelection(moved.state, { pointerId: 1, type: "end" });

    expect(begun.changes).toEqual([]);
    expect(moved.changes).toEqual([]);
    expect(ended.changes).toEqual([{ cardId: "a", selected: true }]);
    expect(ended.state).toBe(INITIAL_POINTER_SELECTION_STATE);
  });

  it("selects each visited card once after crossing the threshold", () => {
    const begun = start(INITIAL_POINTER_SELECTION_STATE, "a", false);
    const crossed = reducePointerSelection(begun.state, {
      cardId: "b",
      point: { x: 20, y: 10 },
      pointerId: 1,
      type: "move",
    });
    const revisit = reducePointerSelection(crossed.state, {
      cardId: "a",
      point: { x: 30, y: 10 },
      pointerId: 1,
      type: "move",
    });
    const third = reducePointerSelection(revisit.state, {
      cardId: "c",
      point: { x: 40, y: 10 },
      pointerId: 1,
      type: "move",
    });

    expect(crossed.changes).toEqual([
      { cardId: "a", selected: true },
      { cardId: "b", selected: true },
    ]);
    expect(revisit.changes).toEqual([]);
    expect(third.changes).toEqual([{ cardId: "c", selected: true }]);
  });

  it("deselects the gesture when its first card was selected", () => {
    const begun = start(INITIAL_POINTER_SELECTION_STATE, "a", true);
    const crossed = reducePointerSelection(begun.state, {
      cardId: "b",
      point: { x: 10, y: 22 },
      pointerId: 1,
      type: "move",
    });

    expect(crossed.changes).toEqual([
      { cardId: "a", selected: false },
      { cardId: "b", selected: false },
    ]);
  });

  it("ends safely without a tap effect after cancellation", () => {
    const begun = start(INITIAL_POINTER_SELECTION_STATE, "a", false);
    const cancelled = reducePointerSelection(begun.state, {
      pointerId: 1,
      type: "cancel",
    });
    const ended = reducePointerSelection(cancelled.state, { pointerId: 1, type: "end" });

    expect(cancelled.changes).toEqual([]);
    expect(cancelled.state).toBe(INITIAL_POINTER_SELECTION_STATE);
    expect(ended.changes).toEqual([]);
  });

  it("ignores events from another pointer and empty move areas", () => {
    const begun = start(INITIAL_POINTER_SELECTION_STATE, "a", false, 7);
    const wrongPointer = reducePointerSelection(begun.state, {
      cardId: "b",
      point: { x: 30, y: 10 },
      pointerId: 8,
      type: "move",
    });
    const emptyArea = reducePointerSelection(wrongPointer.state, {
      cardId: null,
      point: { x: 30, y: 10 },
      pointerId: 7,
      type: "move",
    });

    expect(wrongPointer.state).toBe(begun.state);
    expect(wrongPointer.changes).toEqual([]);
    expect(emptyArea.changes).toEqual([{ cardId: "a", selected: true }]);
  });
});
