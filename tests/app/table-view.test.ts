import { describe, expect, it } from "vitest";

import {
  deriveView,
  sortHandForDisplay,
  type MatchView,
  type TableViewSnapshot,
} from "../../src/app/session/table-view.js";
import { asCardId, createDeck, type CardId } from "../../src/core/cards/index.js";
import {
  INITIAL_GAME_STATE,
  transition,
  type GameState,
} from "../../src/core/game/index.js";

function dealt(): GameState {
  const result = transition(INITIAL_GAME_STATE, { type: "deal", deck: createDeck() });
  if (!result.ok) {
    throw new Error("the canonical deck must deal");
  }
  return result.state;
}

/** The human has called, taken the bottom cards, and holds the lead. */
function humanLeading(): GameState {
  const bid = transition(dealt(), { type: "bid", seat: "human", decision: "call" });
  if (!bid.ok) {
    throw new Error("the human must be able to call");
  }
  return bid.state;
}

/** The human led a single, so their next turn has a play to beat. */
function humanMustBeat(): GameState {
  const played = transition(humanLeading(), {
    type: "play",
    seat: "human",
    cards: [asCardId(0)],
  });
  if (!played.ok || played.state.phase !== "playing") {
    throw new Error("a single must be playable when leading");
  }
  return { ...played.state, currentSeat: "human" };
}

/** The human led the rocket: nothing left in any hand can beat it. */
function humanLedRocket(): GameState {
  const played = transition(humanLeading(), {
    type: "play",
    seat: "human",
    cards: [asCardId(52), asCardId(53)],
  });
  if (!played.ok || played.state.phase !== "playing") {
    throw new Error("the landlord holds both jokers after calling");
  }
  return { ...played.state, currentSeat: "human" };
}

function finished(winner: "human" | "ai-one"): GameState {
  return {
    ...humanMustBeat(),
    phase: "finished",
    winner,
    result: {
      winner,
      winningSide: winner === "human" ? "landlord" : "farmers",
      humanRole: "landlord",
      humanOutcome: winner === "human" ? "win" : "loss",
    },
  } as GameState;
}

function snapshot(overrides: Partial<TableViewSnapshot> = {}): TableViewSnapshot {
  return {
    state: dealt(),
    aiType: "default",
    inMatch: true,
    resultVisible: false,
    selectionChecked: false,
    selected: new Set(),
    bottomCards: null,
    selectionError: null,
    feedback: null,
    aiFallbackNotice: false,
    exitConfirmation: false,
    pendingClear: false,
    pendingRedeal: false,
    pendingResult: false,
    biddingActions: { human: null, "ai-one": null, "ai-two": null },
    tableActions: { human: null, "ai-one": null, "ai-two": null },
    lowCardSeats: new Set(),
    ...overrides,
  };
}

function matchView(overrides: Partial<TableViewSnapshot> = {}): MatchView {
  const view = deriveView(snapshot(overrides));
  if (view.screen !== "match") {
    throw new Error("expected a match view");
  }
  return view;
}

