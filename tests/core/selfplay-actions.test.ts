import { describe, expect, it } from "vitest";

import { cardIds, seededRandom, type CardGroup } from "../support/harness.js";

import {
  CARD_COUNT,
  asCardId,
  compareCardIds,
  type CardId,
  type RandomSource,
} from "../../src/core/cards/index.js";
import {
  RANK_ORDER,
  classifyPlay,
  generateLegalActions,
  type ClassifiedPlay,
  type PlayContext,
  type ValidatedPlayAction,
} from "../../src/core/rules/index.js";
import {
  ACTION_IDENTITY_VERSION,
  RANK_SLOT_COUNT,
  RANK_SLOT_NAMES,
  actionIdentities,
  actionIdentity,
  actionRankVector,
  auditActionOrder,
  auditEnumeratedActions,
  auditPassLegality,
  bruteForceLegalActions,
  compareActionSets,
  describeRankVector,
  rankCountsOf,
  rankSlotOf,
  rankSlotViaCardTable,
} from "../../benchmarks/selfplay-actions.js";

function drawHand(random: RandomSource, size: number): CardId[] {
  const deck = Array.from({ length: CARD_COUNT }, (_, index) => asCardId(index));
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random.next() * (index + 1));
    const held = deck[index]!;
    deck[index] = deck[swapIndex]!;
    deck[swapIndex] = held;
  }
  return deck.slice(0, size).sort(compareCardIds);
}

function randomCurrentPlay(random: RandomSource): ClassifiedPlay | null {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const cards = drawHand(random, 1 + Math.floor(random.next() * 8));
    const classified = classifyPlay(cards);
    if (classified.ok) {
      return classified.play;
    }
  }
  return null;
}

/** A realistic initial deal: three hands plus the three bottom cards. */
function dealSeats(random: RandomSource): {
  readonly hands: readonly (readonly CardId[])[];
  readonly bottom: readonly CardId[];
} {
  const deck = drawHand(random, CARD_COUNT);
  return {
    hands: [deck.slice(0, 17), deck.slice(17, 34), deck.slice(34, 51)],
    bottom: deck.slice(51),
  };
}

describe("canonical action identity", () => {
  it("pins the closed-form rank slot against the card table for all 54 cards", () => {
    for (let value = 0; value < CARD_COUNT; value += 1) {
      const cardId = asCardId(value);
      expect(rankSlotOf(cardId), `card ${value}`).toBe(rankSlotViaCardTable(cardId));
    }
  });

  it("has one slot per RANK_ORDER entry and names them in that order", () => {
    expect(RANK_SLOT_COUNT).toBe(RANK_ORDER.length);
    expect(RANK_SLOT_NAMES).toEqual([...RANK_ORDER]);
    expect(RANK_SLOT_NAMES[0]).toBe("3");
    expect(RANK_SLOT_NAMES[RANK_SLOT_COUNT - 1]).toBe("big-joker");
  });

  it("ignores suits: the same rank shape has one identity across every suit choice", () => {
    const firstCopies = cardIds(["3", 3], ["4", 1]);
    const laterCopies = [asCardId(1), asCardId(2), asCardId(3), asCardId(4)];
    expect(actionIdentity({ type: "play", play: classifyOrThrow(firstCopies) })).toBe(
      actionIdentity({ type: "play", play: classifyOrThrow(laterCopies) }),
    );

    const baseline = actionIdentity({
      type: "play",
      play: classifyOrThrow(cardIds(["3", 1])),
    });
    for (let suit = 0; suit < 4; suit += 1) {
      expect(
        actionIdentity({
          type: "play",
          play: classifyOrThrow([asCardId(suit)]),
        }),
      ).toBe(baseline);
    }
  });

  it("gives pass its own identity and never collides it with a play", () => {
    expect(actionIdentity({ type: "pass" })).toBe("pass");
    expect(new Set(actionIdentities(generateLegalActions({
      hand: cardIds(["4", 1]),
      currentPlay: { cards: cardIds(["3", 1]), pattern: { kind: "single", mainRank: "3" } },
    })))).toEqual(new Set(["pass", "0,1,0,0,0,0,0,0,0,0,0,0,0,0,0"]));
  });

  it("names the identity version and renders a vector readably", () => {
    expect(ACTION_IDENTITY_VERSION).toBe("fas-action-identity-v1");
    expect(describeRankVector(rankCountsOf(cardIds(["3", 2], ["big-joker", 1])))).toBe(
      "3x2 big-jokerx1",
    );
    expect(actionRankVector({ type: "pass" }).every((count) => count === 0)).toBe(true);
  });
});

