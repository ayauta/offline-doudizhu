/**
 * Cost and accuracy of `minimumHands` on the hands it will actually see.
 *
 * The measurement uses the frozen E1 corpus rather than synthetic hands,
 * because the cost of this evaluator is set by the *shape* of real leaf hands,
 * not by their size. It also mirrors the production usage pattern: one solver
 * per decision, so the memo lives exactly as long as the decision does, and
 * every leaf's three hands are measured against it.
 *
 * Runs only when `AI_BENCH_TURNS_CORPUS=<corpus dir>` is set.
 * See docs/specs/057-root-utility-leaf-value/spec.md (cost gate).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createHandTurnSolver, type HandTurnSolver } from "../src/core/ai/hand-turns.js";
import { estimateBasicHandTurns } from "../src/core/ai/hand-analyzer.js";
import { formatMs, formatPercent, summarizeLatency } from "./ai-stats.js";
import { report } from "./ai-tournament.js";
import { expandHand, type CorpusDecision, type CorpusShard } from "./leaf-corpus.js";
import type { CardId } from "../src/core/cards/index.js";

const CORPUS = process.env.AI_BENCH_TURNS_CORPUS;
const COST_DECISIONS = Number.parseInt(process.env.AI_BENCH_TURNS_DECISIONS ?? "2000", 10);
const ACCURACY_DECISIONS = Number.parseInt(process.env.AI_BENCH_TURNS_ACCURACY ?? "200", 10);
const BUDGET = Number.parseInt(process.env.AI_BENCH_TURNS_BUDGET ?? "20000", 10);
/** The reference every bounded budget is compared against. */
const REFERENCE_BUDGET = 4_000_000;

function loadShards(directory: string): readonly CorpusShard[] {
  const shards: CorpusShard[] = [];
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".json")).sort()) {
    const parsed = JSON.parse(readFileSync(join(directory, name), "utf8")) as Partial<CorpusShard>;
    if (Array.isArray(parsed.decisions)) {
      shards.push(parsed as CorpusShard);
    }
  }
  return shards;
}

function* eachDecision(shards: readonly CorpusShard[]): Generator<CorpusDecision> {
  for (const shard of shards) {
    for (const decision of shard.decisions) {
      yield decision;
    }
  }
}

/** Every hand the evaluator would be handed for one decision: leaves × seats. */
function handsOf(decision: CorpusDecision): readonly (readonly CardId[])[] {
  const hands: (readonly CardId[])[] = [];
  for (const leaf of decision.leaves) {
    for (const packed of leaf.packed) {
      hands.push(expandHand(packed));
    }
  }
  return hands;
}

function solveHands(
  hands: readonly (readonly CardId[])[],
  solver: HandTurnSolver,
  durations: number[],
): void {
  for (const hand of hands) {
    const started = performance.now();
    solver.minimumHands(hand);
    durations.push(performance.now() - started);
  }
}

