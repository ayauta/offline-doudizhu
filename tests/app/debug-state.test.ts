import { describe, expect, it } from "vitest";

import {
  INITIAL_DEBUG_STATE,
  createDebugSession,
  reduceDebugState,
} from "../../src/app/session/debug-state.js";

describe("vertical-slice debug state", () => {
  it("records button actions without mutating the prior state", () => {
    const first = reduceDebugState(INITIAL_DEBUG_STATE, "hint");
    const second = reduceDebugState(first, "play");

    expect(INITIAL_DEBUG_STATE).toEqual({ actionCount: 0, lastAction: null });
    expect(first).toEqual({ actionCount: 1, lastAction: "hint" });
    expect(second).toEqual({ actionCount: 2, lastAction: "play" });
  });

  it("keeps authority in the session and notifies active subscribers", () => {
    const session = createDebugSession();
    const observed: unknown[] = [];
    const unsubscribe = session.subscribe(() => observed.push(session.getView()));

    session.dispatch("pass");
    unsubscribe();
    session.dispatch("hint");

    expect(observed).toEqual([{ actionCount: 1, lastAction: "pass" }]);
    expect(session.getView()).toEqual({ actionCount: 2, lastAction: "hint" });
  });
});
