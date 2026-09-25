/**
 * Which equal-budget structure produces terminal information most effectively?
 *
 * Candidates are fixed in advance to `{4 worlds × 6 plies, 6 worlds × 4 plies}`:
 * both spend 24 world-plies like the shipped `8×3`, both deepen past 3 plies,
 * and neither drops below 4 worlds — 4 worlds is the smallest count with a
 * paired measurement showing no reliable loss against 8.
 *
 * The metric is a *rate*, not a count: the three structures expand different
 * numbers of trajectories (24 / 12 / 18 for 8×3 / 4×6 / 6×4), so comparing raw
 * terminal counts would hand the smaller structure a free advantage.
 *
 * This decides nothing about strength. "4×6 reaches terminals more often" is a
 * statement about terminal information, not about search quality.
 *
 * Requires the archived leaf instrumentation (docs/research/057-leaf-harvest/).
 *
 *   collect: AI_BENCH_STRUCT_OUT=<shard.json> AI_BENCH_DEAL_START=5001 AI_BENCH_DEALS=50
 *   report:  AI_BENCH_STRUCT_MERGE=<shard dir>
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AiDecisionContext } from "../src/core/ai/index.js";
import {
  rankMasterPlayActions,
  setDecisionSink,
  type DecisionLeafRecord,
} from "../src/core/ai/master-policy.js";
import { SEAT_ORDER } from "../src/core/game/index.js";
import { formatPercent } from "./ai-stats.js";
import { createRecorder, readConfig, report, runPairTournament } from "./ai-tournament.js";

const COLLECT_OUT = process.env.AI_BENCH_STRUCT_OUT;
const MERGE_DIR = process.env.AI_BENCH_STRUCT_MERGE;
/** Frozen by the H4 threshold rule: rootMinHand <= 2. */
const ELIGIBLE_ROOT_MIN_HAND = 2;
const ROOT_ANALYZER_NODES = 220;

type Structure = Readonly<{ worlds: number; plies: number; label: string }>;

const STRUCTURES: readonly Structure[] = Object.freeze([
  Object.freeze({ worlds: 8, plies: 3, label: "8x3 (shipped)" }),
  Object.freeze({ worlds: 4, plies: 6, label: "4x6" }),
  Object.freeze({ worlds: 6, plies: 4, label: "6x4" }),
]);

type Aggregate = {
  decisions: number;
  trajectories: number;
  terminal: number;
  decisionsWithTerminal: number;
  /** Terminal trajectories per decision, for the distribution. */
  perDecision: number[];
  /** Trajectories that ran the full depth (no winner cut them short). */
  fullDepth: number;
};

function emptyAggregate(): Aggregate {
  return { decisions: 0, trajectories: 0, terminal: 0, decisionsWithTerminal: 0, perDecision: [], fullDepth: 0 };
}

type ShardDump = Readonly<{ shard: { dealStart: number; deals: number }; aggregates: Record<string, Aggregate> }>;

function loadShards(directory: string): readonly ShardDump[] {
  const shards: ShardDump[] = [];
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".json")).sort()) {
    const parsed = JSON.parse(readFileSync(join(directory, name), "utf8")) as Partial<ShardDump>;
    if (parsed.aggregates !== undefined) {
      shards.push(parsed as ShardDump);
    }
  }
  return shards;
}

