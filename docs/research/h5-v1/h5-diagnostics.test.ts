/**
 * TEMPORARY E5-A gate diagnostics — not for commit.
 *
 * Counts, per master decision in the challenger arm's own trajectories, what the
 * confidence gate did: how often it opened, on how many candidates, in which
 * direction, and how often the gated blend would have chosen a different root
 * action than production's blend on the *same* trajectories.
 *
 * Observation only. It requires the archived instrumentation seam
 * (`setGateSink`, docs/research/h5-v1/), which cannot change a decision, and it
 * runs designed so that even the observer's own cost cannot.
 *
 *   collect: AI_BENCH_H5_DIAG_OUT=<shard.json> AI_BENCH_DEALS=50 AI_BENCH_DEAL_START=30001
 *   report:  AI_BENCH_H5_DIAG_MERGE=<shard dir>
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { setGateSink, type GateDecisionRecord } from "../src/core/ai/master-policy.js";
import { formatPercent } from "./ai-stats.js";
import { createRecorder, readConfig, report, runPairTournament } from "./ai-tournament.js";

const COLLECT_OUT = process.env.AI_BENCH_H5_DIAG_OUT;
const MERGE_DIR = process.env.AI_BENCH_H5_DIAG_MERGE;

type VerdictTally = Readonly<Record<string, number>>;

type Shard = Readonly<{
  shard: Readonly<{ dealStart: number; deals: number }>;
  decisions: number;
  byRole: Readonly<Record<string, number>>;
  verdicts: VerdictTally;
  gatedCandidates: number;
  candidates: number;
  decisionsWithGate: number;
  decisionsWhoseChoiceMoves: number;
  zeroWorldDecisions: number;
  gatedTerminalTrajectories: number;
  commands: readonly string[];
}>;

function emptyTally(): Record<string, number> {
  return { none: 0, win: 0, loss: 0, conflicting: 0 };
}

function loadShards(directory: string): readonly Shard[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")) as Shard);
}

describe.runIf(COLLECT_OUT !== undefined || MERGE_DIR !== undefined)("E5-A gate diagnostics", () => {
  it("counts what the gate did, or reports it", () => {
    if (MERGE_DIR !== undefined) {
      const shards = loadShards(MERGE_DIR as string);
      expect(shards.length).toBeGreaterThan(0);
      const total = {
        decisions: 0,
        candidates: 0,
        gatedCandidates: 0,
        decisionsWithGate: 0,
        decisionsWhoseChoiceMoves: 0,
        zeroWorldDecisions: 0,
        gatedTerminalTrajectories: 0,
      };
      const verdicts = emptyTally();
      const byRole: Record<string, number> = {};
      for (const shard of shards) {
        total.decisions += shard.decisions;
        total.candidates += shard.candidates;
        total.gatedCandidates += shard.gatedCandidates;
        total.decisionsWithGate += shard.decisionsWithGate;
        total.decisionsWhoseChoiceMoves += shard.decisionsWhoseChoiceMoves;
        total.zeroWorldDecisions += shard.zeroWorldDecisions;
        total.gatedTerminalTrajectories += shard.gatedTerminalTrajectories;
        for (const [name, count] of Object.entries(shard.verdicts)) {
          verdicts[name] = (verdicts[name] ?? 0) + count;
        }
        for (const [name, count] of Object.entries(shard.byRole)) {
          byRole[name] = (byRole[name] ?? 0) + count;
        }
      }
      const share = (value: number, of: number) => formatPercent(of === 0 ? 0 : value / of);
      report(`\n== E5-A gate diagnostics (${shards.length} shard(s)) ==`);
      report(`master play decisions   ${total.decisions}`);
      report(`zero-world decisions    ${total.zeroWorldDecisions}`);
      report(
        `gate opened on a decision ${total.decisionsWithGate} (${share(total.decisionsWithGate, total.decisions)})`,
      );
      report(
        `gated candidates          ${total.gatedCandidates} of ${total.candidates} ` +
        `(${share(total.gatedCandidates, total.candidates)})`,
      );
      report(
        `verdicts per candidate    ${
          Object.entries(verdicts).sort().map(([name, count]) => `${name}:${count}`).join("  ")
        }`,
      );
      report(`gated terminal trajectories ${total.gatedTerminalTrajectories}`);
      report(
        `choice would move         ${total.decisionsWhoseChoiceMoves} ` +
        `(${share(total.decisionsWhoseChoiceMoves, total.decisions)}) — production's blend vs the ` +
        `gated blend on the *same* trajectories`,
      );
      report(
        `by root side               ${
          Object.entries(byRole).sort().map(([name, count]) => `${name}:${count}`).join("  ")
        }`,
      );
      expect(total.decisions).toBeGreaterThan(0);
      return;
    }

    const config = readConfig();
    expect(config.designed, "diagnostics must run designed").toBe(true);
    const recorder = createRecorder({ logCommands: true });
    const byRole: Record<string, number> = {};
    const verdicts = emptyTally();
    let decisions = 0;
    let candidates = 0;
    let gatedCandidates = 0;
    let decisionsWithGate = 0;
    let decisionsWhoseChoiceMoves = 0;
    let zeroWorldDecisions = 0;
    let gatedTerminalTrajectories = 0;

    setGateSink((record: GateDecisionRecord) => {
      decisions += 1;
      candidates += record.candidates.length;
      if (record.completedWorlds === 0) {
        zeroWorldDecisions += 1;
      }
      const role = record.seat === record.landlord ? "landlord" : "peasant";
      let gatedHere = 0;
      for (const candidate of record.candidates) {
        verdicts[candidate.verdict] = (verdicts[candidate.verdict] ?? 0) + 1;
        if (candidate.verdict === "win" || candidate.verdict === "loss") {
          gatedCandidates += 1;
          gatedHere += 1;
          gatedTerminalTrajectories += candidate.terminalCount;
        }
      }
      if (gatedHere > 0) {
        decisionsWithGate += 1;
        byRole[role] = (byRole[role] ?? 0) + 1;
      }
      if (record.productionChoice !== record.gatedChoice) {
        decisionsWhoseChoiceMoves += 1;
      }
    });
    try {
      runPairTournament(config, "master", "default", recorder);
    } finally {
      setGateSink(null);
    }

    const shard: Shard = Object.freeze({
      shard: Object.freeze({ dealStart: config.dealStart, deals: config.deals }),
      decisions,
      byRole: Object.freeze({ ...byRole }),
      verdicts: Object.freeze({ ...verdicts }),
      gatedCandidates,
      candidates,
      decisionsWithGate,
      decisionsWhoseChoiceMoves,
      zeroWorldDecisions,
      gatedTerminalTrajectories,
      commands: Object.freeze(recorder.commands ?? []),
    });
    report(
      `diagnostics: deals ${config.dealStart}..${config.dealStart + config.deals - 1}  ` +
      `decisions=${decisions} gatedCandidates=${gatedCandidates} ` +
      `decisionsWithGate=${decisionsWithGate} choiceMoves=${decisionsWhoseChoiceMoves}`,
    );
    if (COLLECT_OUT !== undefined) {
      writeFileSync(COLLECT_OUT, `${JSON.stringify(shard)}\n`, "utf8");
      report(`wrote ${COLLECT_OUT}`);
    }
    expect(decisions).toBeGreaterThan(0);
  });
});
