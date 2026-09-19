/**
 * Joins sharded pair-tournament dumps back into the report the unsharded
 * benchmark would have printed.
 *
 * Sharding only ever changes *which process* plays a deal. Each shard records
 * the absolute index of its first deal, so a merge places every shard's arrays
 * at the index the unsharded run would have used — the joined arrays are
 * indexed by absolute deal index, and the statistics below are computed by the
 * same `ai-stats` functions the unsharded report uses. No statistic is
 * re-derived here, and no sampling decision is taken here.
 *
 * Driven by `AI_BENCH_MERGE=<dir>` (a directory of shard dumps written by
 * `AI_BENCH_OUT`). Runs only when that variable is set, so it stays inert in
 * an ordinary `pnpm bench:ai`.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { formatPercent, summarizePair } from "./ai-stats.js";
import { report } from "./ai-tournament.js";

const MERGE_DIR = process.env.AI_BENCH_MERGE;
/** Optional: write the joined command log here, for a byte-equality check. */
const MERGE_COMMANDS_OUT = process.env.AI_BENCH_MERGE_COMMANDS_OUT;
/**
 * Optional: write the joined per-deal dump here, in the same shape a single
 * unsharded run writes. Per-deal results survive the merge — an aggregate
 * alone could not be paired against another run later.
 */
const MERGE_OUT = process.env.AI_BENCH_MERGE_OUT;

type ShardRun = {
  stronger?: string;
  weaker?: string;
  playedDeals?: number;
  stoppedEarly?: boolean;
  dealStart?: number;
  perDealA?: readonly number[];
  perDealB?: readonly number[];
  commands?: readonly string[];
};

type ShardDump = {
  label?: string;
  config?: { deals?: number; seedBase?: number; dealStart?: number; designed?: boolean };
  runs?: Record<string, ShardRun>;
};

function loadShards(directory: string): readonly ShardDump[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")) as ShardDump);
}

/** Places each shard's per-deal wins at its absolute deal index. */
function joinByDealIndex(
  shards: readonly Readonly<{ dealStart: number; values: readonly number[] }>[],
  what: string,
): { values: number[]; gaps: number; overlaps: number } {
  const values: number[] = [];
  const written = new Set<number>();
  let gaps = 0;
  let overlaps = 0;
  const ordered = [...shards].sort((left, right) => left.dealStart - right.dealStart);
  for (const shard of ordered) {
    shard.values.forEach((value, offset) => {
      const index = shard.dealStart + offset;
      if (written.has(index)) {
        overlaps += 1;
      }
      written.add(index);
      values[index] = value;
    });
  }
  for (let index = 0; index < values.length; index += 1) {
    if (!written.has(index)) {
      gaps += 1;
    }
  }
  if (gaps > 0 || overlaps > 0) {
    report(`!! ${what}: ${gaps} uncovered deal index(es), ${overlaps} overlapping write(s)`);
  }
  return { values, gaps, overlaps };
}