describe("table view derivation", () => {
  it("short-circuits to the home view without reading any match state", () => {
    const view = deriveView(snapshot({ inMatch: false, aiType: "master" }));

    expect(view).toEqual({ screen: "home", aiType: "master" });
  });

  it("offers the bidding controls only to the seat on turn", () => {
    expect(matchView().controls).toEqual(["bid-decline", "bid-call"]);
    expect(matchView({ state: { ...dealt(), currentSeat: "ai-one" } as GameState }).controls)
      .toEqual([]);
  });

  it("suspends every control while an exit or a scheduled transition owns the table", () => {
    for (const flag of ["exitConfirmation", "pendingClear", "pendingRedeal", "pendingResult"] as const) {
      expect(matchView({ [flag]: true }).controls, flag).toEqual([]);
    }
  });

  it("reveals the rematch controls only once the result is on screen", () => {
    const over = finished("human");

    expect(matchView({ state: over, resultVisible: true }).controls).toEqual(["home", "restart"]);
    expect(matchView({ state: over, resultVisible: false }).controls).toEqual([]);
    expect(matchView({ state: over, resultVisible: true }).stage).toBe("result");
    expect(matchView({ state: over, resultVisible: true }).result).toEqual({
      winner: "human",
      winningSide: "landlord",
      humanRole: "landlord",
      humanOutcome: "win",
    });
  });

  it("leads with the hint and play controls, and adds pass once a play must be beaten", () => {
    expect(matchView({ state: humanLeading() }).controls).toEqual(["hint", "play"]);
    expect(matchView({ state: humanMustBeat() }).controls)
      .toEqual(["pass", "hint", "play"]);
  });

  it("offers only pass when nothing in hand can beat the table", () => {
    expect(matchView({ state: humanLedRocket() }).controls).toEqual(["pass"]);
  });

  it("reports no-response only for the exact silent-pass beat", () => {
    expect(matchView({ state: humanLeading(), feedback: "all-pass" }).feedback).toBe("all-pass");
    expect(matchView({ state: humanLeading(), feedback: null }).feedback).toBeNull();
    expect(matchView({ state: humanMustBeat(), feedback: null }).feedback).toBeNull();
  });

  it("derives the displayed hand and the remaining counts from the game state", () => {
    const state = dealt();
    const view = matchView({ state });

    expect(view.humanHand).toEqual(sortHandForDisplay(state.phase === "awaiting-deal" ? [] : state.hands.human));
    expect(view.humanHand).toHaveLength(17);
    if (state.phase !== "awaiting-deal") {
      expect(view.remainingCardCounts).toEqual({
        human: state.hands.human.length,
        "ai-one": state.hands["ai-one"].length,
        "ai-two": state.hands["ai-two"].length,
      });
    }
  });

  it("shows an empty hand and zero counts before the deal", () => {
    const view = matchView({ state: INITIAL_GAME_STATE });

    expect(view.humanHand).toEqual([]);
    expect(view.remainingCardCounts).toEqual({ human: 0, "ai-one": 0, "ai-two": 0 });
    expect(view.stage).toBe("bidding");
    expect(view.roles).toEqual({ human: null, "ai-one": null, "ai-two": null });
  });

  it("orders the low-card seats by seat order, not by insertion", () => {
    const view = matchView({ lowCardSeats: new Set(["ai-two", "human"]) });

    expect(view.lowCardSeats).toEqual(["human", "ai-two"]);
  });

  it("hands the selection to the view only for cards still in the hand", () => {
    const state = dealt();
    const inHand = state.phase === "awaiting-deal" ? [] : state.hands.human;
    const view = matchView({
      state,
      selected: new Set([...inHand.slice(0, 2), asCardId(52)]),
    });

    expect(view.selectedCardIds).toEqual(sortHandForDisplay(inHand.slice(0, 2)));
  });

  it("enables play only when the control exists and the selection is legal", () => {
    const state = humanLeading();
    const hand: readonly CardId[] = state.phase === "awaiting-deal" ? [] : state.hands.human;
    const leading = hand.filter((cardId) => cardId === asCardId(0));

    expect(matchView({ state, selected: new Set(), selectionChecked: true }).playEnabled).toBe(false);
    expect(
      matchView({ state, selected: new Set(leading), selectionChecked: true }).playEnabled,
    ).toBe(true);
  });

  it("freezes the view it returns", () => {
    const view = matchView();

    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.remainingCardCounts)).toBe(true);
  });
});

describe("hand display order", () => {
  it("runs from the strongest card to the weakest", () => {
    const sorted = sortHandForDisplay([
      asCardId(0),
      asCardId(53),
      asCardId(52),
      asCardId(51),
    ]);

    expect(sorted).toEqual([asCardId(53), asCardId(52), asCardId(51), asCardId(0)]);
  });

  it("leaves the caller's array untouched", () => {
    const hand = [asCardId(0), asCardId(53)];
    sortHandForDisplay(hand);

    expect(hand).toEqual([asCardId(0), asCardId(53)]);
  });
});
