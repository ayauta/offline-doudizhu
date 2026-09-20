/**
 * The overlay seam in the shipped decision handler.
 *
 * The seam exists so a shipped-path benchmark can run its selector inside the
 * real `decideEnhancedAi` — after the real master search, under the real
 * deadline, behind the real fallback. Its contract is narrow and these are the
 * four clauses of it: absent means inert, throwing means inert, present means
 * authoritative, and it never reaches the paths that are not master play.
 */
import { describe, expect, it } from "vitest";

import { INITIAL_GAME_STATE, SEAT_ORDER, type Seat } from "../../src/core/game/index.js";
import { decideEnhancedAi } from "../../src/app/ai/decision-handler.js";
import { cfPlayContext } from "../../benchmarks/cf-dataset.js";
import { toFarmerRoot } from "../support/cf-fixtures.js";

function playContext() {
  const { state } = toFarmerRoot(50_001, 500_104, "human", "ai-one");
  return cfPlayContext(state, "ai-one");
}

const FROZEN = Object.freeze({ deadline: Number.POSITIVE_INFINITY, now: () => 0 });

function decide(
  context: ReturnType<typeof playContext>,
  runtime: Parameters<typeof decideEnhancedAi>[1],
) {
  const outcome = decideEnhancedAi(
    Object.freeze({ requestId: 1, aiType: "master", context, seed: 7 }),
    runtime,
  );
  if (!outcome.ok) {
    throw new Error("decision failed");
  }
  return outcome.command;
}

describe("shipped decision handler: overlay seam", () => {
  it("is inert when no overlay is installed", () => {
    const context = playContext();
    // Built by spread rather than by an optional property, so the call has no
    // `overlay` key at all — which is what the shipped worker's runtime looks
    // like. `exactOptionalPropertyTypes` will not let an explicit `undefined`
    // stand in for that, and it is right not to.
    const withoutKey = decide(context, FROZEN);
    const alsoWithout: Parameters<typeof decideEnhancedAi>[1] = {
      deadline: FROZEN.deadline,
      now: FROZEN.now,
    };
    expect(JSON.stringify(decide(context, alsoWithout))).toBe(JSON.stringify(withoutKey));
  });

  it("is inert when the overlay throws", () => {
    const context = playContext();
    const baseline = decide(context, FROZEN);
    const throwing = decide(context, {
      ...FROZEN,
      overlay: () => {
        throw new Error("selector unavailable");
      },
    });
    expect(JSON.stringify(throwing)).toBe(JSON.stringify(baseline));
  });

  it("has real authority when it answers", () => {
    const context = playContext();
    const baseline = decide(context, FROZEN);
    const forced = Object.freeze({ type: "pass", seat: "ai-one" as Seat });
    expect(JSON.stringify(decide(context, FROZEN))).toBe(JSON.stringify(baseline));
    expect(JSON.stringify(decide(context, { ...FROZEN, overlay: () => forced })))
      .toBe(JSON.stringify(forced));
  });

  it("does not touch the bid path or the casual level", () => {
    const context = playContext();
    // Inertness is the claim, not the shape of the command: the casual level
    // may legitimately pass on this root, so asserting "not a pass" would test
    // the position rather than the seam. Each path is compared against itself
    // with no overlay installed.
    const overlay = () => Object.freeze({ type: "pass", seat: "ai-one" as Seat });

    const casualPlain = decideEnhancedAi(
      Object.freeze({ requestId: 1, aiType: "casual", context, seed: 7 }),
      FROZEN,
    );
    const casualWithOverlay = decideEnhancedAi(
      Object.freeze({ requestId: 1, aiType: "casual", context, seed: 7 }),
      { ...FROZEN, overlay },
    );
    expect(casualPlain.ok && casualWithOverlay.ok).toBe(true);
    expect(JSON.stringify(casualWithOverlay)).toBe(JSON.stringify(casualPlain));

    const bid = Object.freeze({
      kind: "bid",
      view: Object.freeze({
        phase: "bidding",
        seat: "ai-one" as Seat,
        hand: Object.freeze([]),
        currentSeat: "ai-one" as Seat,
        declinedSeats: Object.freeze([]),
        remainingCardCounts: Object.freeze({ human: 17, "ai-one": 17, "ai-two": 17 }),
      }),
    });
    const bidPlain = decideEnhancedAi(
      Object.freeze({ requestId: 1, aiType: "master", context: bid as never, seed: 7 }),
      FROZEN,
    );
    const bidWithOverlay = decideEnhancedAi(
      Object.freeze({ requestId: 1, aiType: "master", context: bid as never, seed: 7 }),
      { ...FROZEN, overlay },
    );
    expect(JSON.stringify(bidWithOverlay)).toBe(JSON.stringify(bidPlain));
    void INITIAL_GAME_STATE;
    void SEAT_ORDER;
  });
});
