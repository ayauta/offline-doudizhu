import { describe, expect, it } from "vitest";

import {
  asCardId,
  createDeck,
  type CardId,
} from "../../src/core/cards/index.js";
import {
  INITIAL_GAME_STATE,
  transition,
  type PlayingState,
  type ReadyToPlayState,
} from "../../src/core/game/index.js";

function readyWithHumanLandlord(): ReadyToPlayState {
  const dealt = transition(INITIAL_GAME_STATE, {
    type: "deal",
    deck: createDeck(),
  });
  if (!dealt.ok || dealt.state.phase !== "bidding") {
    throw new Error("Expected a successful deal.");
  }

  const called = transition(dealt.state, {
    type: "bid",
    seat: "human",
    decision: "call",
  });
  if (!called.ok || called.state.phase !== "ready-to-play") {
    throw new Error("Expected the human to become landlord.");
  }
  return called.state;
}

function humanLeadsThree(): PlayingState {
  const result = transition(readyWithHumanLandlord(), {
    type: "play",
    seat: "human",
    cards: [asCardId(0)],
  });
  if (!result.ok || result.state.phase !== "playing") {
    throw new Error("Expected the human to lead a three.");
  }
  return result.state;
}

const WINNING_LANDLORD_HAND = [
  0, 1, 2,
  4, 5, 6,
  8, 9, 10,
  12, 13, 14,
  16, 17, 18,
  20, 21,
  24, 25,
  28,
].map(asCardId);

