/**
 * Root-phase collector for the H4 eligibility threshold.
 *
 * The leaf-level diagnosis showed terminal information is governed by the
 * *minimum* hand, not by the total cards in play — but the threshold has to be
 * decided at the root, several plies earlier. This collects root-level hand
 * sizes so the threshold and the intervention live on the same layer.
 *
 * It records only public, root-level facts and the identity fields needed to
 * line each record up with the already-frozen leaf corpus, which supplies the
 * terminal-leaf information. The alignment is checked, not assumed.
 *
 *   collect: AI_BENCH_ROOTPHASE_OUT=<shard.json> AI_BENCH_DEAL_START=5001 AI_BENCH_DEALS=50
 *   merge:   AI_BENCH_ROOTPHASE_MERGE=<shard dir>
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AiDecisionContext } from "../src/core/ai/index.js";
import { SEAT_ORDER } from "../src/core/game/index.js";
import { report } from "./ai-tournament.js";
import { createRecorder, readConfig, runPairTournament } from "./ai-tournament.js";

const COLLECT_OUT = process.env.AI_BENCH_ROOTPHASE_OUT;
const MERGE_DIR = process.env.AI_BENCH_ROOTPHASE_MERGE;
const LEAF_CORPUS = process.env.AI_BENCH_ROOTPHASE_CORPUS ?? ".local/calibration";

type RootRecord = Readonly<{
  /** Identity fields, so each record can be lined up with the leaf corpus. */
  seat: string;
  landlord: string;
  legalActions: number;
  /** min(remaining hands) at the root — the quantity the threshold is about. */
  rootMinHand: number;
  totalRemainingCards: number;
  candidates: number;
}>;

type ShardDump = Readonly<{ shard: { dealStart: number; deals: number }; records: readonly RootRecord[] }>;

function loadShards<T extends { records?: unknown }>(directory: string): readonly T[] {
  const shards: T[] = [];
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".json")).sort()) {
    const parsed = JSON.parse(readFileSync(join(directory, name), "utf8")) as T;
    if (Array.isArray(parsed.records)) {
      shards.push(parsed);
    }
  }
  return shards;
}

function totalOf(counts: Readonly<Record<string, number>>): number {
  return SEAT_ORDER.reduce((sum, seat) => sum + (counts[seat] ?? 0), 0);
}

function minOf(counts: Readonly<Record<string, number>>): number {
  return Math.min(...SEAT_ORDER.map((seat) => counts[seat] ?? 0));
}

