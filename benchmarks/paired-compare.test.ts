/**
 * Paired comparison of two benchmark dumps over identical deals.
 *
 * Two separate aggregate win rates cannot answer "did this change help" — the
 * deals differ only in the configuration under test, so the comparison has to
 * be per deal, and its interval has to come from the per-deal differences.
 * This is the same paired method Spec 053 used, on the same statistics code.
 *
 * Also reports how often the two configurations made a *different command*.
 * That is an explanatory quantity, never a strength claim: after the first
 * divergence the game state forks, so the total count is a cascade rather than
 * a count of independent events, and the first divergence index is the honest
 * number to read.
 *
 *   AI_BENCH_PAIRED=<baseline.json>,<challenger.json> [AI_BENCH_PAIRED_PAIR=master-default]
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { clusterInterval, formatPercent, summarizePair } from "./ai-stats.js";
import { report } from "./ai-tournament.js";

type PairedRun = {
  stronger?: string;
  weaker?: string;
  perDealA?: readonly number[];
  perDealB?: readonly number[];
  commands?: readonly string[];
  stoppedEarly?: boolean;
};

type PairedDump = {
  label?: string;
  config?: Record<string, unknown>;
  runs?: Record<string, PairedRun>;
};

const PAIRED = process.env.AI_BENCH_PAIRED;
const ONLY_PAIR = process.env.AI_BENCH_PAIRED_PAIR;

function load(path: string): PairedDump {
  return JSON.parse(readFileSync(path, "utf8")) as PairedDump;
}

function line(label: string, perDeal: readonly number[], games: number): string {
  const summary = summarizePair(perDeal, games);
  return (
    `${label.padEnd(24)} deals=${String(summary.deals).padStart(4)} ` +
    `win=${formatPercent(summary.rate).padStart(6)} ` +
    `ci=[${formatPercent(summary.ciLow)}, ${formatPercent(summary.ciHigh)}]`
  );
}

describe.runIf(PAIRED !== undefined)("paired comparison", () => {
  it("compares two runs deal by deal", () => {
    const [basePath, candPath] = (PAIRED as string).split(",");
    expect(basePath, "AI_BENCH_PAIRED must be <baseline.json>,<challenger.json>").toBeDefined();
    expect(candPath).toBeDefined();

    const base = load(basePath as string);
    const cand = load(candPath as string);
    report(`\n== paired comparison ==`);
    report(`baseline    ${basePath}  (${base.label ?? "?"})`);
    report(`challenger  ${candPath}  (${cand.label ?? "?"})`);
    report(`configs     ${JSON.stringify(base.config)} vs ${JSON.stringify(cand.config)}`);

    const keys = Object.keys(base.runs ?? {})
      .filter((key) => ONLY_PAIR === undefined || key === ONLY_PAIR)
      .sort();
    expect(keys.length).toBeGreaterThan(0);

    for (const key of keys) {
      const runBase = base.runs?.[key];
      const runCand = cand.runs?.[key];
      expect(runBase, `baseline is missing pair ${key}`).toBeDefined();
      expect(runCand, `challenger is missing pair ${key}`).toBeDefined();
      const a = runBase as PairedRun;
      const b = runCand as PairedRun;

      const deals = Math.min(a.perDealA?.length ?? 0, b.perDealA?.length ?? 0);
      expect(deals).toBeGreaterThan(0);
      if ((a.perDealA?.length ?? 0) !== (b.perDealA?.length ?? 0)) {
        report(
          `!! deal counts differ (${a.perDealA?.length} vs ${b.perDealA?.length}); ` +
          `comparing the first ${deals}`,
        );
      }

      report(`\n-- ${key} --`);
      const arms: ReadonlyArray<readonly [string, readonly number[], readonly number[], number]> = [
        ["arm A (strong landlord)", (a.perDealA ?? []).slice(0, deals), (b.perDealA ?? []).slice(0, deals), 3],
        ["arm B (strong farmer)", (a.perDealB ?? []).slice(0, deals), (b.perDealB ?? []).slice(0, deals), 3],
        [
          "pooled",
          (a.perDealA ?? []).slice(0, deals).map((wins, index) => wins + ((a.perDealB ?? [])[index] ?? 0)),
          (b.perDealA ?? []).slice(0, deals).map((wins, index) => wins + ((b.perDealB ?? [])[index] ?? 0)),
          6,
        ],
      ];

      for (const [label, baseDeals, candDeals, games] of arms) {
        report(line(`${label} baseline`, baseDeals, games));
        report(line(`${label} challenger`, candDeals, games));
        // Per-deal difference in rate units, then a deal-clustered bootstrap.
        const differences = baseDeals.map(
          (wins, index) => ((candDeals[index] ?? 0) - wins) / games,
        );
        const mean = differences.reduce((sum, value) => sum + value, 0) / differences.length;
        const ci = clusterInterval(differences, { seed: 20_260_919 });
        // Three decimals: an interval whose bound decides "is the effect
        // distinguishable from zero" must not be read off a rounded number.
        report(
          `${label.padEnd(24)} PAIRED Δ ${formatPercent(mean, 3).padStart(8)} ` +
          `95% CI [${formatPercent(ci.low, 3)}, ${formatPercent(ci.high, 3)}]`,
        );
      }

      // Deal-level transitions on the pooled view.
      const pooledBase = arms[2]?.[1] ?? [];
      const pooledCand = arms[2]?.[2] ?? [];
      let challengerWorse = 0;
      let challengerBetter = 0;
      let tied = 0;
      const swingHistogram = new Map<number, number>();
      for (let index = 0; index < deals; index += 1) {
        const baseWins = pooledBase[index] ?? 0;
        const candWins = pooledCand[index] ?? 0;
        const swing = candWins - baseWins;
        swingHistogram.set(swing, (swingHistogram.get(swing) ?? 0) + 1);
        if (swing > 0) challengerBetter += 1;
        else if (swing < 0) challengerWorse += 1;
        else tied += 1;
      }
      report(
        `\ndeal transitions (pooled, out of 6 games each)  ` +
        `challenger better ${challengerBetter} / worse ${challengerWorse} / tie ${tied}`,
      );
      report(
        `swing histogram  ${
          [...swingHistogram.entries()]
            .sort((left, right) => left[0] - right[0])
            .map(([swing, count]) => `${swing > 0 ? "+" : ""}${swing}:${count}`)
            .join(" ")
        }`,
      );

      if (a.commands !== undefined && b.commands !== undefined) {
        const n = Math.min(a.commands.length, b.commands.length);
        let firstDifference = -1;
        let differing = 0;
        for (let index = 0; index < n; index += 1) {
          if (a.commands[index] !== b.commands[index]) {
            differing += 1;
            if (firstDifference < 0) firstDifference = index;
          }
        }
        report(
          `\ndecision divergence  ${differing}/${n} commands differ ` +
          `(${formatPercent(n === 0 ? 0 : differing / n)}); first at #${firstDifference}` +
          (differing > 0 ? " — everything after it is a cascade of that fork" : ""),
        );
        if (firstDifference >= 0) {
          report(`  baseline   ${a.commands[firstDifference]}`);
          report(`  challenger ${b.commands[firstDifference]}`);
        }
      }
    }
  });
});