function deckWithWinningHumanLandlord(): CardId[] {
  const dealtToHuman = WINNING_LANDLORD_HAND.slice(0, 17);
  const bottomCards = WINNING_LANDLORD_HAND.slice(17);
  const winningCards = new Set(WINNING_LANDLORD_HAND);
  const otherCards = createDeck().filter((cardId) => !winningCards.has(cardId));
  const deck: CardId[] = [];
  let humanIndex = 0;
  let otherIndex = 0;

  for (let index = 0; index < 51; index += 1) {
    if (index % 3 === 0) {
      const cardId = dealtToHuman[humanIndex];
      if (cardId === undefined) {
        throw new Error("Winning human deal is incomplete.");
      }
      deck.push(cardId);
      humanIndex += 1;
    } else {
      const cardId = otherCards[otherIndex];
      if (cardId === undefined) {
        throw new Error("Opponent deal is incomplete.");
      }
      deck.push(cardId);
      otherIndex += 1;
    }
  }

  deck.push(...bottomCards);
  return deck;
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

describe("playing state machine", () => {
  it("accepts the landlord's first play, removes the physical card, records it, and rotates", () => {
    const ready = readyWithHumanLandlord();

    const result = transition(ready, {
      type: "play",
      seat: "human",
      cards: [asCardId(0)],
    });

    expect(result).toEqual({
      ok: true,
      state: {
        phase: "playing",
        hands: {
          ...ready.hands,
          human: ready.hands.human.filter((cardId) => cardId !== asCardId(0)),
        },
        bottomCards: ready.bottomCards,
        landlord: "human",
        currentSeat: "ai-one",
        currentPlay: {
          cards: [asCardId(0)],
          pattern: { kind: "single", mainRank: "3" },
        },
        lastPlaySeat: "human",
        consecutivePasses: 0,
        history: [
          {
            type: "play",
            seat: "human",
            play: {
              cards: [asCardId(0)],
              pattern: { kind: "single", mainRank: "3" },
            },
          },
        ],
      },
      events: [
        {
          type: "cards-played",
          seat: "human",
          play: {
            cards: [asCardId(0)],
            pattern: { kind: "single", mainRank: "3" },
          },
          remainingCardCount: 19,
        },
      ],
    });
    expect(ready.hands.human).toContain(asCardId(0));
    expect(ready.hands.human).toHaveLength(20);
  });

  it("rejects passing on the first lead without changing state", () => {
    const ready = readyWithHumanLandlord();

    const result = transition(ready, { type: "pass", seat: "human" });

    expect(result).toEqual({
      ok: false,
      state: ready,
      error: { code: "cannot-pass-when-leading" },
    });
    expect(result.state).toBe(ready);
  });

  it.each([
    {
      name: "out-of-turn player",
      command: { type: "play" as const, seat: "ai-one" as const, cards: [asCardId(1)] },
      code: "not-current-player",
    },
    {
      name: "out-of-turn pass",
      command: { type: "pass" as const, seat: "ai-one" as const },
      code: "not-current-player",
    },
    {
      name: "physical card owned by another seat",
      command: { type: "play" as const, seat: "human" as const, cards: [asCardId(1)] },
      code: "card-not-in-hand",
    },
    {
      name: "unsupported card shape",
      command: {
        type: "play" as const,
        seat: "human" as const,
        cards: [asCardId(0), asCardId(6)],
      },
      code: "unsupported-pattern",
    },
  ])("rejects an $name without changing state", ({ command, code }) => {
    const ready = readyWithHumanLandlord();

    const result = transition(ready, command);

    expect(result).toEqual({ ok: false, state: ready, error: { code } });
    expect(result.state).toBe(ready);
  });

  it("accepts a higher response, removes it, replaces the current play, and rotates", () => {
    const playing = humanLeadsThree();

    const result = transition(playing, {
      type: "play",
      seat: "ai-one",
      cards: [asCardId(4)],
    });

    expect(result).toEqual({
      ok: true,
      state: {
        ...playing,
        hands: {
          ...playing.hands,
          "ai-one": playing.hands["ai-one"].filter(
            (cardId) => cardId !== asCardId(4),
          ),
        },
        currentSeat: "ai-two",
        currentPlay: {
          cards: [asCardId(4)],
          pattern: { kind: "single", mainRank: "4" },
        },
        lastPlaySeat: "ai-one",
        consecutivePasses: 0,
        history: [
          ...playing.history,
          {
            type: "play",
            seat: "ai-one",
            play: {
              cards: [asCardId(4)],
              pattern: { kind: "single", mainRank: "4" },
            },
          },
        ],
      },
      events: [
        {
          type: "cards-played",
          seat: "ai-one",
          play: {
            cards: [asCardId(4)],
            pattern: { kind: "single", mainRank: "4" },
          },
          remainingCardCount: 16,
        },
      ],
    });
  });

  it("rejects a response that does not beat the current play", () => {
    const playing = humanLeadsThree();

    const result = transition(playing, {
      type: "play",
      seat: "ai-one",
      cards: [asCardId(1)],
    });

    expect(result).toEqual({
      ok: false,
      state: playing,
      error: { code: "play-does-not-beat-current" },
    });
    expect(result.state).toBe(playing);
  });

  it("records the first pass and rotates without clearing the current play", () => {
    const playing = humanLeadsThree();

    const result = transition(playing, { type: "pass", seat: "ai-one" });

    expect(result).toEqual({
      ok: true,
      state: {
        ...playing,
        currentSeat: "ai-two",
        consecutivePasses: 1,
        history: [...playing.history, { type: "pass", seat: "ai-one" }],
      },
      events: [{ type: "player-passed", seat: "ai-one" }],
    });
  });

  it("clears the trick after the second pass and returns the lead to the last player", () => {
    const afterFirstPass = transition(humanLeadsThree(), {
      type: "pass",
      seat: "ai-one",
    });
    if (!afterFirstPass.ok || afterFirstPass.state.phase !== "playing") {
      throw new Error("Expected ai-one's pass to continue play.");
    }

    const result = transition(afterFirstPass.state, {
      type: "pass",
      seat: "ai-two",
    });

    expect(result).toEqual({
      ok: true,
      state: {
        ...afterFirstPass.state,
        currentSeat: "human",
        currentPlay: null,
        lastPlaySeat: null,
        consecutivePasses: 0,
        history: [
          ...afterFirstPass.state.history,
          { type: "pass", seat: "ai-two" },
        ],
      },
      events: [
        { type: "player-passed", seat: "ai-two" },
        { type: "trick-cleared", leader: "human" },
      ],
    });
  });

  it("lets ai-two answer after one pass, resets the pass count, and wraps to human", () => {
    const afterPass = transition(humanLeadsThree(), {
      type: "pass",
      seat: "ai-one",
    });
    if (!afterPass.ok || afterPass.state.phase !== "playing") {
      throw new Error("Expected play to continue with ai-two.");
    }

    const result = transition(afterPass.state, {
      type: "play",
      seat: "ai-two",
      cards: [asCardId(8)],
    });

    expect(result).toMatchObject({
      ok: true,
      state: {
        phase: "playing",
        currentSeat: "human",
        currentPlay: {
          cards: [asCardId(8)],
          pattern: { kind: "single", mainRank: "5" },
        },
        lastPlaySeat: "ai-two",
        consecutivePasses: 0,
        history: [
          ...afterPass.state.history,
          {
            type: "play",
            seat: "ai-two",
            play: {
              cards: [asCardId(8)],
              pattern: { kind: "single", mainRank: "5" },
            },
          },
        ],
      },
      events: [
        {
          type: "cards-played",
          seat: "ai-two",
          remainingCardCount: 16,
        },
      ],
    });
  });

  it("requires the returned leader to play after a trick is cleared", () => {
    const afterFirstPass = transition(humanLeadsThree(), {
      type: "pass",
      seat: "ai-one",
    });
    if (!afterFirstPass.ok || afterFirstPass.state.phase !== "playing") {
      throw new Error("Expected play to continue with ai-two.");
    }
    const cleared = transition(afterFirstPass.state, {
      type: "pass",
      seat: "ai-two",
    });
    if (!cleared.ok || cleared.state.phase !== "playing") {
      throw new Error("Expected the trick to clear back to human.");
    }

    const result = transition(cleared.state, { type: "pass", seat: "human" });

    expect(result).toEqual({
      ok: false,
      state: cleared.state,
      error: { code: "cannot-pass-when-leading" },
    });
    expect(result.state).toBe(cleared.state);
  });

  it("finishes immediately when a legal play removes the landlord's final cards", () => {
    const dealt = transition(INITIAL_GAME_STATE, {
      type: "deal",
      deck: deckWithWinningHumanLandlord(),
    });
    if (!dealt.ok || dealt.state.phase !== "bidding") {
      throw new Error("Expected the winning deck to enter bidding.");
    }
    const called = transition(dealt.state, {
      type: "bid",
      seat: "human",
      decision: "call",
    });
    if (!called.ok || called.state.phase !== "ready-to-play") {
      throw new Error("Expected the human to become landlord.");
    }
    expect(called.state.hands.human).toEqual(WINNING_LANDLORD_HAND);

    const result = transition(called.state, {
      type: "play",
      seat: "human",
      cards: WINNING_LANDLORD_HAND,
    });
    const finalPlay = {
      cards: WINNING_LANDLORD_HAND,
      pattern: {
        kind: "airplane-with-singles" as const,
        mainRank: "7" as const,
        sequenceLength: 5,
      },
    };

    expect(result).toEqual({
      ok: true,
      state: {
        phase: "finished",
        hands: { ...called.state.hands, human: [] },
        bottomCards: called.state.bottomCards,
        landlord: "human",
        winner: "human",
        history: [{ type: "play", seat: "human", play: finalPlay }],
      },
      events: [
        {
          type: "cards-played",
          seat: "human",
          play: finalPlay,
          remainingCardCount: 0,
        },
        { type: "game-finished", winner: "human" },
      ],
    });
    expectDeepFrozen(result);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    if (!result.ok) {
      throw new Error("Expected the final play to succeed.");
    }

    const afterFinish = transition(result.state, {
      type: "pass",
      seat: "ai-one",
    });
    expect(afterFinish).toEqual({
      ok: false,
      state: result.state,
      error: { code: "command-not-allowed" },
    });
    expect(afterFinish.state).toBe(result.state);
  });

  it("returns deterministic deeply frozen serializable play state while conserving cards", () => {
    const ready = readyWithHumanLandlord();
    const selectedCards = [asCardId(3), asCardId(0)];
    const originalCards = [...selectedCards];
    const originalReady = JSON.parse(JSON.stringify(ready)) as unknown;

    const first = transition(ready, {
      type: "play",
      seat: "human",
      cards: selectedCards,
    });
    const second = transition(ready, {
      type: "play",
      seat: "human",
      cards: selectedCards,
    });

    expect(first).toEqual(second);
    expect(selectedCards).toEqual(originalCards);
    expect(ready).toEqual(originalReady);
    expectDeepFrozen(first);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    if (!first.ok || first.state.phase !== "playing") {
      throw new Error("Expected the canonical pair lead to continue play.");
    }
    expect(first.state.currentPlay).toEqual({
      cards: [asCardId(0), asCardId(3)],
      pattern: { kind: "pair", mainRank: "3" },
    });

    const publicPlayedCards = first.state.history.flatMap((entry) =>
      entry.type === "play" ? entry.play.cards : [],
    );
    const conservedCards = [
      ...first.state.hands.human,
      ...first.state.hands["ai-one"],
      ...first.state.hands["ai-two"],
      ...publicPlayedCards,
    ].sort((left, right) => left - right);
    expect(conservedCards).toEqual(createDeck());
    expect(new Set(conservedCards).size).toBe(54);
  });
});