describe("enumerated-action audit", () => {
  const context: PlayContext = {
    hand: cardIds(["3", 2], ["4", 1]),
    currentPlay: { cards: cardIds(["5", 1]), pattern: { kind: "single", mainRank: "5" } },
  };

  it("accepts the engine's own output", () => {
    expect(auditEnumeratedActions(context, generateLegalActions(context))).toEqual([]);
  });

  it("rejects an action that does not beat the current play", () => {
    const illegal: ValidatedPlayAction = {
      type: "play",
      play: classifyOrThrow(cardIds(["3", 1])),
    };
    expect(auditEnumeratedActions(context, [illegal]).map((problem) => problem.kind)).toEqual([
      "illegal-action",
    ]);
  });

  it("rejects a card that is not in hand", () => {
    const foreign: ValidatedPlayAction = {
      type: "play",
      play: classifyOrThrow(cardIds(["6", 1])),
    };
    expect(
      auditEnumeratedActions(context, [foreign]).map((problem) => problem.kind),
    ).toEqual(["not-a-subset-of-hand"]);
  });

  it("rejects a duplicated canonical action", () => {
    const lead: PlayContext = { hand: cardIds(["3", 3], ["4", 2]), currentPlay: null };
    const duplicated = generateLegalActions(lead).filter(
      (action) => action.type === "play",
    );
    expect(duplicated.length).toBeGreaterThan(0);
    const doubled = [...duplicated, ...duplicated];
    expect(
      auditEnumeratedActions(lead, doubled).every(
        (problem) => problem.kind === "duplicate-identity",
      ),
    ).toBe(true);
  });

  it("rejects a pass offered while leading", () => {
    const leading: PlayContext = { hand: cardIds(["3", 1]), currentPlay: null };
    expect(
      auditEnumeratedActions(leading, [{ type: "pass" }]).map((problem) => problem.kind),
    ).toEqual(["illegal-action"]);
  });
});

describe("canonical action order", () => {
  it("is deterministic, unique, and puts pass last", () => {
    const context: PlayContext = {
      hand: cardIds(["3", 3], ["4", 2], ["5", 1], ["small-joker", 1], ["big-joker", 1]),
      currentPlay: { cards: cardIds(["6", 1]), pattern: { kind: "single", mainRank: "6" } },
    };
    const audit = auditActionOrder(context);
    expect(audit.stableAcrossCalls).toBe(true);
    expect(audit.identitiesUnique).toBe(true);
    expect(audit.passPosition).toBe("last");
    expect(auditActionOrder(context).identitySequence).toEqual(audit.identitySequence);
  });

  it("offers pass exactly when the seat is responding, and never while leading", () => {
    const hand = cardIds(["3", 1]);
    expect(auditPassLegality({ hand, currentPlay: null })).toBe(true);
    expect(
      auditPassLegality({
        hand,
        currentPlay: { cards: cardIds(["4", 1]), pattern: { kind: "single", mainRank: "4" } },
      }),
    ).toBe(true);
    expect(
      auditPassLegality({
        hand,
        currentPlay: { cards: cardIds(["small-joker", 1]), pattern: { kind: "single", mainRank: "small-joker" } },
      }),
    ).toBe(true);
  });
});

