import { describe, expect, it } from "vitest";

import {
  CASUAL_AI_STRATEGY,
  runAiTurn,
} from "../../src/core/ai/index.js";
import {
  createProductionSession,
  type DeckSource,
  type PresentationScheduler,
} from "../../src/app/session/production-session.js";
import {
  asCardId,
  createDeck,
  shuffle,
  type CardId,
  type RandomSource,
} from "../../src/core/cards/index.js";
import {
  INITIAL_GAME_STATE,
  transition,
  type GameState,
} from "../../src/core/game/index.js";

class ManualScheduler implements PresentationScheduler {
  readonly #tasks: Array<{
    active: boolean;
    at: number;
    readonly callback: () => void;
    readonly order: number;
  }> = [];
  #clock = 0;
  #order = 0;

  schedule(delayMs: number, callback: () => void): () => void {
    const task = {
      active: true,
      at: this.#clock + delayMs,
      callback,
      order: this.#order,
    };
    this.#order += 1;
    this.#tasks.push(task);
    return () => {
      task.active = false;
    };
  }

  get pendingCount(): number {
    return this.#tasks.filter((task) => task.active).length;
  }

  runNext(): void {
    const task = this.#tasks
      .filter((candidate) => candidate.active)
      .sort((left, right) => left.at - right.at || left.order - right.order)[0];
    if (task === undefined) {
      throw new Error("Expected scheduled presentation work.");
    }
    task.active = false;
    this.#clock = task.at;
    task.callback();
  }

  runUntil(predicate: () => boolean, limit = 1_024): void {
    for (let index = 0; index < limit && !predicate(); index += 1) {
      this.runNext();
    }
    if (!predicate()) {
      throw new Error("Scheduled work did not reach the expected state.");
    }
  }
}

function queuedDeckSource(decks: readonly (readonly CardId[])[]): DeckSource & {
  readonly calls: number;
} {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    nextDeck() {
      const deck = decks[calls];
      calls += 1;
      if (deck === undefined) {
        throw new Error("The fixed deck source was exhausted.");
      }
      return [...deck];
    },
  };
}

function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return {
    next() {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    },
  };
}

function deal(deck: readonly CardId[]): GameState {
  const result = transition(INITIAL_GAME_STATE, { type: "deal", deck });
  if (!result.ok) {
    throw new Error("Expected a legal fixed deal.");
  }
  return result.state;
}

function allPasses(deck: readonly CardId[]): boolean {
  let state = deal(deck);
  if (state.phase !== "bidding") {
    return false;
  }
  const humanDeclined = transition(state, {
    type: "bid",
    seat: "human",
    decision: "decline",
  });
  if (!humanDeclined.ok || humanDeclined.state.phase !== "bidding") {
    return false;
  }

  // The production session is tested against the real casual strategy below;
  // this deterministic search merely finds one fixed corpus deal that exercises
  // its rare all-pass path without baking strategy internals into the fixture.
  state = humanDeclined.state;
  const first = runAiTurn(state, CASUAL_AI_STRATEGY);
  if (!first.ok || first.command.type !== "bid" || first.command.decision !== "decline") {
    return false;
  }
  const second = runAiTurn(first.state, CASUAL_AI_STRATEGY);
  return second.ok && second.command.type === "bid" && second.command.decision === "decline";
}

function findAllPassDeck(): readonly CardId[] {
  for (let seed = 1; seed <= 2_000; seed += 1) {
    const deck = shuffle(createDeck(), seededRandom(seed));
    if (allPasses(deck)) {
      return deck;
    }
  }
  throw new Error("Expected the deterministic corpus to include an all-pass deal.");
}

function expectDeepFrozen(value: unknown): void {
  if (typeof value !== "object" || value === null) {
    return;
  }
  expect(Object.isFrozen(value)).toBe(true);
  for (const nested of Object.values(value)) {
    expectDeepFrozen(nested);
  }
}

function playHumanTurn(
  session: ReturnType<typeof createProductionSession>,
): void {
  const view = session.getView();
  if (view.screen !== "match" || view.stage === "result") {
    return;
  }
  if (view.controls.includes("hint")) {
    session.dispatch({ type: "hint" });
    expect(session.getView()).toMatchObject({ playEnabled: true });
    session.dispatch({ type: "play" });
    return;
  }
  if (view.controls.includes("pass")) {
    session.dispatch({ type: "pass" });
    return;
  }
  throw new Error("Expected a legal human action.");
}

