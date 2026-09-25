/**
 * Offline replay of the E1 calibration corpus.
 *
 * Answers, in seconds and without playing a single game, the questions that
 * would otherwise cost a 400-deal run:
 *
 *   - the moments of the shipped turns difference `d_old`;
 *   - the moments of a candidate evaluator's `d_new` on the *same* leaves,
 *     hence the pre-registered affine calibration `k`/`b`;
 *   - the correlation between the two;
 *   - the effect gate: does re-ranking the real root candidates with the
 *     normalized new value change any decision at all?
 *
 * Swapping in the real `newEvaluator` is the only edit this file should need:
 * add it to `EVALUATORS` and select it with `AI_BENCH_REPLAY_EVALUATOR`. The
 * corpus, the side split, the utility shape and the blend weight all come from
 * the frozen data or the shipped constants — none of it is re-derived here.
 *
 * Runs only when `AI_BENCH_REPLAY=<corpus dir>` is set, so it stays inert in an
 * ordinary `pnpm bench:ai`. See docs/specs/057-root-utility-leaf-value/spec.md.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { estimateBasicHandTurns } from "../src/core/ai/hand-analyzer.js";
import { createHandTurnSolver } from "../src/core/ai/hand-turns.js";
import { formatPercent, percentile, quantileIsReportable } from "./ai-stats.js";
import { report } from "./ai-tournament.js";
import {
  cardsDifference,
  correlation,
  moments,
  turnsDifference,
  ROOT_UTILITY_CARDS_WEIGHT,
  ROOT_UTILITY_TERMINAL,
  ROOT_UTILITY_TURNS_WEIGHT,
  type CorpusDecision,
  type CorpusLeaf,
  type CorpusShard,
  type TurnEvaluator,
} from "./leaf-corpus.js";

const REPLAY_DIR = process.env.AI_BENCH_REPLAY;
/** Which evaluator plays `d_new`. Add the new one to `EVALUATORS`. */
const NEW_EVALUATOR_NAME = process.env.AI_BENCH_REPLAY_EVALUATOR ?? "shipped";

/**
 * Named evaluators, each a factory called once per decision so that a
 * stateful evaluator's memo lives exactly as long as the decision does — the
 * same lifetime production gives it.
 */
const EVALUATORS: Readonly<Record<string, () => TurnEvaluator>> = Object.freeze({
  /**
   * The shipped hand-turn estimate. Replaying it must reproduce every recorded
   * choice exactly — that equality is what proves this replay is faithful.
   */
  shipped: () => (hand) => estimateBasicHandTurns(hand),
  /** The E1 candidate: exact minimum number of plays. */
  minimum: () => {
    const solver = createHandTurnSolver();
    return (hand) => solver.minimumHands(hand);
  },
});

/** Root blend weight, matching `rankMasterPlayActions`. */
const ROOT_BLEND_WEIGHT = 0.2;

/**
 * Reads every corpus shard in the directory. Selection is by shape, not by
 * name: the corpus directory also holds `manifest.json`, which carries
 * checksums and counts but no leaves.
 */
