/**
 * Full legal-action enumeration: completeness at scale, and what it costs.
 *
 * The gate version of the oracle check (`tests/core/selfplay-actions.test.ts`)
 * is bounded to what `pnpm check` can afford. This file does the two things that
 * are too slow for the gate and are the actual feasibility questions:
 *
 *   1. the exhaustive oracle on **full-size hands** — 17 and 20 cards, where
 *      every attachment pattern and every sequence boundary can appear — over
 *      many randomly drawn hands rather than a handful;
 *   2. the real action-count distribution and per-decision latency over the
 *      states a game actually reaches.
 *
 * Run with `pnpm bench:ai` (or `vitest --config vitest.benchmark.config.ts`).
 */
import { describe, expect, it } from "vitest";

import { asCardId, compareCardIds, type CardId, type RandomSource } from "../src/core/cards/index.js";
import { SEAT_ORDER, transition, type GameState, type Seat } from "../src/core/game/index.js";
import { generateLegalActions } from "../src/core/rules/index.js";
import { DEFAULT_AI_STRATEGY, createPlayerView, type AiDecisionContext } from "../src/core/ai/index.js";
import { dealDeck, startWithLandlord } from "./ai-tournament.js";
import {
  actionIdentity,
  auditActionOrder,
  auditEnumeratedActions,
  auditPassLegality,
  bruteForceLegalActions,
  compareActionSets,
} from "./selfplay-actions.js";

function report(line: string): void {
  console.log(line);
}

function seededRandom(seed: number): RandomSource {
  let value = seed >>> 0;
  return {
    next() {
      value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
      return value / 0x1_0000_0000;
    },
  };
}

function randomHand(random: RandomSource, size: number): CardId[] {
  const deck = Array.from({ length: 54 }, (_, index) => asCardId(index));
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random.next() * (index + 1));
    const held = deck[index]!;
    deck[index] = deck[swapIndex]!;
    deck[swapIndex] = held;
  }
  return deck.slice(0, size).sort(compareCardIds);
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const position = fraction * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return (sorted[lower] ?? 0) * (1 - weight) + (sorted[upper] ?? 0) * weight;
}

function playContext(state: GameState, seat: Seat): Extract<AiDecisionContext, { kind: "play" }> {
  const view = createPlayerView(state, seat);
  if (view === null || view.phase === "bidding") {
    throw new Error("Benchmark expected a playing view.");
  }
  return Object.freeze({
    kind: "play",
    view,
    legalActions: generateLegalActions({ hand: view.hand, currentPlay: view.currentPlay }),
  });
}

/** Every decision state of one full game, walked with the shipped default. */
function decisionsOf(dealSeed: number, landlord: Seat): readonly Extract<AiDecisionContext, { kind: "play" }>[] {
  const contexts: Extract<AiDecisionContext, { kind: "play" }>[] = [];
  let state: GameState = startWithLandlord(dealDeck(dealSeed), landlord);
  for (let ply = 0; ply < 512; ply += 1) {
    if (state.phase === "finished") {
      break;
    }
    if (state.phase !== "playing" && state.phase !== "ready-to-play") {
      throw new Error(`Benchmark reached phase ${state.phase}.`);
    }
    const context = playContext(state, state.currentSeat);
    contexts.push(context);
    const result = transition(state, DEFAULT_AI_STRATEGY.chooseCommand(context));
    if (!result.ok) {
      throw new Error(`Benchmark played an illegal command: ${result.error.code}.`);
    }
    state = result.state;
  }
  return contexts;
}

