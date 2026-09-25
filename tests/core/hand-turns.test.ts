import { describe, expect, it } from "vitest";

import { asCardId, type CardId } from "../../src/core/cards/index.js";
import {
  createHandTurnSolver,
  handCounts,
  movesConsumingLowest,
  HAND_TURNS_RANK_COUNT,
} from "../../src/core/ai/hand-turns.js";
import { generateLegalActions } from "../../src/core/rules/index.js";

/** Deck order the app uses: standard ranks by suit, then the two jokers. */
const DECK: readonly CardId[] = Array.from({ length: 54 }, (_unused, index) => asCardId(index));

function seeded(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

function sampleHand(random: () => number, size: number): CardId[] {
  const pool = [...DECK];
  const hand: CardId[] = [];
  for (let index = 0; index < size; index += 1) {
    const pick = Math.floor(random() * pool.length);
    hand.push(pool.splice(pick, 1)[0] as CardId);
  }
  return hand.sort((left, right) => left - right);
}

/** `"334455"` style literal: rank characters in strength order, `W`/`w` jokers. */
function handOf(spec: string): CardId[] {
  const rankIndex: Readonly<Record<string, number>> = Object.freeze({
    "3": 0, "4": 1, "5": 2, "6": 3, "7": 4, "8": 5, "9": 6,
    T: 7, J: 8, Q: 9, K: 10, A: 11, "2": 12, w: 13, W: 14,
  });
  const used = new Map<number, number>();
  const cards: CardId[] = [];
  for (const character of spec) {
    const rank = rankIndex[character];
    if (rank === undefined) {
      throw new Error(`unknown rank character "${character}"`);
    }
    if (rank === 13 || rank === 14) {
      cards.push(asCardId(52 + (rank - 13)));
      continue;
    }
    const suit = used.get(rank) ?? 0;
    used.set(rank, suit + 1);
    cards.push(asCardId(rank * 4 + suit));
  }
  return cards.sort((left, right) => left - right);
}

function keyOf(counts: readonly number[]): string {
  return counts.join("");
}

function countsOfCards(cards: readonly CardId[]): number[] {
  return handCounts(cards);
}

describe("minimum hand turns", () => {
  it("reproduces the counterexamples that broke the cheap estimate", () => {
    const solver = createHandTurnSolver();
    expect(solver.minimumHands(handOf("3334445"))).toBe(2);
    expect(solver.minimumHands(handOf("3334455"))).toBe(2);
    expect(solver.minimumHands(handOf("33344556"))).toBe(3);
  });

  it("counts an airplane that carries the lowest rank as a wing", () => {
    // 555666 + wings {4, 7} is one play. Only enumerating plays whose *main*
    // rank is the lowest would report 3.
    const solver = createHandTurnSolver();
    expect(solver.minimumHands(handOf("45556667"))).toBe(1);
    expect(solver.minimumHands(handOf("w555666W"))).toBe(2);
  });

  it("handles plains, sequences, quads and attachments", () => {
    const solver = createHandTurnSolver();
    expect(solver.minimumHands([])).toBe(0);
    expect(solver.minimumHands(handOf("3"))).toBe(1);
    expect(solver.minimumHands(handOf("33"))).toBe(1);
    expect(solver.minimumHands(handOf("333"))).toBe(1);
    expect(solver.minimumHands(handOf("3333"))).toBe(1);
    expect(solver.minimumHands(handOf("34567"))).toBe(1);
    expect(solver.minimumHands(handOf("334455"))).toBe(1);
    expect(solver.minimumHands(handOf("333444"))).toBe(1);
    // One play, not two: single-card wings may take both cards of one rank, so
    // 333444 + 55 is a legal airplane-with-singles. The engine's own generator
    // agrees — see the equivalence test below.
    expect(solver.minimumHands(handOf("33344455"))).toBe(1);
    // Both jokers as the two wings is the one wing set the engine rejects, so
    // this is two plays (333+W, 444+w) rather than the single airplane+rocket.
    expect(solver.minimumHands(handOf("333444wW"))).toBe(2);
    expect(solver.minimumHands(handOf("wW"))).toBe(1);
    expect(solver.minimumHands(handOf("34567"))).toBe(1);
    // A straight broken by drawing one of its cards costs three more plays.
    expect(solver.minimumHands(handOf("4567"))).toBe(4);
  });

  it("never reports more plays than one per distinct rank", () => {
    const random = seeded(20_260_919);
    const solver = createHandTurnSolver();
    for (let trial = 0; trial < 200; trial += 1) {
      const hand = sampleHand(random, 1 + (trial % 18));
      const counts = countsOfCards(hand);
      const distinct = counts.filter((count) => count > 0).length;
      const value = solver.minimumHands(hand);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(distinct);
    }
  });

  it("agrees with the engine's own move generator", () => {
    // The contract: for any hand, the plays this module enumerates are exactly
    // the engine's own legal plays that consume the lowest present rank. If the
    // two ever disagree, the "minimum turns" is measured over moves nobody can
    // actually make, and every number downstream of it is void.
    const random = seeded(20_260_917);
    const hands: CardId[][] = [];
    for (let size = 1; size <= 14; size += 1) {
      for (let trial = 0; trial < 24; trial += 1) {
        hands.push(sampleHand(random, size));
      }
    }
    for (const structured of [
      "333444", "3334445", "3334455", "33344556", "45556667", "334455",
      "33334444", "333344445", "3456789", "3456789TJ", "33445566",
      "WA2222", "wW222", "333444555", "33334444", "5", "55", "555", "5555",
      // Both jokers as a wing pair: the one wing set the engine refuses, on
      // both structures that could carry it.
      "wW333444", "wW3333", "wW3333444", "wW33344455", "wW34567",
    ]) {
      hands.push(handOf(structured));
    }

    let compared = 0;
    for (const hand of hands) {
      const counts = countsOfCards(hand);
      const lowest = counts.findIndex((count) => count > 0);
      const mine = new Set(movesConsumingLowest(counts).map(keyOf));
      const engine = new Set(
        generateLegalActions({ hand, currentPlay: null })
          .filter((action) => action.type === "play")
          .map((action) => countsOfCards(action.type === "play" ? action.play.cards : []))
          .filter((move) => (move[lowest] ?? 0) > 0)
          .map(keyOf),
      );
      const missing = [...engine].filter((key) => !mine.has(key));
      const extra = [...mine].filter((key) => !engine.has(key));
      expect(
        { hand: hand.join(","), missing, extra },
        `hand ${hand.join(",")} disagrees with generateLegalActions`,
      ).toEqual({ hand: hand.join(","), missing: [], extra: [] });
      compared += mine.size;
    }
    expect(compared).toBeGreaterThan(0);
  });

  it("conserves its input and stays deterministic", () => {
    const hand = handOf("3334445");
    const before = [...hand];
    const counts = countsOfCards(hand);
    const countsBefore = [...counts];
    const first = createHandTurnSolver().minimumHands(hand);
    const second = createHandTurnSolver().minimumHands(hand);
    expect([...hand]).toEqual(before);
    expect(counts).toEqual(countsBefore);
    expect(second).toBe(first);
  });

  it("returns an achievable bound, not an unsafe one, when nodes run out", () => {
    const hand = handOf("33445566778");
    const exact = createHandTurnSolver().minimumHands(hand);
    const bounded = createHandTurnSolver({ maxNodes: 1 });
    const value = bounded.minimumHands(hand);
    // An exhausted search returns a real partition, so it can only overstate
    // the true minimum — never understate it.
    expect(value).toBeGreaterThanOrEqual(exact);
    expect(value).toBeLessThanOrEqual(
      countsOfCards(hand).filter((count) => count > 0).length,
    );
    expect(bounded.stats().exhausted).toBe(true);
  });

  it("shares one memo across the hands of a decision", () => {
    const solver = createHandTurnSolver();
    const hand = handOf("3334445556667");
    const first = solver.minimumHands(hand);
    const second = solver.minimumHands(hand);
    expect(second).toBe(first);
    expect(solver.stats().cacheHits).toBeGreaterThan(0);
    expect(solver.stats().calls).toBe(2);
  });

  it("packs every rank into its own digit", () => {
    const counts = countsOfCards(handOf("333344445555wW"));
    expect(counts).toHaveLength(HAND_TURNS_RANK_COUNT);
    expect(counts[0]).toBe(4);
    expect(counts[1]).toBe(4);
    expect(counts[2]).toBe(4);
    expect(counts[13]).toBe(1);
    expect(counts[14]).toBe(1);
  });
});