function loadShards(directory: string): readonly CorpusShard[] {
  const shards: CorpusShard[] = [];
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".json")).sort()) {
    const parsed = JSON.parse(readFileSync(join(directory, name), "utf8")) as Partial<CorpusShard>;
    if (!Array.isArray(parsed.decisions)) {
      continue;
    }
    shards.push(parsed as CorpusShard);
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

/** A leaf's turns difference under one evaluator. */
function turnsOf(
  decision: CorpusDecision,
  leaf: CorpusLeaf,
  evaluate: TurnEvaluator,
): number {
  return turnsDifference(decision, leaf, evaluate).difference;
}

/** The new `rootUtility`: only the turns term is re-scaled, never the shape. */
function newUtility(
  decision: CorpusDecision,
  leaf: CorpusLeaf,
  evaluate: TurnEvaluator,
  k: number,
  b: number,
): number {
  if (leaf.winner !== null) {
    const sameSide = decision.seat === decision.landlord
      ? leaf.winner === decision.landlord
      : leaf.winner !== decision.landlord;
    return sameSide ? ROOT_UTILITY_TERMINAL : -ROOT_UTILITY_TERMINAL;
  }
  const turns = k * turnsOf(decision, leaf, evaluate) + b;
  const cards = cardsDifference(decision, leaf).difference;
  return turns * ROOT_UTILITY_TURNS_WEIGHT + cards * ROOT_UTILITY_CARDS_WEIGHT;
}

/** Candidate indices best-first, with the shipped tie-break (lowest index wins). */
function rankOrder(
  decision: CorpusDecision,
  value: (leaf: CorpusLeaf) => number,
): readonly number[] {
  const totals = decision.expertScores.map(() => 0);
  const counts = decision.expertScores.map(() => 0);
  for (const leaf of decision.leaves) {
    totals[leaf.candidate] = (totals[leaf.candidate] ?? 0) + value(leaf);
    counts[leaf.candidate] = (counts[leaf.candidate] ?? 0) + 1;
  }
  return decision.expertScores
    .map((expertScore, index) => ({
      index,
      score: expertScore +
        ROOT_BLEND_WEIGHT * ((counts[index] ?? 0) === 0 ? 0 : (totals[index] ?? 0) / (counts[index] ?? 1)),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.index);
}

describe.runIf(REPLAY_DIR !== undefined)("E1 leaf corpus replay", () => {
  it("reports d moments, the affine calibration, and the effect gate", () => {
    const makeNew = EVALUATORS[NEW_EVALUATOR_NAME];
    expect(makeNew, `unknown evaluator "${NEW_EVALUATOR_NAME}"`).toBeDefined();
    const makeNewEvaluator = makeNew as () => TurnEvaluator;
    const makeShipped = EVALUATORS.shipped as () => TurnEvaluator;

    const shards = loadShards(REPLAY_DIR as string);
    expect(shards.length).toBeGreaterThan(0);

    // Pass 1 — moments of the two turns series over the same leaves. Terminal
    // leaves carry no turns term, so they are counted but excluded here.
    const dOld: number[] = [];
    const dNew: number[] = [];
    const deltas: number[] = [];
    let decisions = 0;
    let leaves = 0;
    let terminalLeaves = 0;
    let shortShortlists = 0;
    for (const decision of eachDecision(shards)) {
      // Fresh evaluators per decision: a stateful one's memo must live exactly
      // as long as production lets it.
      const shipped = makeShipped();
      const evaluate = makeNewEvaluator();
      decisions += 1;
      if (decision.expertScores.length < 3) {
        shortShortlists += 1;
      }
      for (const leaf of decision.leaves) {
        leaves += 1;
        if (leaf.winner !== null) {
          terminalLeaves += 1;
          continue;
        }
        const oldValue = turnsOf(decision, leaf, shipped);
        const newValue = turnsOf(decision, leaf, evaluate);
        dOld.push(oldValue);
        dNew.push(newValue);
        deltas.push(newValue - oldValue);
      }
    }

    const oldMoments = moments(dOld);
    const newMoments = moments(dNew);
    const k = newMoments.sd === 0 ? 1 : oldMoments.sd / newMoments.sd;
    const b = oldMoments.mean - k * newMoments.mean;

    report(`\n== leaf corpus replay ==`);
    report(`corpus          ${REPLAY_DIR}`);
    report(`shards          ${shards.length}`);
    report(`decisions       ${decisions}`);
    report(`leaves          ${leaves} (terminal ${terminalLeaves})`);
    report(
      `short shortlist ${shortShortlists} ` +
      `(${formatPercent(decisions === 0 ? 0 : shortShortlists / decisions)})`,
    );
    report(`old evaluator   shipped (estimateBasicHandTurns)`);
    report(`new evaluator   ${NEW_EVALUATOR_NAME}`);
    report(`d_old           mean=${oldMoments.mean.toFixed(4)} sd=${oldMoments.sd.toFixed(4)}`);
    report(`d_new           mean=${newMoments.mean.toFixed(4)} sd=${newMoments.sd.toFixed(4)}`);
    report(`affine          k=${k.toFixed(6)} b=${b.toFixed(6)}`);
    report(`correlation     ${correlation(dOld, dNew).toFixed(6)}`);
    {
      const differing = deltas.filter((value) => value !== 0).length;
      let deltaMin = Number.POSITIVE_INFINITY;
      let deltaMax = Number.NEGATIVE_INFINITY;
      for (const value of deltas) {
        if (value < deltaMin) deltaMin = value;
        if (value > deltaMax) deltaMax = value;
      }
      const quantile = (fraction: number) =>
        quantileIsReportable(deltas.length, fraction)
          ? percentile(deltas, fraction).toFixed(3)
          : "n/a";
      report(
        `delta new-old   min=${deltaMin.toFixed(0)} p05=${quantile(0.05)} ` +
        `p25=${quantile(0.25)} p50=${quantile(0.5)} p75=${quantile(0.75)} ` +
        `p95=${quantile(0.95)} max=${deltaMax.toFixed(0)}`,
      );
      report(
        `delta non-zero  ${formatPercent(deltas.length === 0 ? 0 : differing / deltas.length)} ` +
        `of ${deltas.length} leaves`,
      );
    }

    // Pass 2 — the effect gate, on the real candidate sets.
    let replayMismatches = 0;
    let flips = 0;
    let flipsTop1 = 0;
    let orderingDivergence = 0;
    let shortlistOrders = 0;
    for (const decision of eachDecision(shards)) {
      const replayShipped = makeShipped();
      const replayNew = makeNewEvaluator();
      const shippedOrder = rankOrder(
        decision,
        (leaf) => newUtility(decision, leaf, replayShipped, 1, 0),
      );
      if ((shippedOrder[0] ?? -1) !== decision.chosen) {
        replayMismatches += 1;
      }
      const newOrder = rankOrder(
        decision,
        (leaf) => newUtility(decision, leaf, replayNew, k, b),
      );
      if (decision.expertScores.length >= 2) {
        shortlistOrders += 1;
        if (newOrder.join(",") !== shippedOrder.join(",")) {
          orderingDivergence += 1;
        }
      }
      if ((newOrder[0] ?? -1) !== decision.chosen) {
        flips += 1;
        if (decision.chosen === 0) {
          flipsTop1 += 1;
        }
      }
    }

    report(
      `replay fidelity ${replayMismatches} mismatches vs the recorded choice ` +
      `(must be 0 with the shipped evaluator)`,
    );
    report(
      `effect gate     ${flips}/${decisions} decisions change ` +
      `(${formatPercent(decisions === 0 ? 0 : flips / decisions)}), ` +
      `of which ${flipsTop1} displace the expert leader`,
    );
    report(
      `ordering        ${orderingDivergence}/${shortlistOrders} multi-candidate decisions ` +
      `reorder at all (${formatPercent(shortlistOrders === 0 ? 0 : orderingDivergence / shortlistOrders)})`,
    );

    expect(dOld.length).toBeGreaterThan(0);
    if (NEW_EVALUATOR_NAME === "shipped") {
      // With new == old, k=1 and b=0, so the replay must land on exactly the
      // recorded choice. A non-zero count means this tool does not faithfully
      // reproduce the shipped ranking, and no conclusion drawn from it counts.
      expect(replayMismatches).toBe(0);
      expect(flips).toBe(0);
    }
  });
});
