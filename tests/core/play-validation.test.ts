import { describe, expect, it } from "vitest";

import {
  asCardId,
  createDeck,
  type CardId,
} from "../../src/core/cards/index.js";
import { classifyPlay, validatePlay } from "../../src/core/rules/index.js";

describe("contextual play validation", () => {
  it("accepts a legal lead and returns a normalized classified play", () => {
    const fourOfDiamonds = asCardId(5);
    const fourOfClubs = asCardId(4);

    expect(
      validatePlay(
        { hand: [fourOfClubs, fourOfDiamonds], currentPlay: null },
        { type: "play", cards: [fourOfDiamonds, fourOfClubs] },
      ),
    ).toEqual({
      ok: true,
      action: {
        type: "play",
        play: {
          cards: [fourOfClubs, fourOfDiamonds],
          pattern: { kind: "pair", mainRank: "4" },
        },
      },
    });
  });

  it("rejects passing when leading a new trick", () => {
    expect(
      validatePlay(
        { hand: [asCardId(0)], currentPlay: null },
        { type: "pass" },
      ),
    ).toEqual({
      ok: false,
      error: { code: "cannot-pass-when-leading" },
    });
  });

  it("accepts passing when responding to a current play", () => {
    const current = classifyPlay([asCardId(0)]);
    if (!current.ok) {
      throw new Error(`Expected a classified current play, received ${current.error.code}.`);
    }

    expect(
      validatePlay(
        { hand: [asCardId(4)], currentPlay: current.play },
        { type: "pass" },
      ),
    ).toEqual({ ok: true, action: { type: "pass" } });
  });

  it("rejects a same-rank physical card that is not in the hand", () => {
    const threeOfClubs = asCardId(0);
    const threeOfDiamonds = asCardId(1);

    expect(
      validatePlay(
        { hand: [threeOfClubs], currentPlay: null },
        { type: "play", cards: [threeOfDiamonds] },
      ),
    ).toEqual({
      ok: false,
      error: { code: "card-not-in-hand" },
    });
  });

  it("accepts a response that is higher than the current play", () => {
    const current = classifyPlay([asCardId(0)]);
    if (!current.ok) {
      throw new Error(`Expected a classified current play, received ${current.error.code}.`);
    }
    const fourOfClubs = asCardId(4);

    expect(
      validatePlay(
        { hand: [fourOfClubs], currentPlay: current.play },
        { type: "play", cards: [fourOfClubs] },
      ),
    ).toEqual({
      ok: true,
      action: {
        type: "play",
        play: {
          cards: [fourOfClubs],
          pattern: { kind: "single", mainRank: "4" },
        },
      },
    });
  });

  it.each([
    {
      name: "equal rank",
      currentCards: [asCardId(0)],
      responseCards: [asCardId(1)],
    },
    {
      name: "lower rank",
      currentCards: [asCardId(4)],
      responseCards: [asCardId(0)],
    },
    {
      name: "different pattern",
      currentCards: [asCardId(0)],
      responseCards: [asCardId(4), asCardId(5)],
    },
    {
      name: "different sequence length",
      currentCards: [asCardId(5), asCardId(9), asCardId(13), asCardId(17), asCardId(21)],
      responseCards: [
        asCardId(0),
        asCardId(4),
        asCardId(8),
        asCardId(12),
        asCardId(16),
        asCardId(20),
      ],
    },
  ])("rejects a response with $name", ({ currentCards, responseCards }) => {
    const current = classifyPlay(currentCards);
    if (!current.ok) {
      throw new Error(`Expected a classified current play, received ${current.error.code}.`);
    }

    expect(
      validatePlay(
        { hand: responseCards, currentPlay: current.play },
        { type: "play", cards: responseCards },
      ),
    ).toEqual({
      ok: false,
      error: { code: "play-does-not-beat-current" },
    });
  });

  it("accepts a bomb over an ordinary current play", () => {
    const current = classifyPlay([
      asCardId(5),
      asCardId(9),
      asCardId(13),
      asCardId(17),
      asCardId(21),
    ]);
    if (!current.ok) {
      throw new Error(`Expected a classified current play, received ${current.error.code}.`);
    }
    const bomb = [asCardId(0), asCardId(1), asCardId(2), asCardId(3)];

    const result = validatePlay(
      { hand: bomb, currentPlay: current.play },
      { type: "play", cards: bomb },
    );

    expect(result).toMatchObject({
      ok: true,
      action: { type: "play", play: { pattern: { kind: "bomb", mainRank: "3" } } },
    });
  });

  it.each([
    {
      name: "empty selection",
      cards: [] as readonly CardId[],
      hand: [] as readonly CardId[],
      code: "empty-selection",
    },
    {
      name: "invalid card ID",
      cards: [-1 as CardId],
      hand: [] as readonly CardId[],
      code: "invalid-card-id",
    },
    {
      name: "duplicate physical card",
      cards: [asCardId(0), asCardId(0)],
      hand: [asCardId(0)],
      code: "duplicate-card-id",
    },
    {
      name: "more than twenty cards",
      cards: createDeck().slice(0, 21),
      hand: [] as readonly CardId[],
      code: "too-many-cards",
    },
    {
      name: "unsupported pattern before ownership",
      cards: [asCardId(0), asCardId(4)],
      hand: [] as readonly CardId[],
      code: "unsupported-pattern",
    },
  ] as const)("preserves the $code classification error for $name", ({ cards, hand, code }) => {
    expect(
      validatePlay(
        { hand, currentPlay: null },
        { type: "play", cards },
      ),
    ).toEqual({ ok: false, error: { code } });
  });

  it("does not mutate inputs and returns frozen serializable values", () => {
    const hand = [asCardId(4), asCardId(5), asCardId(8)];
    const selected = [asCardId(5), asCardId(4)];
    const originalHand = [...hand];
    const originalSelected = [...selected];

    const success = validatePlay(
      { hand, currentPlay: null },
      { type: "play", cards: selected },
    );
    const failure = validatePlay(
      { hand, currentPlay: null },
      { type: "pass" },
    );

    expect(hand).toEqual(originalHand);
    expect(selected).toEqual(originalSelected);
    expect(Object.isFrozen(success)).toBe(true);
    expect(Object.isFrozen(failure)).toBe(true);
    if (success.ok) {
      expect(Object.isFrozen(success.action)).toBe(true);
      if (success.action.type === "play") {
        expect(Object.isFrozen(success.action.play)).toBe(true);
        expect(Object.isFrozen(success.action.play.cards)).toBe(true);
        expect(Object.isFrozen(success.action.play.pattern)).toBe(true);
      }
    }
    if (!failure.ok) {
      expect(Object.isFrozen(failure.error)).toBe(true);
    }
    expect(JSON.parse(JSON.stringify(success))).toEqual(success);
    expect(JSON.parse(JSON.stringify(failure))).toEqual(failure);
  });
});
