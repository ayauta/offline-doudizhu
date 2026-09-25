/**
 * E3 preflight: does the unanchored proposal actually change the third candidate?
 *
 * Spec 058's effect gate. It answers one mechanical question — "A2 ∪ U1 really
 * swaps out the shipped third candidate, or not?" — and deliberately answers
 * nothing about strength. No rollout leaves, no game outcomes.
 *
 * Collection runs the real `master:default` pair on the calibration seeds with
 * a designed deadline, observing each master root context and computing the
 * proposal the E3 challenger would use. The observer costs wall-clock, which is
 * why it must not run under a deadline: at 120 ms that cost could change a move.
 *
 *   collect: AI_BENCH_E3_OUT=<shard.json> AI_BENCH_DEAL_START=5001 AI_BENCH_DEALS=50
 *   report:  AI_BENCH_E3_MERGE=<shard dir>
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  rankPlayActionsWithProposal,
  type ScoredActionDetail,
  type ScoredPlayAction,
} from "../src/core/ai/enhanced.js";
import type { AiDecisionContext } from "../src/core/ai/index.js";
import { formatPercent } from "./ai-stats.js";
import { createRecorder, readConfig, report, runPairTournament } from "./ai-tournament.js";

const COLLECT_OUT = process.env.AI_BENCH_E3_OUT;
const MERGE_DIR = process.env.AI_BENCH_E3_MERGE;
/** Root analyzer allowance, mirrored from ENHANCED_AI_SEARCH.rootAnalyzerNodes. */
const ROOT_ANALYZER_NODES = 220;

type ActionRecord = Readonly<{
  key: string;
  baseScore: number;
  prior: number;
  anchoredScore: number;
}>;

type ProposalRecord = Readonly<{
  seat: string;
  landlord: string;
  role: "landlord" | "peasant";
  legalActions: number;
  anchorTop: readonly ActionRecord[];
  unanchoredTop: readonly ActionRecord[];
  baselineThird: string | null;
  challengerThird: string | null;
  /** True when the E3 challenger's third candidate differs from the shipped one. */
  intervention: boolean;
}>;

type ShardDump = Readonly<{ shard: { dealStart: number; deals: number }; records: readonly ProposalRecord[] }>;

/** A stable identity for a legal action: its cards, which `generateLegalActions` keeps unique. */
function keyOf(action: ScoredActionDetail["action"]): string {
  return action.type === "pass" ? "pass" : action.play.cards.join(",");
}

function actionKey(detail: ScoredActionDetail): string {
  return keyOf(detail.action);
}

function toRecord(detail: ScoredActionDetail): ActionRecord {
  return Object.freeze({
    key: actionKey(detail),
    baseScore: detail.baseScore,
    prior: detail.prior,
    anchoredScore: detail.anchoredScore,
  });
}

function collectShards(directory: string): readonly ShardDump[] {
  const shards: ShardDump[] = [];
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".json")).sort()) {
    const parsed = JSON.parse(readFileSync(join(directory, name), "utf8")) as Partial<ShardDump>;
    if (Array.isArray(parsed.records)) {
      shards.push(parsed as ShardDump);
    }
  }
  return shards;
}

function summarize(records: readonly ProposalRecord[], label: string): void {
  const eligible = records.filter((record) => record.legalActions >= 3);
  const interventions = eligible.filter((record) => record.intervention);
  const overlap3 = new Map<number, number>();
  for (const record of eligible) {
    const anchored = new Set(record.anchorTop.map((entry) => entry.key));
    const shared = record.unanchoredTop.filter((entry) => anchored.has(entry.key)).length;
    overlap3.set(shared, (overlap3.get(shared) ?? 0) + 1);
  }
  const byRole = (role: "landlord" | "peasant") => {
    const subset = eligible.filter((record) => record.role === role);
    const hit = subset.filter((record) => record.intervention).length;
    return `${role} ${hit}/${subset.length} (${formatPercent(subset.length === 0 ? 0 : hit / subset.length)})`;
  };

  report(`\n-- ${label} --`);
  report(`root decisions     ${records.length}`);
  report(`eligible (>=3)     ${eligible.length} (${formatPercent(records.length === 0 ? 0 : eligible.length / records.length)})`);
  report(`intervention count ${interventions.length}`);
  report(`intervention rate  ${formatPercent(eligible.length === 0 ? 0 : interventions.length / eligible.length)} of eligible`);
  report(`overlap rate       ${formatPercent(eligible.length === 0 ? 0 : 1 - interventions.length / eligible.length)}`);
  report(`by role            ${byRole("landlord")}   ${byRole("peasant")}`);
  report(
    `top3 overlap       ${
      [...overlap3.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([shared, count]) => `${shared}/3:${count}`)
        .join("  ")
    }`,
  );
}

