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
import { formatPercent } from "./ai-stats.js";
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

const EVALUATORS: Readonly<Record<string, TurnEvaluator>> = Object.freeze({
  /**
   * The shipped hand-turn estimate. Replaying it must reproduce every recorded
   * choice exactly — that equality is what proves this replay is faithful.
   */
  shipped: (hand: Parameters<TurnEvaluator>[0]) => estimateBasicHandTurns(hand),
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

/** The shipped ranking rule, including its tie-break (lowest index wins). */
function rankIndex(
  decision: CorpusDecision,
  value: (leaf: CorpusLeaf) => number,
): number {
  const totals = decision.expertScores.map(() => 0);
  const counts = decision.expertScores.map(() => 0);
  for (const leaf of decision.leaves) {
    totals[leaf.candidate] = (totals[leaf.candidate] ?? 0) + value(leaf);
    counts[leaf.candidate] = (counts[leaf.candidate] ?? 0) + 1;
  }
  let best = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < decision.expertScores.length; index += 1) {
    const mean = (counts[index] ?? 0) === 0 ? 0 : (totals[index] ?? 0) / (counts[index] ?? 1);
    const score = (decision.expertScores[index] ?? 0) + ROOT_BLEND_WEIGHT * mean;
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  }
  return best;
}

describe.runIf(REPLAY_DIR !== undefined)("E1 leaf corpus replay", () => {
  it("reports d moments, the affine calibration, and the effect gate", () => {
    const evaluateNew = EVALUATORS[NEW_EVALUATOR_NAME];
    expect(evaluateNew, `unknown evaluator "${NEW_EVALUATOR_NAME}"`).toBeDefined();
    const evaluate = evaluateNew as TurnEvaluator;
    const shipped = EVALUATORS.shipped as TurnEvaluator;

    const shards = loadShards(REPLAY_DIR as string);
    expect(shards.length).toBeGreaterThan(0);

    // Pass 1 — moments of the two turns series over the same leaves. Terminal
    // leaves carry no turns term, so they are counted but excluded here.
    const dOld: number[] = [];
    const dNew: number[] = [];
    let decisions = 0;
    let leaves = 0;
    let terminalLeaves = 0;
    let shortShortlists = 0;
    for (const decision of eachDecision(shards)) {
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
        dOld.push(turnsOf(decision, leaf, shipped));
        dNew.push(turnsOf(decision, leaf, evaluate));
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

    // Pass 2 — the effect gate, on the real candidate sets.
    let replayMismatches = 0;
    let flips = 0;
    let flipsTop1 = 0;
    for (const decision of eachDecision(shards)) {
      const shippedPick = rankIndex(decision, (leaf) => newUtility(decision, leaf, shipped, 1, 0));
      if (shippedPick !== decision.chosen) {
        replayMismatches += 1;
      }
      const newPick = rankIndex(decision, (leaf) => newUtility(decision, leaf, evaluate, k, b));
      if (newPick !== decision.chosen) {
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