function finishGame(
  session: ReturnType<typeof createProductionSession>,
  scheduler: ManualScheduler,
): void {
  for (let commands = 0; commands < 512; commands += 1) {
    const view = session.getView();
    if (view.screen === "match" && view.stage === "result") {
      return;
    }
    if (
      view.screen === "match" &&
      view.currentSeat === "human" &&
      view.controls.length > 0 &&
      !view.exitConfirmation
    ) {
      playHumanTurn(session);
    } else {
      scheduler.runNext();
    }
  }
  throw new Error("The production match did not finish within the command bound.");
}

describe("production application session", () => {
  it("starts from a quiet home and exposes a frozen redacted bidding view", () => {
    const scheduler = new ManualScheduler();
    const originalDeck = createDeck();
    const deckSource = queuedDeckSource([originalDeck]);
    const session = createProductionSession({ deckSource, scheduler });
    const observed: unknown[] = [];
    const unsubscribe = session.subscribe(() => observed.push(session.getView()));

    expect(session.getView()).toEqual({ screen: "home", aiType: "default" });
    session.dispatch({ type: "start-game" });

    const view = session.getView();
    expect(view).toMatchObject({
      screen: "match",
      stage: "bidding",
      currentSeat: "human",
      landlord: null,
      bottomCards: null,
      bottomCardCount: 3,
      controls: ["bid-decline", "bid-call"],
      remainingCardCounts: { human: 17, "ai-one": 17, "ai-two": 17 },
    });
    expect(view).not.toHaveProperty("hands");
    expect(JSON.stringify(view)).not.toContain('"aiHands"');
    expect(originalDeck).toEqual(createDeck());
    expect(deckSource.calls).toBe(1);
    expect(observed).toHaveLength(1);
    expectDeepFrozen(view);

    unsubscribe();
    session.dispatch({ type: "bid", decision: "call" });
    expect(observed).toHaveLength(1);
  });

  it("assigns the human landlord, reveals bottom cards, validates selection, and submits hints", () => {
    const scheduler = new ManualScheduler();
    const session = createProductionSession({
      deckSource: queuedDeckSource([createDeck()]),
      scheduler,
    });
    session.dispatch({ type: "start-game" });
    session.dispatch({ type: "bid", decision: "call" });

    let view = session.getView();
    expect(view).toMatchObject({
      screen: "match",
      stage: "playing",
      landlord: "human",
      currentSeat: "human",
      roles: { human: "landlord", "ai-one": "farmer", "ai-two": "farmer" },
      controls: ["hint", "play"],
      playEnabled: false,
    });
    if (view.screen !== "match") {
      throw new Error("Expected a match view.");
    }
    expect(view.bottomCards).toEqual([asCardId(51), asCardId(52), asCardId(53)]);
    expect(view.humanHand).toHaveLength(20);

    const first = view.humanHand[0]!;
    const differentRank = view.humanHand.find((cardId) => Math.floor(cardId / 4) !== Math.floor(first / 4));
    if (differentRank === undefined) {
      throw new Error("Expected two cards of different ranks.");
    }
    session.dispatch({
      type: "selection-change",
      changes: [
        { cardId: first, selected: true },
        { cardId: differentRank, selected: true },
      ],
    });
    session.dispatch({ type: "selection-complete" });
    expect(session.getView()).toMatchObject({
      selectionError: "unsupported-selection",
      playEnabled: false,
    });

    session.dispatch({ type: "hint" });
    view = session.getView();
    expect(view).toMatchObject({ selectionError: null, playEnabled: true });
    if (view.screen !== "match") {
      throw new Error("Expected a match view.");
    }
    const firstHint = [...view.selectedCardIds];
    expect(firstHint.length).toBeGreaterThan(0);

    const seenHints = new Set([JSON.stringify(firstHint)]);
    let wrapped = false;
    for (let index = 1; index < 512; index += 1) {
      session.dispatch({ type: "hint" });
      const hinted = session.getView();
      if (hinted.screen !== "match") {
        throw new Error("Expected a match view.");
      }
      const key = JSON.stringify(hinted.selectedCardIds);
      if (key === JSON.stringify(firstHint)) {
        wrapped = true;
        break;
      }
      expect(seenHints.has(key)).toBe(false);
      seenHints.add(key);
    }
    expect(seenHints.size).toBeGreaterThan(1);
    expect(wrapped).toBe(true);

    const manualCard = view.humanHand.find((cardId) => !firstHint.includes(cardId));
    if (manualCard === undefined) {
      throw new Error("Expected a card outside the first hint.");
    }
    session.dispatch({
      type: "selection-change",
      changes: [{ cardId: manualCard, selected: true }],
    });
    session.dispatch({ type: "hint" });
    expect(session.getView()).toMatchObject({ selectedCardIds: firstHint });

    session.dispatch({ type: "play" });
    expect(session.getView()).toMatchObject({
      currentSeat: "ai-one",
      playEnabled: false,
      selectedCardIds: [],
    });
    expect(scheduler.pendingCount).toBe(1);
  });

  it("computes consecutive AI bidding turns without exposing either result before its beat", () => {
    const scheduler = new ManualScheduler();
    const session = createProductionSession({
      deckSource: queuedDeckSource([createDeck()]),
      scheduler,
    });
    session.dispatch({ type: "start-game" });
    session.dispatch({ type: "bid", decision: "decline" });

    expect(session.getView()).toMatchObject({
      stage: "bidding",
      currentSeat: "ai-one",
      biddingActions: { human: "decline", "ai-one": null, "ai-two": null },
    });
    expect(scheduler.pendingCount).toBe(1);

    scheduler.runNext();
    expect(session.getView()).toMatchObject({
      stage: "bidding",
      currentSeat: "ai-two",
      biddingActions: { human: "decline", "ai-one": "decline", "ai-two": null },
    });
    expect(scheduler.pendingCount).toBe(1);

    scheduler.runNext();
    expect(session.getView()).toMatchObject({
      stage: "playing",
      landlord: "ai-two",
      currentSeat: "ai-two",
      controls: [],
    });
    expect(scheduler.pendingCount).toBe(1);
  });

  it("briefly reports all-pass, deals a fresh fixed deck, and invalidates stale work", () => {
    const scheduler = new ManualScheduler();
    const allPassDeck = findAllPassDeck();
    const freshDeck = [...createDeck()].reverse();
    const deckSource = queuedDeckSource([allPassDeck, freshDeck, createDeck()]);
    const session = createProductionSession({ deckSource, scheduler });
    session.dispatch({ type: "start-game" });
    session.dispatch({ type: "bid", decision: "decline" });
    scheduler.runNext();
    scheduler.runNext();

    expect(session.getView()).toMatchObject({
      stage: "bidding",
      feedback: "all-pass",
      controls: [],
    });
    expect(deckSource.calls).toBe(1);
    scheduler.runNext();
    expect(session.getView()).toMatchObject({
      stage: "bidding",
      feedback: null,
      currentSeat: "human",
      controls: ["bid-decline", "bid-call"],
    });
    expect(deckSource.calls).toBe(2);

    session.dispatch({ type: "bid", decision: "decline" });
    session.dispatch({ type: "request-exit" });
    session.dispatch({ type: "confirm-exit" });
    expect(session.getView()).toEqual({ screen: "home", aiType: "default" });
    expect(scheduler.pendingCount).toBe(0);
    session.dispatch({ type: "start-game" });
    expect(deckSource.calls).toBe(3);
  });

  it("retains the rocket and both passes until the delayed trick clear", () => {
    const scheduler = new ManualScheduler();
    const session = createProductionSession({
      deckSource: queuedDeckSource([createDeck()]),
      scheduler,
    });
    session.dispatch({ type: "start-game" });
    session.dispatch({ type: "bid", decision: "call" });
    session.dispatch({
      type: "selection-change",
      changes: [
        { cardId: asCardId(52), selected: true },
        { cardId: asCardId(53), selected: true },
      ],
    });
    session.dispatch({ type: "selection-complete" });
    session.dispatch({ type: "play" });

    expect(session.getView()).toMatchObject({
      tableActions: {
        human: { type: "play", pattern: "rocket", leading: true },
        "ai-one": null,
        "ai-two": null,
      },
    });
    scheduler.runNext();
    expect(session.getView()).toMatchObject({
      tableActions: {
        human: { type: "play", pattern: "rocket", leading: true },
        "ai-one": { type: "pass" },
        "ai-two": null,
      },
    });
    scheduler.runNext();
    expect(session.getView()).toMatchObject({
      currentSeat: "human",
      controls: [],
      tableActions: {
        human: { type: "play", pattern: "rocket", leading: true },
        "ai-one": { type: "pass" },
        "ai-two": { type: "pass" },
      },
    });
    scheduler.runNext();
    expect(session.getView()).toMatchObject({
      currentSeat: "human",
      controls: ["hint", "play"],
      tableActions: { human: null, "ai-one": null, "ai-two": null },
    });
  });

  it("rejects a lead pass and distinguishes a legal pattern that cannot beat the table", () => {
    const scheduler = new ManualScheduler();
    const session = createProductionSession({
      deckSource: queuedDeckSource([createDeck()]),
      scheduler,
    });
    session.dispatch({ type: "start-game" });
    session.dispatch({ type: "bid", decision: "call" });

    const leadView = session.getView();
    if (leadView.screen !== "match") {
      throw new Error("Expected a match view.");
    }
    session.dispatch({ type: "pass" });
    expect(session.getView()).toEqual(leadView);

    const lowestCard = leadView.humanHand.at(-1);
    if (lowestCard === undefined) {
      throw new Error("Expected a human lead card.");
    }
    session.dispatch({
      type: "selection-change",
      changes: [{ cardId: lowestCard, selected: true }],
    });
    session.dispatch({ type: "selection-complete" });
    session.dispatch({ type: "play" });
    scheduler.runUntil(() => {
      const view = session.getView();
      return view.screen === "match" &&
        view.currentSeat === "human" &&
        view.controls.includes("pass");
    });

    const responseView = session.getView();
    if (responseView.screen !== "match") {
      throw new Error("Expected a match response view.");
    }
    const lowerResponse = responseView.humanHand.at(-1);
    if (lowerResponse === undefined) {
      throw new Error("Expected a remaining response card.");
    }
    session.dispatch({
      type: "selection-change",
      changes: [{ cardId: lowerResponse, selected: true }],
    });
    session.dispatch({ type: "selection-complete" });

    expect(session.getView()).toMatchObject({
      selectionError: "does-not-beat",
      playEnabled: false,
    });
  });

  it("pauses an active match behind exit confirmation and safely resumes", () => {
    const scheduler = new ManualScheduler();
    const session = createProductionSession({
      deckSource: queuedDeckSource([createDeck()]),
      scheduler,
    });
    session.dispatch({ type: "start-game" });
    session.dispatch({ type: "bid", decision: "decline" });
    expect(scheduler.pendingCount).toBe(1);

    session.dispatch({ type: "request-exit" });
    expect(session.getView()).toMatchObject({ exitConfirmation: true, controls: [] });
    expect(scheduler.pendingCount).toBe(0);
    session.dispatch({ type: "cancel-exit" });
    expect(session.getView()).toMatchObject({
      exitConfirmation: false,
      currentSeat: "ai-one",
    });
    expect(scheduler.pendingCount).toBe(1);
    scheduler.runNext();
    expect(session.getView()).not.toMatchObject({ currentSeat: "ai-one" });
  });

  it.each([
    { role: "landlord" as const, decision: "call" as const },
    { role: "farmer" as const, decision: "decline" as const },
  ])("finishes, retains the winning play, restarts, and returns home as $role", ({ decision, role }) => {
    const scheduler = new ManualScheduler();
    const deckSource = queuedDeckSource([createDeck(), [...createDeck()].reverse()]);
    const session = createProductionSession({ deckSource, scheduler });
    session.dispatch({ type: "start-game" });
    session.dispatch({ type: "bid", decision });
    if (decision === "decline") {
      scheduler.runUntil(() => {
        const view = session.getView();
        return view.screen === "match" && view.landlord !== null;
      });
    }
    const assigned = session.getView();
    expect(assigned).toMatchObject({ roles: { human: role } });

    finishGame(session, scheduler);
    let result = session.getView();
    expect(result).toMatchObject({
      screen: "match",
      stage: "result",
      controls: ["home", "restart"],
    });
    if (result.screen !== "match") {
      throw new Error("Expected the result view.");
    }
    expect(Object.values(result.tableActions).some((action) => action?.type === "play")).toBe(true);
    expect(result.result).not.toBeNull();

    session.dispatch({ type: "restart" });
    result = session.getView();
    expect(result).toMatchObject({
      stage: "bidding",
      currentSeat: "human",
      controls: ["bid-decline", "bid-call"],
    });
    expect(deckSource.calls).toBe(2);
    session.dispatch({ type: "request-exit" });
    session.dispatch({ type: "confirm-exit" });
    expect(session.getView()).toEqual({ screen: "home", aiType: "default" });
  });

  it("cancels listeners and queued AI work when disposed", () => {
    const scheduler = new ManualScheduler();
    const session = createProductionSession({
      deckSource: queuedDeckSource([createDeck()]),
      scheduler,
    });
    let notifications = 0;
    session.subscribe(() => {
      notifications += 1;
    });
    session.dispatch({ type: "start-game" });
    session.dispatch({ type: "bid", decision: "decline" });
    expect(scheduler.pendingCount).toBe(1);

    session.dispose();

    expect(scheduler.pendingCount).toBe(0);
    session.dispatch({ type: "cancel-exit" });
    expect(notifications).toBe(2);
  });
});