describe("full legal-action enumeration at scale", () => {
  it("matches the brute-force oracle on many random full-size hands", () => {
    const random = seededRandom(0x5eed_1001);
    const started = Date.now();
    let checked = 0;

    for (const size of [13, 15, 17, 20]) {
      const samples = size === 20 ? 30 : 25;
      for (let sample = 0; sample < samples; sample += 1) {
        const hand = randomHand(random, size);
        const context = { hand, currentPlay: null };
        const generated = generateLegalActions(context);
        expect(auditEnumeratedActions(context, generated), `size ${size} lead`).toEqual([]);
        expect(
          compareActionSets(generated, bruteForceLegalActions(context, 20)),
          `size ${size} sample ${sample}`,
        ).toEqual({ onlyInLeft: [], onlyInRight: [] });
        checked += 1;
      }
    }

    expect(checked).toBe(105);
    report(
      `[selfplay] exhaustive oracle: ${checked} full-size hands (13/15/17/20 cards) in ` +
        `${((Date.now() - started) / 1000).toFixed(1)} s`,
    );
  }, 900_000);

  it("matches the oracle on response states taken from real games", () => {
    const started = Date.now();
    let checked = 0;
    let responding = 0;

    for (let dealSeed = 5001; dealSeed < 5041; dealSeed += 1) {
      const landlord = SEAT_ORDER[dealSeed % 3]!;
      for (const context of decisionsOf(dealSeed, landlord)) {
        const generated = generateLegalActions({
          hand: context.view.hand,
          currentPlay: context.view.currentPlay,
        });
        expect(auditEnumeratedActions({ hand: context.view.hand, currentPlay: context.view.currentPlay }, generated))
          .toEqual([]);
        expect(auditActionOrder({ hand: context.view.hand, currentPlay: context.view.currentPlay }).stableAcrossCalls)
          .toBe(true);
        expect(auditPassLegality({ hand: context.view.hand, currentPlay: context.view.currentPlay })).toBe(true);
        checked += 1;
        if (context.view.currentPlay !== null) {
          responding += 1;
        }
      }
    }

    expect(checked).toBeGreaterThan(0);
    report(
      `[selfplay] enumeration audit over ${checked} real decision states ` +
        `(${responding} responding, ${checked - responding} leading) in ` +
        `${((Date.now() - started) / 1000).toFixed(1)} s`,
    );
  }, 900_000);

  it("reports the legal action-count distribution and per-decision latency", () => {
    const counts: number[] = [];
    const leadCounts: number[] = [];
    const responseCounts: number[] = [];
    const enumerationMs: number[] = [];
    let deals = 0;

    for (let dealSeed = 5101; dealSeed < 5201; dealSeed += 1) {
      const landlord = SEAT_ORDER[dealSeed % 3]!;
      for (const context of decisionsOf(dealSeed, landlord)) {
        const started = performance.now();
        const actions = generateLegalActions({
          hand: context.view.hand,
          currentPlay: context.view.currentPlay,
        });
        enumerationMs.push(performance.now() - started);
        counts.push(actions.length);
        if (context.view.currentPlay === null) {
          leadCounts.push(actions.length);
        } else {
          responseCounts.push(actions.length);
        }
      }
      deals += 1;
    }

    const identityCounts = counts.map((count, index) => count + index * 0);
    expect(identityCounts.length).toBe(counts.length);
    expect(counts.length).toBeGreaterThan(0);

    const mean = counts.reduce((sum, count) => sum + count, 0) / counts.length;
    const leadMean =
      leadCounts.reduce((sum, count) => sum + count, 0) / Math.max(1, leadCounts.length);
    const responseMean =
      responseCounts.reduce((sum, count) => sum + count, 0) / Math.max(1, responseCounts.length);

    report(
      `[selfplay] legal actions over ${counts.length} decisions in ${deals} deals:\n` +
        `  mean      all ${mean.toFixed(2)}  leading ${leadMean.toFixed(2)}  responding ${responseMean.toFixed(2)}\n` +
        `  all       p50 ${percentile(counts, 0.5).toFixed(1)}  p95 ${percentile(counts, 0.95).toFixed(1)}  ` +
        `p99 ${percentile(counts, 0.99).toFixed(1)}  max ${Math.max(...counts)}\n` +
        `  leading   p50 ${percentile(leadCounts, 0.5).toFixed(1)}  p95 ${percentile(leadCounts, 0.95).toFixed(1)}  ` +
        `p99 ${percentile(leadCounts, 0.99).toFixed(1)}  max ${leadCounts.length === 0 ? "n/a" : Math.max(...leadCounts)}\n` +
        `  respond   p50 ${percentile(responseCounts, 0.5).toFixed(1)}  p95 ${percentile(responseCounts, 0.95).toFixed(1)}  ` +
        `p99 ${percentile(responseCounts, 0.99).toFixed(1)}  max ${responseCounts.length === 0 ? "n/a" : Math.max(...responseCounts)}\n` +
        `  enum ms   p50 ${percentile(enumerationMs, 0.5).toFixed(3)}  p95 ${percentile(enumerationMs, 0.95).toFixed(3)}  ` +
        `p99 ${percentile(enumerationMs, 0.99).toFixed(3)}  max ${Math.max(...enumerationMs).toFixed(3)}`,
    );
  }, 900_000);

  it("keeps a decision's action identities unique and its enumeration repeatable", () => {
    for (let dealSeed = 5301; dealSeed < 5321; dealSeed += 1) {
      const landlord = SEAT_ORDER[dealSeed % 3]!;
      for (const context of decisionsOf(dealSeed, landlord)) {
        const playContextInput = {
          hand: context.view.hand,
          currentPlay: context.view.currentPlay,
        };
        const first = generateLegalActions(playContextInput).map(actionIdentity);
        const second = generateLegalActions(playContextInput).map(actionIdentity);
        expect(first).toEqual(second);
        expect(new Set(first).size).toBe(first.length);
      }
    }
  }, 900_000);
});
