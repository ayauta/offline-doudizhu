/**
 * Spec 054 probe: how often do the two arms choose differently, and where does
 * that concentration sit? The answer sets the harvest size, so it must be
 * measured rather than assumed.
 */

import { describe, expect, it } from "vitest";

import { tally } from "./categories.js";
import { runProbe } from "./harvest.js";

const DEALS = Number(process.env.AI_DIAG_DEALS ?? "20");
const SEED = Number(process.env.AI_DIAG_SEED ?? "301");
const STRONG = (process.env.AI_DIAG_PROFILE ?? "expert") as "expert" | "master";

function table(
  label: string,
  buckets: readonly { at: number; decisions: number; divergences: number }[],
): string {
  const rows = buckets.map((bucket) => {
    const rate = bucket.decisions === 0 ? 0 : (bucket.divergences / bucket.decisions) * 100;
    return `  ${label} ${String(bucket.at).padStart(2)} | ${String(bucket.decisions).padStart(5)} decisions | ${String(bucket.divergences).padStart(4)} divergences | ${rate.toFixed(1).padStart(5)}%`;
  });
  return [`  ${label} value | decisions | divergences | rate`, ...rows].join("\n");
}

describe("spec 054 divergence probe", () => {
  it(`probes ${String(DEALS)} deals at seed ${String(SEED)} with ${STRONG}`, async () => {
    const started = Date.now();
    const run = await runProbe({ seedBase: SEED, deals: DEALS, strongProfile: STRONG });
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const rate = run.decisions === 0 ? 0 : (run.divergences / run.decisions) * 100;

    const diverging = run.records.filter((record) => record.diverges);
    const hand = (record: (typeof run.records)[number]): string =>
      Object.entries(record.handCounts)
        .map(([rank, count]) => rank.repeat(count))
        .join(" ");
    const detail = diverging.slice(0, 12).map((record) =>
      `  ${record.arm} ${record.seat}(${String(record.handSize)}c) ${hand(record)} | shipped ${record.shippedEstimate} cand ${record.candidateEstimate} true ${record.trueTurns === null ? "n/a" : String(record.trueTurns)} | shipped chose ${record.shippedChoice} cand chose ${record.candidateChoice}`,
    );
    const measured = run.records.filter((record) => record.trueTurns !== null);
    const overOptimistic = measured.filter(
      (record) => record.shippedEstimate < (record.trueTurns ?? 0),
    ).length;
    const candidateOff = measured.filter(
      (record) => record.candidateEstimate !== (record.trueTurns ?? 0),
    ).length;

    console.log(
      [
        "",
        `strong=${run.strongProfile} deals=${String(run.deals)} seeds=${String(SEED)}..${String(SEED + run.deals - 1)}`,
        `decisions=${String(run.decisions)} divergences=${String(run.divergences)} (${rate.toFixed(2)}%)`,
        `order-only diffs=${String(run.orderOnlyDiffs)}`,
        `elapsed=${elapsed}s  (${(Number(elapsed) / run.deals).toFixed(2)}s/deal)`,
        "",
        "divergence by hand size",
        table("hand", run.byHandSize),
        "",
        "divergence by legal action count",
        table("actions", run.byLegalActionCount),
        "",
        "divergence by category (every decision, so a zero row stays visible)",
        ...tally(run.records).map((entry) => {
          const rate = entry.decisions === 0 ? 0 : (entry.divergences / entry.decisions) * 100;
          return `  ${entry.category.padEnd(28)} ${String(entry.decisions).padStart(5)} decisions | ${String(entry.divergences).padStart(4)} divergences | ${rate.toFixed(1).padStart(5)}%`;
        }),
        "",
        `estimate vs exhaustive truth (hands <= 12 cards, n=${String(measured.length)}):`,
        `  shipped estimate below truth: ${String(overOptimistic)}`,
        `  candidate estimate differs from truth: ${String(candidateOff)}`,
        "",
        `first ${String(Math.min(12, diverging.length))} of ${String(diverging.length)} divergences:`,
        ...detail,
        "",
      ].join("\n"),
    );

    expect(run.decisions).toBeGreaterThan(0);
    expect(run.divergences).toBeLessThanOrEqual(run.decisions);
  });
});
