/**
 * Spec 054 roll-forward: among the positions where the two arms choose
 * differently, which choice wins more often?
 *
 * The answer is a paired / crossover observation on the shipped trajectory, not
 * an estimate of the shipped win rate change. See the spec for that boundary.
 */

import { describe, expect, it } from "vitest";

import { clusterInterval } from "../ai-stats.js";
import { CATEGORY_ORDER, categorise } from "./categories.js";
import { runProbe } from "./harvest.js";
import { rollForward } from "./roll-forward.js";

const DEALS = Number(process.env.AI_DIAG_DEALS ?? "120");
const SEED = Number(process.env.AI_DIAG_SEED ?? "301");
const CAP_MS = Number(process.env.AI_DIAG_SECONDS ?? "600") * 1000;

describe("spec 054 roll-forward", () => {
  it(`rolls forward the divergences of ${String(DEALS)} deals`, async () => {
    const harvest = await runProbe({ seedBase: SEED, deals: DEALS, strongProfile: "expert" });
    const diverging = harvest.records.filter((record) => record.diverges);

    console.log(
      `\nharvest: ${String(harvest.decisions)} decisions, ${String(diverging.length)} divergences over ${String(DEALS)} deals`,
    );

    // Both roots run under the same shipped continuation. That is the honest
    // comparison here: the candidate patch cannot change the continuation
    // policy, because master's rollout scores with `estimateBasicHandTurns`,
    // which the archived patch never touched. A crossed cell would look like a
    // second policy while actually running the first.
    const run = rollForward({
      records: diverging,
      continuationProfiles: ["expert"],
      seed: SEED * 1000,
      secondsCap: CAP_MS,
    });

    const cells = new Map<string, { branches: number; wins: number }>();
    const perDealShipped = new Map<number, number[]>();
    const perDealCandidate = new Map<number, number[]>();
    for (const outcome of run.outcomes) {
      for (const cell of outcome.cells) {
        const key = `${cell.root} under ${cell.continuation}`;
        const bucket = cells.get(key) ?? { branches: 0, wins: 0 };
        bucket.branches += cell.branches;
        bucket.wins += cell.wins;
        cells.set(key, bucket);

        const rate = cell.wins / cell.branches;
        const target = cell.root === "shipped" ? perDealShipped : perDealCandidate;
        target.set(outcome.record.dealIndex, [...(target.get(outcome.record.dealIndex) ?? []), rate]);
      }
    }

    const rows = [...cells.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([key, cell]) => {
        const rate = (cell.wins / cell.branches) * 100;
        return `  ${key.padEnd(28)} ${rate.toFixed(1).padStart(5)}%  (${String(cell.wins)}/${String(cell.branches)} branch wins)`;
      });

    const mean = (values: readonly number[]): number =>
      values.reduce((total, value) => total + value, 0) / Math.max(1, values.length);
    const dealKeys = [...perDealShipped.keys()].filter((deal) => perDealCandidate.has(deal)).sort((a, b) => a - b);
    const differences = dealKeys.map((deal) =>
      mean(perDealCandidate.get(deal) ?? []) - mean(perDealShipped.get(deal) ?? []),
    );
    const delta = differences.length === 0 ? 0 : mean(differences);
    const interval = differences.length < 2 ? null : clusterInterval(differences, { resamples: 10_000, seed: 20_260_912 });

    // Per category, paired by deal. A category drawing on few deals gets a wide
    // interval on purpose -- the distinct-deal count is the honest n.
    const categoryLines = CATEGORY_ORDER.map((category) => {
      const shippedByDeal = new Map<number, number[]>();
      const candidateByDeal = new Map<number, number[]>();
      for (const outcome of run.outcomes) {
        if (categorise(outcome.record) !== category) {
          continue;
        }
        for (const cell of outcome.cells) {
          const rate = cell.wins / cell.branches;
          const target = cell.root === "shipped" ? shippedByDeal : candidateByDeal;
          target.set(outcome.record.dealIndex, [...(target.get(outcome.record.dealIndex) ?? []), rate]);
        }
      }
      const keys = [...shippedByDeal.keys()].filter((deal) => candidateByDeal.has(deal)).sort((a, b) => a - b);
      if (keys.length === 0) {
        return `  ${category.padEnd(28)} no divergences in this category`;
      }
      const diffs = keys.map(
        (deal) => mean(candidateByDeal.get(deal) ?? []) - mean(shippedByDeal.get(deal) ?? []),
      );
      const meanDelta = mean(diffs);
      const ci = diffs.length < 2
        ? null
        : clusterInterval(diffs, { resamples: 10_000, seed: 20_260_912 });
      return `  ${category.padEnd(28)} ${(meanDelta * 100).toFixed(1).padStart(6)} pp over ${String(keys.length).padStart(3)} deals  ${ci === null ? "(interval: n/a)" : `CI [${(ci.low * 100).toFixed(1)}, ${(ci.high * 100).toFixed(1)}]`}`;
    });

    console.log(
      [
        "",
        `roll-forward: ${String(run.completed)}/${String(run.attempted)} divergences, ${String(run.verified)} rebuilt verified, ${(run.elapsedMs / 1000).toFixed(1)}s${run.stoppedEarly ? " (STOPPED EARLY at the cap)" : ""}`,
        ...rows,
        "",
        `paired per-deal difference (candidate minus shipped, same continuation): ${(delta * 100).toFixed(1)} pp over ${String(dealKeys.length)} distinct deals`,
        interval === null
          ? "  interval: n/a (too few deals)"
          : `  deal-clustered 95% interval: [${(interval.low * 100).toFixed(1)}, ${(interval.high * 100).toFixed(1)}] pp`,
        "",
        "per category (candidate minus shipped, paired by deal):",
        ...categoryLines,
        "",
        "  NOTE: conditional on the shipped trajectory and this continuation; not a shipped win-rate estimate.",
        "  NOTE: categories overlap in cause; intervals are not corrected for multiplicity.",
        "",
      ].join("\n"),
    );

    // The premise of the whole design: a recorded prefix must rebuild the exact
    // position. If it does not, every number above is meaningless.
    expect(run.verified).toBe(run.completed);
    expect(run.completed).toBeGreaterThan(0);
  });
});
