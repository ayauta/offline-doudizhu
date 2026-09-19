/**
 * Why do large policy changes move so few game outcomes?
 *
 * A hypothesis-generating diagnosis, not an experiment: it decides nothing and
 * adopts nothing, so it consumes no discovery pool. It reads per-decision score
 * structure only — never a win rate.
 *
 * The question it tries to answer, from E1 and E3's results:
 *   E1 changed 66.3% of leaf values → 0.7% of root decisions → 33/400 deals.
 *   E3 changed 40.6% of eligible decisions' third candidate → 5/400 deals.
 * Both interventions were large; both moved almost no outcomes.
 *
 * The mechanism it measures: every one of those changes has to overcome the
 * *margin* between the candidates already competing at the root. If that margin
 * is usually far larger than any single leaf-value correction, the leverage is
 * not in the leaf value or the candidate set at all.
 *
 *   AI_BENCH_DIAGNOSE=<corpus dir>
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { estimateBasicHandTurns } from "../src/core/ai/hand-analyzer.js";
import { formatPercent, percentile, quantileIsReportable } from "./ai-stats.js";
import { report } from "./ai-tournament.js";
import {
  handSizes,
  shippedUtility,
  ROOT_UTILITY_TERMINAL,
  type CorpusDecision,
  type CorpusShard,
} from "./leaf-corpus.js";

const CORPUS = process.env.AI_BENCH_DIAGNOSE;
/** Root blend weight, matching `rankMasterPlayActions`. */
const ROOT_BLEND_WEIGHT = 0.2;
const EVALUATE = (hand: Parameters<typeof estimateBasicHandTurns>[0]) => estimateBasicHandTurns(hand);

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

function quantileLine(label: string, values: readonly number[]): string {
  const at = (fraction: number) =>
    quantileIsReportable(values.length, fraction)
      ? percentile(values, fraction).toFixed(0)
      : "n/a";
  return `${label.padEnd(22)} p10=${at(0.1).padStart(6)} p50=${at(0.5).padStart(6)} p90=${at(0.9).padStart(6)}`;
}

function shareBelow(values: readonly number[], threshold: number): string {
  const below = values.filter((value) => value < threshold).length;
  return `${formatPercent(values.length === 0 ? 0 : below / values.length)} < ${threshold}`;
}

describe.runIf(CORPUS !== undefined)("leverage diagnosis", () => {
  it("measures the margin any policy change has to overcome", () => {
    const shards = loadShards(CORPUS as string);
    expect(shards.length).toBeGreaterThan(0);

    const finalMargins: number[] = [];
    const anchoredMargins: number[] = [];
    const rolloutSpread: number[] = [];
    const topTwoRolloutSpread: number[] = [];
    const marginByPhase = new Map<string, number[]>();
    let decisions = 0;
    let multiCandidate = 0;
    let terminalLeaves = 0;
    let leaves = 0;
    let rolloutFlipsAnchor = 0;
    let terminalDecidedRollout = 0;

    for (const decision of eachDecision(shards)) {
      decisions += 1;
      const candidateCount = decision.expertScores.length;
      if (candidateCount < 2) {
        continue;
      }
      multiCandidate += 1;

      const totals = decision.expertScores.map(() => 0);
      const counts = decision.expertScores.map(() => 0);
      let decided = 0;
      for (const leaf of decision.leaves) {
        leaves += 1;
        const value = shippedUtility(decision, leaf, EVALUATE);
        if (leaf.winner !== null) {
          terminalLeaves += 1;
          if (Math.abs(value) === ROOT_UTILITY_TERMINAL) {
            decided += 1;
          }
        }
        totals[leaf.candidate] = (totals[leaf.candidate] ?? 0) + value;
        counts[leaf.candidate] = (counts[leaf.candidate] ?? 0) + 1;
      }
      if (decided > 0) {
        terminalDecidedRollout += 1;
      }

      const rollout = totals.map((total, index) =>
        ROOT_BLEND_WEIGHT * (total / Math.max(1, counts[index] ?? 1)));
      const final = decision.expertScores.map((score, index) => score + (rollout[index] ?? 0));

      const order = (values: readonly number[]) =>
        values.map((value, index) => ({ value, index }))
          .sort((left, right) => right.value - left.value || left.index - right.index)
          .map((entry) => entry.index);
      const finalOrder = order(final);
      const anchoredOrder = order(decision.expertScores);
      if ((finalOrder[0] ?? -1) !== (anchoredOrder[0] ?? -1)) {
        rolloutFlipsAnchor += 1;
      }

      const top = finalOrder[0] ?? 0;
      const second = finalOrder[1] ?? 0;
      finalMargins.push(Math.abs((final[top] ?? 0) - (final[second] ?? 0)));
      anchoredMargins.push(
        Math.abs((decision.expertScores[top] ?? 0) - (decision.expertScores[second] ?? 0)),
      );
      rolloutSpread.push(Math.max(...rollout) - Math.min(...rollout));
      topTwoRolloutSpread.push(Math.abs((rollout[top] ?? 0) - (rollout[second] ?? 0)));

      // Phase proxy: how many cards are still in play at the leaf.
      const anyLeaf = decision.leaves[0];
      if (anyLeaf !== undefined) {
        const inPlay = handSizes(anyLeaf).reduce((sum, size) => sum + size, 0);
        const bucket = inPlay > 30 ? "opening (>30 cards)" : inPlay > 15 ? "middle (16-30)" : "endgame (<=15)";
        const bucketValues = marginByPhase.get(bucket) ?? [];
        bucketValues.push(finalMargins[finalMargins.length - 1] ?? 0);
        marginByPhase.set(bucket, bucketValues);
      }
    }

    report(`\n== leverage diagnosis (frozen corpus) ==`);
    report(`corpus                ${CORPUS}`);
    report(`decisions             ${decisions} (multi-candidate ${multiCandidate})`);
    report(`leaves                ${leaves} (terminal ${terminalLeaves}, ${formatPercent(leaves === 0 ? 0 : terminalLeaves / leaves)})`);
    report(`rollout reached a decided position on ${terminalDecidedRollout} decisions`);
    report(``);
    report(`A change must overcome the margin between the two candidates already competing:`);
    report(quantileLine("margin (final)", finalMargins));
    report(quantileLine("margin (anchored)", anchoredMargins));
    report(`  ${shareBelow(finalMargins, 50)}   ${shareBelow(finalMargins, 160)}   ${shareBelow(finalMargins, 400)}`);
    report(``);
    report(`What the rollout can move, before it is blended:`);
    report(quantileLine("spread across all cands", rolloutSpread.map((v) => v / ROOT_BLEND_WEIGHT)));
    report(quantileLine("top-two gap", topTwoRolloutSpread.map((v) => v / ROOT_BLEND_WEIGHT)));
    report(
      `rollout term overrides the anchored leader on ${rolloutFlipsAnchor}/${multiCandidate} ` +
      `decisions (${formatPercent(multiCandidate === 0 ? 0 : rolloutFlipsAnchor / multiCandidate)})`,
    );
    report(``);
    report(`Final margin by game phase (cards still in play at the leaf):`);
    for (const [bucket, values] of [...marginByPhase.entries()].sort()) {
      report(
        `${bucket.padEnd(22)} n=${String(values.length).padStart(5)} ` +
        `p50=${percentile(values, 0.5).toFixed(0).padStart(6)} ${shareBelow(values, 160)}`,
      );
    }

    expect(finalMargins.length).toBeGreaterThan(0);
  });
});