describe("brute-force oracle against the engine enumerator", () => {
  const LEAD_CASES: readonly { readonly name: string; readonly hand: readonly CardId[] }[] = [
    { name: "empty hand", hand: [] },
    { name: "single card", hand: cardIds(["3", 1]) },
    { name: "bare rocket", hand: cardIds(["small-joker", 1], ["big-joker", 1]) },
    { name: "four of a kind plus a pair", hand: cardIds(["3", 4], ["4", 2]) },
    {
      name: "two bombs and the rocket",
      hand: cardIds(["3", 4], ["4", 4], ["small-joker", 1], ["big-joker", 1]),
    },
    {
      name: "airplane with single wings from four ranks",
      hand: cardIds(["3", 3], ["4", 3], ["5", 2], ["6", 1], ["7", 1]),
    },
    {
      name: "airplane core rank reused as wing",
      hand: cardIds(["3", 4], ["4", 3], ["5", 1]),
    },
    {
      name: "four-with-two-pairs over three eligible pair ranks",
      hand: cardIds(["3", 4], ["4", 2], ["5", 2], ["6", 2]),
    },
    {
      name: "two fours of a kind plus two pairs",
      hand: cardIds(["3", 4], ["4", 4], ["5", 2], ["6", 2]),
    },
    {
      name: "full twelve-rank straight ladder",
      hand: cardIds(...RANK_ORDER.slice(0, 12).map((rank): CardGroup => [rank, 1])),
    },
    {
      name: "nine-rank consecutive-pair ladder",
      hand: cardIds(...RANK_ORDER.slice(0, 9).map((rank): CardGroup => [rank, 2])),
    },
    {
      name: "three-rank airplane with three wing pairs",
      hand: cardIds(["3", 3], ["4", 3], ["5", 3], ["7", 2], ["8", 2], ["9", 2]),
    },
    {
      name: "four-rank airplane with four wing pairs",
      hand: cardIds(
        ["3", 3], ["4", 3], ["5", 3], ["6", 3], ["7", 2], ["8", 2], ["9", 2], ["10", 2],
      ),
    },
    {
      name: "rank two and jokers outside every sequence",
      hand: cardIds(["2", 3], ["A", 2], ["K", 2], ["small-joker", 1], ["big-joker", 1]),
    },
  ];

  /*
   * Full-subset enumeration, so the budget has to match the work.
   *
   * The oracle walks every subset of the hand through `validatePlay`. The
   * largest lead case is a 20-card hand -- 2^20 subsets, over a million
   * validations -- which takes about 7.7 s here and timed out on a CI runner
   * while asserting nothing different. Vitest's 5 s default is sized for an
   * ordinary unit test, not for this.
   *
   * The timeout is raised rather than the case dropped, because that case is
   * the point: a 20-card hand is exactly where an enumerator bug hides.
   */
  const BRUTE_FORCE_TIMEOUT_MS = 120_000;

  it.each(LEAD_CASES)("matches on a lead for $name", ({ hand }) => {
    const context: PlayContext = { hand, currentPlay: null };
    const generated = generateLegalActions(context);
    expect(auditEnumeratedActions(context, generated)).toEqual([]);
    expect(compareActionSets(generated, bruteForceLegalActions(context, 20))).toEqual({
      onlyInLeft: [],
      onlyInRight: [],
    });
  }, BRUTE_FORCE_TIMEOUT_MS);

  const RESPONSE_CASES: readonly {
    readonly name: string;
    readonly hand: readonly CardId[];
    readonly currentPlay: ClassifiedPlay;
  }[] = [
    {
      name: "pair response with bombs and rocket available",
      hand: cardIds(
        ["3", 4], ["4", 2], ["5", 2], ["small-joker", 1], ["big-joker", 1],
      ),
      currentPlay: classifyOrThrow(cardIds(["6", 2])),
    },
    {
      name: "straight response",
      hand: cardIds(["4", 1], ["5", 1], ["6", 1], ["7", 1], ["8", 1], ["9", 1], ["10", 1]),
      currentPlay: classifyOrThrow(cardIds(["3", 1], ["4", 1], ["5", 1], ["6", 1], ["7", 1])),
    },
    {
      name: "airplane-with-singles response",
      hand: cardIds(["5", 3], ["6", 3], ["7", 1], ["8", 1], ["9", 1], ["10", 1]),
      currentPlay: classifyOrThrow(
        cardIds(["3", 3], ["4", 3], ["Q", 1], ["K", 1]),
      ),
    },
    {
      name: "four-with-two-cards response",
      hand: cardIds(["6", 4], ["7", 2], ["8", 1]),
      currentPlay: classifyOrThrow(cardIds(["5", 4], ["9", 1], ["10", 1])),
    },
    {
      name: "triple response where only a higher triple exists",
      hand: cardIds(["3", 3], ["K", 3]),
      currentPlay: classifyOrThrow(cardIds(["Q", 3])),
    },
  ];

  it.each(RESPONSE_CASES)("matches on a response for $name", ({ hand, currentPlay }) => {
    const context: PlayContext = { hand, currentPlay };
    const generated = generateLegalActions(context);
    expect(auditEnumeratedActions(context, generated)).toEqual([]);
    expect(compareActionSets(generated, bruteForceLegalActions(context, 20))).toEqual({
      onlyInLeft: [],
      onlyInRight: [],
    });
  }, BRUTE_FORCE_TIMEOUT_MS);

  it("matches on randomized small hands, leading and responding", () => {
    const random = seededRandom(0x5eed_0001);
    let checked = 0;

    for (let size = 1; size <= 12; size += 1) {
      for (let sample = 0; sample < 4; sample += 1) {
        const hand = drawHand(random, size);
        for (const currentPlay of [null, randomCurrentPlay(random)]) {
          const context: PlayContext = { hand, currentPlay };
          const generated = generateLegalActions(context);
          expect(auditEnumeratedActions(context, generated), `size ${size}`).toEqual([]);
          expect(
            compareActionSets(generated, bruteForceLegalActions(context, 16)),
            `size ${size} sample ${sample} currentPlay ${currentPlay === null ? "lead" : currentPlay.pattern.kind}`,
          ).toEqual({ onlyInLeft: [], onlyInRight: [] });
          checked += 1;
        }
      }
    }

    expect(checked).toBe(96);
  });

  it("matches on randomized full-SEAT hands from real deals", () => {
    const random = seededRandom(0x5eed_0002);
    for (let deal = 0; deal < 3; deal += 1) {
      const { hands, bottom } = dealSeats(random);
      const landlordHand = [...hands[0]!, ...bottom].sort(compareCardIds);
      for (const hand of [landlordHand, hands[1]!, hands[2]!]) {
        const context: PlayContext = { hand, currentPlay: null };
        expect(
          compareActionSets(
            generateLegalActions(context),
            bruteForceLegalActions(context, 20),
          ),
          `deal ${deal} hand of ${hand.length}`,
        ).toEqual({ onlyInLeft: [], onlyInRight: [] });
      }
    }
  }, 120_000);
});