describe.runIf(MERGE_DIR !== undefined)("sharded benchmark merge", () => {
  it("joins shards by absolute deal index and reports the unsharded statistics", () => {
    const shards = loadShards(MERGE_DIR as string);
    expect(shards.length).toBeGreaterThan(0);

    const pairKeys = new Set<string>();
    for (const shard of shards) {
      for (const key of Object.keys(shard.runs ?? {})) {
        pairKeys.add(key);
      }
    }
    expect(pairKeys.size).toBeGreaterThan(0);

    const designed = shards.some((shard) => shard.config?.designed === true);
    report(
      `\n== sharded merge (${shards.length} shard(s): ` +
      `${shards.map((shard) => shard.label ?? "?").join(", ")}) ==` +
      (designed ? "  [designed: infinite deadline, not a shipped measurement]" : ""),
    );

    let anyGap = false;
    const joinedCommands: string[] = [];
    const mergedRuns: Record<string, unknown> = {};

    for (const key of [...pairKeys].sort()) {
      const parts = shards
        .map((shard) => ({ shard, run: shard.runs?.[key] }))
        .filter((entry): entry is { shard: ShardDump; run: ShardRun } => entry.run !== undefined);
      const first = parts[0];
      if (first === undefined) {
        continue;
      }
      const stronger = first.run.stronger ?? key.split("-")[0] ?? "?";
      const weaker = first.run.weaker ?? key.split("-")[1] ?? "?";
      const stoppedEarly = parts.some((entry) => entry.run.stoppedEarly === true);

      const armA = joinByDealIndex(
        parts.map((entry) => ({
          dealStart: entry.run.dealStart ?? entry.shard.config?.dealStart ?? 0,
          values: entry.run.perDealA ?? [],
        })),
        `${key} arm A`,
      );
      const armB = joinByDealIndex(
        parts.map((entry) => ({
          dealStart: entry.run.dealStart ?? entry.shard.config?.dealStart ?? 0,
          values: entry.run.perDealB ?? [],
        })),
        `${key} arm B`,
      );
      // Fail before reporting: a report computed over holes would be NaN, and
      // a plausible-looking number is worse than no number.
      if (armA.gaps > 0 || armA.overlaps > 0 || armB.gaps > 0 || armB.overlaps > 0) {
        anyGap = true;
        report(`!! ${key}: skipped — the shard set does not tile the deal range`);
        continue;
      }

      const pooled = armA.values.map((wins, index) => wins + (armB.values[index] ?? 0));

      report(`\n-- ${stronger} vs ${weaker} --`);
      for (const [label, perDeal, gamesPerDeal] of [
        ["arm A (strong landlord)", armA.values, 3],
        ["arm B (strong farmer)", armB.values, 3],
        ["pooled", pooled, 6],
      ] as const) {
        const summary = summarizePair(perDeal, gamesPerDeal);
        report(
          `${label.padEnd(24)} deals=${String(summary.deals).padStart(4)} ` +
          `games=${String(summary.games).padStart(5)} ` +
          `win=${formatPercent(summary.rate).padStart(6)} ` +
          `ci=[${formatPercent(summary.ciLow)}, ${formatPercent(summary.ciHigh)}] ` +
          `t=[${formatPercent(summary.ciTLow)}, ${formatPercent(summary.ciTHigh)}] ` +
          `sd=${summary.sd.toFixed(3)} ` +
          `need(0.10)=${summary.deals < 2 ? "n/a" : `${summary.requiredDeals["0.10"]} deals`}`,
        );
      }

      // Command order is the deal order, so joined shards in deal order
      // reproduce the unsharded log exactly. Only meaningful when no shard
      // stopped early — a truncated shard leaves a hole the log cannot show.
      const commands = parts
        .sort((left, right) =>
          (left.run.dealStart ?? left.shard.config?.dealStart ?? 0) -
          (right.run.dealStart ?? right.shard.config?.dealStart ?? 0))
        .flatMap((entry) => entry.run.commands ?? []);
      if (commands.length > 0) {
        joinedCommands.push(...commands);
        report(`${"commands".padEnd(24)} ${commands.length}${stoppedEarly ? " (partial: a shard stopped early)" : ""}`);
      }
      mergedRuns[key] = {
        stronger,
        weaker,
        dealStart: 0,
        playedDeals: armA.values.length,
        stoppedEarly,
        perDealA: armA.values,
        perDealB: armB.values,
        ...(commands.length === 0 ? {} : { commands }),
      };
      report(
        `${"shards".padEnd(24)} ${parts.length}` +
        `${stoppedEarly ? "  !! at least one shard stopped at its soft cap" : ""}`,
      );
    }

    if (MERGE_COMMANDS_OUT !== undefined && joinedCommands.length > 0) {
      writeFileSync(MERGE_COMMANDS_OUT, `${JSON.stringify(joinedCommands)}\n`, "utf8");
      report(`wrote ${MERGE_COMMANDS_OUT}`);
    }

    if (MERGE_OUT !== undefined) {
      writeFileSync(MERGE_OUT, `${JSON.stringify({
        label: `merged:${shards.map((shard) => shard.label ?? "?").join("+")}`,
        config: {
          deals: Math.max(...shards.map((shard) => shard.config?.deals ?? 0)),
          seedBase: shards[0]?.config?.seedBase,
          dealStart: 0,
          designed,
        },
        shards: shards.length,
        runs: mergedRuns,
      }, null, 2)}\n`, "utf8");
      report(`wrote ${MERGE_OUT}`);
    }

    // A complete shard set must tile the deal range with no hole and no
    // double-write; anything else means the shard windows were computed wrong.
    expect(anyGap).toBe(false);
  });
});