describe.runIf(COLLECT_OUT !== undefined || MERGE_DIR !== undefined)("H4 root phase", () => {
  it("collects root hand sizes, or applies the frozen K rule", () => {
    if (MERGE_DIR !== undefined) {
      const roots = loadShards<ShardDump>(MERGE_DIR).flatMap((shard) => shard.records);
      // The leaf corpus stores `decisions`, not `records`, so it needs its own
      // loader rather than the shape-filtered one above.
      const corpus: { seat: string; landlord: string; legalActions: number; leaves: readonly { winner: string | null }[] }[] = [];
      for (const name of readdirSync(LEAF_CORPUS).filter((entry) => entry.endsWith(".json")).sort()) {
        const parsed = JSON.parse(readFileSync(join(LEAF_CORPUS, name), "utf8")) as {
          decisions?: typeof corpus;
        };
        if (Array.isArray(parsed.decisions)) {
          corpus.push(...parsed.decisions);
        }
      }

      report(`\n== root phase (${roots.length} root decisions, ${corpus.length} corpus decisions) ==`);
      // Alignment first: without it, joining root sizes to leaf outcomes is a
      // comparison of two different decision sequences.
      const n = Math.min(roots.length, corpus.length);
      let mismatches = 0;
      for (let index = 0; index < n; index += 1) {
        const root = roots[index];
        const leaf = corpus[index];
        if (
          root === undefined || leaf === undefined ||
          root.seat !== leaf.seat ||
          root.landlord !== leaf.landlord ||
          root.legalActions !== leaf.legalActions
        ) {
          mismatches += 1;
        }
      }
      report(`alignment mismatches ${mismatches}/${n}`);
      expect(roots.length).toBe(corpus.length);
      expect(mismatches).toBe(0);

      // The frozen K rule, applied mechanically: for each K, the terminal
      // information density of the decisions it admits, and of the margin it
      // adds. Density = share of that decision's leaves that reached a decision.
      // The rule has two clauses: coverage of the baseline's terminal
      // information, and the cliff when K grows. Coverage needs the total, so
      // it is computed before the loop rather than inferred from densities.
      let totalTerminal = 0;
      for (const leaf of corpus) {
        totalTerminal += leaf.leaves.filter((entry) => entry.winner !== null).length;
      }

      const rows: string[] = [];
      for (const K of [1, 2, 3, 4]) {
        let admitted = 0;
        let admittedTerminal = 0;
        let admittedLeaves = 0;
        let added = 0;
        let addedTerminal = 0;
        let addedLeaves = 0;
        for (let index = 0; index < n; index += 1) {
          const root = roots[index];
          const leaf = corpus[index];
          if (root === undefined || leaf === undefined) continue;
          const terminal = leaf.leaves.filter((entry) => entry.winner !== null).length;
          if (root.rootMinHand <= K) {
            admitted += 1;
            admittedTerminal += terminal;
            admittedLeaves += leaf.leaves.length;
          } else if (root.rootMinHand === K + 1) {
            added += 1;
            addedTerminal += terminal;
            addedLeaves += leaf.leaves.length;
          }
        }
        rows.push(
          `K=${K}  admits ${String(admitted).padStart(6)} decisions  ` +
          `density ${(admittedLeaves === 0 ? 0 : (admittedTerminal / admittedLeaves) * 100).toFixed(2)}%  ` +
          `coverage ${(totalTerminal === 0 ? 0 : (admittedTerminal / totalTerminal) * 100).toFixed(1)}% of all terminal leaves  |  ` +
          `adds K+1: ${String(added).padStart(5)} decisions  ` +
          `density ${(addedLeaves === 0 ? 0 : (addedTerminal / addedLeaves) * 100).toFixed(2)}%`,
        );
      }
      report(`\nroot min-hand distribution and the frozen K rule:`);
      for (const row of rows) {
        report(row);
      }
      const total = roots.length;
      const byMin = new Map<number, number>();
      for (const root of roots) {
        byMin.set(root.rootMinHand, (byMin.get(root.rootMinHand) ?? 0) + 1);
      }
      report(
        `\nrootMinHand histogram  ${
          [...byMin.entries()].sort((left, right) => left[0] - right[0])
            .map(([value, count]) => `${value}:${count}`).join("  ")
        }  (of ${total})`,
      );
      return;
    }

    const config = readConfig();
    expect(config.designed).toBe(true);
    const recorder = createRecorder();
    const records: RootRecord[] = [];
    let candidates = 0;

    runPairTournament(config, "master", "default", recorder, {
      masterProposal: (context: AiDecisionContext) => {
        if (context.kind !== "play") {
          return;
        }
        const counts = context.view.remainingCardCounts;
        candidates += 1;
        records.push(Object.freeze({
          seat: context.view.seat,
          landlord: context.view.landlord,
          legalActions: context.legalActions.length,
          rootMinHand: minOf(counts),
          totalRemainingCards: totalOf(counts),
          candidates: context.legalActions.length,
        }));
      },
    });

    report(`collected ${candidates} root decisions`);
    if (COLLECT_OUT !== undefined) {
      writeFileSync(COLLECT_OUT, `${JSON.stringify({
        shard: { dealStart: config.dealStart, deals: config.deals },
        records,
      })}\n`, "utf8");
    }
    expect(records.length).toBeGreaterThan(0);
  });
});