describe.runIf(COLLECT_OUT !== undefined || MERGE_DIR !== undefined)("H4 structure preflight", () => {
  it("measures terminal trajectory rate per structure, or reports it", () => {
    if (MERGE_DIR !== undefined) {
      const shards = loadShards(MERGE_DIR);
      expect(shards.length).toBeGreaterThan(0);
      const merged = new Map<string, Aggregate>();
      for (const structure of STRUCTURES) {
        merged.set(structure.label, emptyAggregate());
      }
      for (const shard of shards) {
        for (const [label, aggregate] of Object.entries(shard.aggregates)) {
          const target = merged.get(label) ?? emptyAggregate();
          target.decisions += aggregate.decisions;
          target.trajectories += aggregate.trajectories;
          target.terminal += aggregate.terminal;
          target.decisionsWithTerminal += aggregate.decisionsWithTerminal;
          target.fullDepth += aggregate.fullDepth;
          target.perDecision.push(...aggregate.perDecision);
          merged.set(label, target);
        }
      }

      report(`\n== H4 structure preflight (eligible roots: rootMinHand <= ${ELIGIBLE_ROOT_MIN_HAND}) ==`);
      const rows: { label: string; rate: number; decisions: number }[] = [];
      for (const structure of STRUCTURES) {
        const aggregate = merged.get(structure.label) ?? emptyAggregate();
        const rate = aggregate.trajectories === 0 ? 0 : aggregate.terminal / aggregate.trajectories;
        rows.push({ label: structure.label, rate, decisions: aggregate.decisions });
        report(
          `${structure.label.padEnd(16)} decisions=${String(aggregate.decisions).padStart(5)} ` +
          `trajectories=${String(aggregate.trajectories).padStart(7)} ` +
          `terminal=${String(aggregate.terminal).padStart(6)} ` +
          `RATE=${formatPercent(rate).padStart(7)}  ` +
          `anyTerminal=${formatPercent(aggregate.decisions === 0 ? 0 : aggregate.decisionsWithTerminal / aggregate.decisions).padStart(7)}  ` +
          `fullDepth=${formatPercent(aggregate.trajectories === 0 ? 0 : aggregate.fullDepth / aggregate.trajectories).padStart(7)}`,
        );
      }

      const [shipped, four, six] = rows;
      report(``);
      report(`selection rule (frozen before the data): higher terminal trajectory rate wins;`);
      report(`on an exact tie at the displayed precision, pick 6x4 for determinization diversity.`);
      if (shipped !== undefined && four !== undefined && six !== undefined) {
        const contenders = [four, six].sort((left, right) => right.rate - left.rate);
        const winner = contenders[0];
        const runnerUp = contenders[1];
        const tie = winner !== undefined && runnerUp !== undefined &&
          winner.rate.toFixed(6) === runnerUp.rate.toFixed(6);
        const chosen = tie ? (six.rate >= four.rate ? six : four) : winner;
        report(
          `\nchosen structure: ${chosen?.label}  ` +
          `(rate ${formatPercent(chosen?.rate ?? 0)}, shipped at ${formatPercent(shipped.rate)}; ` +
          `${tie ? "exact tie -> 6x4" : "higher rate wins"})`,
        );
        report(
          `NOTE: this says which structure generates the terminal information H4 wants. ` +
          `It is NOT evidence that the structure searches better — only the Discovery V2 paired A/B can say that.`,
        );
      }
      return;
    }

    const config = readConfig();
    expect(config.designed).toBe(true);
    const recorder = createRecorder();
    const aggregates = new Map<string, Aggregate>();
    for (const structure of STRUCTURES) {
      aggregates.set(structure.label, emptyAggregate());
    }
    let decisionIndex = 0;
    let eligible = 0;

    runPairTournament(config, "master", "default", recorder, {
      masterProposal: (context: AiDecisionContext) => {
        if (context.kind !== "play") {
          return;
        }
        decisionIndex += 1;
        const counts = context.view.remainingCardCounts;
        const rootMinHand = Math.min(...SEAT_ORDER.map((seat) => counts[seat] ?? 0));
        if (rootMinHand > ELIGIBLE_ROOT_MIN_HAND) {
          return;
        }
        eligible += 1;

        for (const structure of STRUCTURES) {
          const aggregate = aggregates.get(structure.label) ?? emptyAggregate();
          let captured: DecisionLeafRecord | null = null;
          setDecisionSink((record) => {
            captured = record;
          });
          try {
            rankMasterPlayActions(context, {
              // Same seed across structures, so the first worlds of a wider
              // structure are the same worlds a narrower one sees.
              seed: (20_260_920 + decisionIndex * 7919) >>> 0,
              maxWorlds: structure.worlds,
              rolloutDepth: structure.plies,
              rootAnalyzerNodes: ROOT_ANALYZER_NODES,
            });
          } finally {
            setDecisionSink(null);
          }
          const record = captured as DecisionLeafRecord | null;
          if (record === null) {
            continue;
          }
          let terminal = 0;
          for (const leaf of record.leaves) {
            if (leaf.winner !== null) {
              terminal += 1;
            }
          }
          aggregate.decisions += 1;
          aggregate.trajectories += record.leaves.length;
          aggregate.terminal += terminal;
          aggregate.fullDepth += record.leaves.length - terminal;
          if (terminal > 0) {
            aggregate.decisionsWithTerminal += 1;
          }
          aggregate.perDecision.push(terminal);
          aggregates.set(structure.label, aggregate);
        }
      },
    });

    report(`eligible roots ${eligible} of ${decisionIndex} decisions`);
    if (COLLECT_OUT !== undefined) {
      writeFileSync(COLLECT_OUT, `${JSON.stringify({
        shard: { dealStart: config.dealStart, deals: config.deals },
        aggregates: Object.fromEntries(aggregates),
      })}\n`, "utf8");
    }
    expect(eligible).toBeGreaterThan(0);
  });
});