describe.runIf(COLLECT_OUT !== undefined || MERGE_DIR !== undefined)("E3 preflight", () => {
  it("collects or merges the root proposal comparison", () => {
    if (MERGE_DIR !== undefined) {
      const shards = collectShards(MERGE_DIR);
      expect(shards.length).toBeGreaterThan(0);
      const records = shards.flatMap((shard) => shard.records);
      report(`\n== E3 preflight (${shards.length} shard(s), ${records.length} root decisions) ==`);
      summarize(records, "all shards");
      const eligible = records.filter((record) => record.legalActions >= 3);
      const interventions = eligible.filter((record) => record.intervention).length;
      report(
        interventions === 0
          ? "STOP: intervention count = 0 — the source never produces a new third candidate."
          : `PROCEED: interventions exist, so E3-A decides whether they are worth anything.`,
      );
      // The pre-registered gate, and the only one: the intervention did not
      // happen at all. Not a rate threshold — any non-zero count proceeds.
      expect(interventions).toBeGreaterThan(0);
      return;
    }

    const config = readConfig();
    expect(config.designed, "preflight must run designed; a deadline would make the observer cost behavioural").toBe(true);
    const recorder = createRecorder();
    const records: ProposalRecord[] = [];

    runPairTournament(config, "master", "default", recorder, {
      masterProposal: (context: AiDecisionContext) => {
        if (context.kind !== "play") {
          return;
        }
        const proposal = rankPlayActionsWithProposal(context, "expert", {
          analyzerNodes: ROOT_ANALYZER_NODES,
        });
        // `anchored` and `unanchored` are orderings of the same detail records,
        // so every entry has one; a miss would mean the two orderings came from
        // different evaluations, which must never pass silently.
        const detailByAction = new Map(proposal.details.map((entry) => [entry.action, entry]));
        const detailOf = (entry: ScoredPlayAction): ScoredActionDetail => {
          const detail = detailByAction.get(entry.action);
          if (detail === undefined) {
            throw new Error("E3 preflight: an ordering entry has no detail record");
          }
          return detail;
        };

        const anchorTop2Keys = new Set(proposal.anchored.slice(0, 2).map((entry) => keyOf(entry.action)));
        const third = proposal.anchored[2];
        const novel = proposal.unanchored.find((entry) => !anchorTop2Keys.has(keyOf(entry.action)));
        const baselineThird = third === undefined ? null : keyOf(third.action);
        const challengerThird = novel === undefined ? null : keyOf(novel.action);

        if (context.legalActions.length >= 3) {
          // The invariant that keeps the two arms' root-level structural search
          // budget equal: with three or more legal actions, A2 plus the first
          // novel unanchored action must still yield three candidates.
          expect(
            challengerThird,
            "a >=3-action decision must yield a third candidate from the unanchored ordering",
          ).not.toBeNull();
        }

        records.push(Object.freeze({
          seat: context.view.seat,
          landlord: context.view.landlord,
          role: context.view.seat === context.view.landlord ? "landlord" : "peasant",
          legalActions: context.legalActions.length,
          anchorTop: Object.freeze(proposal.anchored.slice(0, 3).map((entry) => toRecord(detailOf(entry)))),
          unanchoredTop: Object.freeze(proposal.unanchored.slice(0, 3).map((entry) => toRecord(detailOf(entry)))),
          baselineThird,
          challengerThird,
          intervention: baselineThird !== challengerThird,
        }));
      },
    });

    report(`collected ${records.length} root proposals for deals ${config.dealStart}..${config.dealStart + config.deals - 1}`);
    if (COLLECT_OUT !== undefined) {
      writeFileSync(COLLECT_OUT, `${JSON.stringify({
        shard: { dealStart: config.dealStart, deals: config.deals },
        records,
      })}\n`, "utf8");
      report(`wrote ${COLLECT_OUT}`);
    }
    expect(records.length).toBeGreaterThan(0);
  });
});
