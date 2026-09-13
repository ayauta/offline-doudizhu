/**
 * Guards for the Spec 054 diagnosis. Research scaffolding: these tests exist so
 * the two arms can be trusted, and they are disposable once the diagnosis ends.
 *
 * Two different bars, deliberately:
 *  - The shipped arm is the real module, so nothing needs proving about it.
 *  - The candidate arm is *generated* from the real bytes, so what must be shown
 *    is that the generation is faithful, that the result carries the archived
 *    candidate's semantics, and that some input makes the two arms differ --
 *    without that last one there is nothing to diagnose.
 */

import { describe, expect, it } from "vitest";

import { asCardId, type CardId } from "../../src/core/cards/index.js";
import { createHandAnalyzer, estimateBasicHandTurns } from "../../src/core/ai/enhanced.js";
import { generateLegalActions } from "../../src/core/rules/index.js";
import { applyCandidatePatch, generateShadowTree, rewriteAnalyzerImport } from "./shadow-tree.js";

/** Rank-group hand builder, matching the fixtures the archived candidate used. */
function handWithCounts(counts: readonly number[]): CardId[] {
  const cards: CardId[] = [];
  counts.forEach((count, rankIndex) => {
    for (let suit = 0; suit < count; suit += 1) {
      cards.push(asCardId(rankIndex * 4 + suit));
    }
  });
  return cards;
}

/** Independent exhaustive legal-partition oracle; never uses a production estimate. */
function exactMinimumTurns(hand: readonly CardId[]): number {
  const cache = new Map<string, number>();
  const search = (current: readonly CardId[]): number => {
    if (current.length === 0) {
      return 0;
    }
    const key = current.join(",");
    const cached = cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    let best = current.length;
    for (const action of generateLegalActions({ hand: current, currentPlay: null })) {
      if (action.type !== "play") {
        continue;
      }
      const used = new Set(action.play.cards);
      best = Math.min(best, 1 + search(current.filter((card) => !used.has(card))));
      if (best === 1) {
        break;
      }
    }
    cache.set(key, best);
    return best;
  };
  return search(hand);
}

const KNOWN_HANDS: readonly (readonly [string, readonly number[], number])[] = Object.freeze([
  ["3334445", [3, 3, 1], 2],
  ["3334455", [3, 2, 2], 2],
  ["33344556", [3, 2, 2, 1], 3],
]);

describe("diagnosis generator guards", () => {
  const SHIPPED_SHAPE = `export function createHandAnalyzer() {
  return estimateBasicHandTurns(hand) + estimateBasicHandTurns(hand);
}`;

  it("applies the candidate bound to exactly the two call sites", () => {
    const patched = applyCandidatePatch(SHIPPED_SHAPE);
    expect(patched).toContain("function partitionTurnBound");
    // The inserted block's own comment names the shipped estimate, so count the
    // calls rather than asserting the identifier is absent.
    expect(patched.match(/partitionTurnBound\(hand\)/g)).toHaveLength(2);
    expect(patched.match(/estimateBasicHandTurns\(hand\)/g) ?? []).toHaveLength(0);
  });

  it("refuses to patch when the insertion anchor is missing", () => {
    expect(() => applyCandidatePatch("export function somethingElse() {}")).toThrow(
      /raises the insertion anchor|insertion/,
    );
  });

  it("refuses to patch when a call site count drifts", () => {
    const oneCallSite = `export function createHandAnalyzer() {
  return estimateBasicHandTurns(hand);
}`;
    expect(() => applyCandidatePatch(oneCallSite)).toThrow(/bound call sites/);
    const threeCallSites = `export function createHandAnalyzer() {
  return estimateBasicHandTurns(hand) + estimateBasicHandTurns(hand) + estimateBasicHandTurns(hand);
}`;
    expect(() => applyCandidatePatch(threeCallSites)).toThrow(/bound call sites/);
  });

  it("refuses to rewrite an import that is not the expected one", () => {
    expect(() => rewriteAnalyzerImport("import { x } from './hand-analyzer.js';")).toThrow(
      /occurs 0 times/,
    );
  });
});

describe("candidate arm semantics", () => {
  it("matches the archived candidate on the hands its contract names", async () => {
    const shadow = await generateShadowTree();
    for (const [label, counts, turns] of KNOWN_HANDS) {
      const hand = handWithCounts(counts);
      // The oracle is validated first, so a wrong expectation cannot pass silently.
      expect(exactMinimumTurns(hand), `${label} oracle`).toBe(turns);
      expect(
        shadow.createHandAnalyzer({ maxNodes: 10_000 }).analyze(hand).minimumTurns,
        `${label} candidate`,
      ).toBe(turns);
    }
  });

  it("reports a feasible bound on a fully exhausted budget", async () => {
    const shadow = await generateShadowTree();
    const analyzer = shadow.createHandAnalyzer({ maxNodes: 1 });
    analyzer.analyze(handWithCounts([1]));
    const exhausted = analyzer.analyze(handWithCounts([3, 2, 2, 1]));
    expect(exhausted.minimumTurns).toBeGreaterThanOrEqual(3);
    expect(analyzer.stats().visitedNodes).toBe(1);
  });
});

describe("premise: the two arms actually differ", () => {
  it("disagrees with the shipped estimate on the archived candidate's hands", async () => {
    const shadow = await generateShadowTree();
    for (const [label, counts] of KNOWN_HANDS) {
      const hand = handWithCounts(counts);
      const shipped = estimateBasicHandTurns(hand);
      const candidate = shadow.createHandAnalyzer({ maxNodes: 10_000 }).analyze(hand).minimumTurns;
      expect(candidate, `${label} must differ for the diagnosis to have an object`).not.toBe(
        shipped,
      );
    }
  });

  it("still agrees on a plain single-rank hand", async () => {
    const shadow = await generateShadowTree();
    const hand = handWithCounts([0, 0, 0, 1]);
    expect(shadow.createHandAnalyzer({ maxNodes: 10_000 }).analyze(hand).minimumTurns).toBe(
      createHandAnalyzer({ maxNodes: 10_000 }).analyze(hand).minimumTurns,
    );
  });
});