describe.runIf(CORPUS !== undefined)("hand-turns evaluator cost", () => {
  it("measures per-call cost and per-decision cost on the frozen corpus", () => {
    const shards = loadShards(CORPUS as string);
    expect(shards.length).toBeGreaterThan(0);

    const decisions: CorpusDecision[] = [];
    for (const decision of eachDecision(shards)) {
      decisions.push(decision);
      if (decisions.length >= COST_DECISIONS) {
        break;
      }
    }
    expect(decisions.length).toBeGreaterThan(0);

    const perCall: number[] = [];
    const perDecision: number[] = [];
    let calls = 0;
    let cacheHits = 0;
    let nodes = 0;
    let exhausted = 0;
    let handCards = 0;
    let handCount = 0;
    const sizeHistogram = new Map<number, number>();

    for (const decision of decisions) {
      const solver = createHandTurnSolver({ maxNodes: BUDGET });
      const before = perCall.length;
      const startedAt = performance.now();
      solveHands(handsOf(decision), solver, perCall);
      perDecision.push(performance.now() - startedAt);
      const stats = solver.stats();
      calls += stats.calls;
      cacheHits += stats.cacheHits;
      nodes += stats.nodes;
      if (stats.exhausted) {
        exhausted += 1;
      }
      for (const hand of handsOf(decision)) {
        handCards += hand.length;
        handCount += 1;
        sizeHistogram.set(hand.length, (sizeHistogram.get(hand.length) ?? 0) + 1);
      }
      expect(perCall.length).toBeGreaterThan(before);
    }

    const callLatency = summarizeLatency(perCall);
    const decisionLatency = summarizeLatency(perDecision);
    const totalMs = perDecision.reduce((sum, value) => sum + value, 0);

    report(`\n== hand-turns evaluator cost (frozen corpus) ==`);
    report(`corpus            ${CORPUS}`);
    report(`decisions         ${decisions.length} (${handCount} hands, mean ${(handCards / Math.max(1, handCount)).toFixed(1)} cards)`);
    report(`node budget       ${BUDGET}`);
    report(`calls             ${calls}`);
    // `cacheHits` counts memo lookups served during the search, not top-level
    // calls, so the meaningful denominator is every lookup: hits + expansions.
    const lookups = cacheHits + nodes;
    report(
      `memo hit rate     ${formatPercent(lookups === 0 ? 0 : cacheHits / lookups)} ` +
      `(${cacheHits} hits / ${lookups} lookups)`,
    );
    report(`nodes searched    ${nodes} (mean ${(nodes / Math.max(1, calls)).toFixed(2)}/call)`);
    report(`budget exhausted  ${exhausted}/${decisions.length} decisions`);
    report(
      `per call          p50=${formatMs(callLatency.p50)} p95=${formatMs(callLatency.p95)} ` +
      `p99=${formatMs(callLatency.p99)} max=${formatMs(callLatency.max)}`,
    );
    report(
      `per decision      p50=${formatMs(decisionLatency.p50)} p95=${formatMs(decisionLatency.p95)} ` +
      `max=${formatMs(decisionLatency.max)}  (72-call pattern, phone ≈ ×3.7)`,
    );
    report(`total             ${formatMs(totalMs)} for ${decisions.length} decisions`);
    const sizes = [...sizeHistogram.entries()].sort((left, right) => left[0] - right[0]);
    report(
      `hand sizes        ${
        sizes.map(([size, count]) => `${size}:${formatPercent(count / Math.max(1, handCount), 0)}`).join(" ")
      }`,
    );

    // Reference point: the evaluator this one replaces.
    const basicStart = performance.now();
    for (const decision of decisions) {
      for (const hand of handsOf(decision)) {
        estimateBasicHandTurns(hand);
      }
    }
    report(`for reference     estimateBasicHandTurns ${formatMs(performance.now() - basicStart)} total`);

    expect(perCall.length).toBeGreaterThan(0);
  });

  it("quantifies what a bounded budget costs in accuracy", () => {
    const shards = loadShards(CORPUS as string);
    const decisions: CorpusDecision[] = [];
    for (const decision of eachDecision(shards)) {
      decisions.push(decision);
      if (decisions.length >= ACCURACY_DECISIONS) {
        break;
      }
    }

    const hands: (readonly CardId[])[] = [];
    for (const decision of decisions) {
      hands.push(...handsOf(decision));
    }

    const reference: number[] = [];
    const referenceSolver = createHandTurnSolver({ maxNodes: REFERENCE_BUDGET });
    const referenceStart = performance.now();
    for (const hand of hands) {
      reference.push(referenceSolver.minimumHands(hand));
    }
    const referenceMs = performance.now() - referenceStart;

    report(`\n== bounded budget accuracy ==`);
    report(`hands             ${hands.length} (reference budget ${REFERENCE_BUDGET}, ${formatMs(referenceMs)})`);
    report(
      `reference agrees  ${referenceSolver.stats().exhausted ? "no — reference itself exhausted" : "yes"}`,
    );

    for (const budget of [50, 200, 1000, 5000]) {
      const solver = createHandTurnSolver({ maxNodes: budget });
      const started = performance.now();
      let differing = 0;
      let overstatement = 0;
      for (let index = 0; index < hands.length; index += 1) {
        const value = solver.minimumHands(hands[index] as readonly CardId[]);
        const truth = reference[index] ?? value;
        if (value !== truth) {
          differing += 1;
          overstatement += value - truth;
        }
      }
      report(
        `budget ${String(budget).padStart(7)}  differs from reference on ` +
        `${formatPercent(differing / Math.max(1, hands.length))} of hands ` +
        `(mean overstatement ${(overstatement / Math.max(1, hands.length)).toFixed(4)}), ` +
        `exhausted=${solver.stats().exhausted ? "yes" : "no"}, ${formatMs(performance.now() - started)}`,
      );
    }
    expect(hands.length).toBeGreaterThan(0);
  });
});