describe("the oracle is a real check, not a restatement", () => {
  const context: PlayContext = { hand: cardIds(["3", 4], ["4", 2], ["5", 1]), currentPlay: null };

  it("reports a truncation the engine would hide behind a top-k filter", () => {
    const full = generateLegalActions(context);
    expect(full.length).toBeGreaterThan(3);
    expect(compareActionSets(full.slice(0, 3), bruteForceLegalActions(context)).onlyInRight)
      .not.toEqual([]);
  });

  it("reports a missing action when one kind is removed", () => {
    const full = generateLegalActions(context);
    const withoutBombs = full.filter(
      (action) => action.type === "pass" || action.play.pattern.kind !== "bomb",
    );
    expect(
      compareActionSets(withoutBombs, bruteForceLegalActions(context)).onlyInRight,
    ).toHaveLength(1);
  });

  it("reports an extra action the rules never allow", () => {
    const full = generateLegalActions(context);
    const invented: ValidatedPlayAction = {
      type: "play",
      play: classifyOrThrow(cardIds(["9", 1])),
    };
    expect(
      compareActionSets([...full, invented], bruteForceLegalActions(context)).onlyInLeft,
    ).toHaveLength(1);
  });
});

function classifyOrThrow(cards: readonly CardId[]): ClassifiedPlay {
  const result = classifyPlay(cards);
  if (!result.ok) {
    throw new Error(`Fixture is not a legal play: ${result.error.code}.`);
  }
  return result.play;
}
