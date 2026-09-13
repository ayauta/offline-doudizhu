/**
 * How large is the unknown, from the acting seat's point of view?
 *
 * The bottom cards are public to every seat (`PlayingPlayerView.bottomCards`),
 * and so is every play and every seat's remaining count. So for a seat holding
 * `own`, the remaining cards split between the two other seats, and the public
 * information pins down a great deal:
 *
 *  - **Farmers against a landloard.** The landlord's hand is forced: it holds
 *    `pool − partnerCards`, and the partner's count is public, so the landlord's
 *    cards are literally `pool` minus the partner's. Only the **partner's** cards
 *    are unknown, and there are `C(pool, partnerCards)` ways to choose them.
 *  - **The landlord against two farmers.** Both hands are unknown inside `pool`,
 *    so there are `C(pool, min(f1, f2))` ways.
 *
 * The unknown is therefore `C(pool, k)` for the *smaller* of the two opponent
 * hands, not the whole pool. An earlier version of this probe measured the pool
 * alone and so overstated how much is hidden.
 *
 * Research scaffolding. Delete with the rest of `benchmarks/diagnosis/`.
 */

import { describe, expect, it } from "vitest";

import { runProbe } from "./harvest.js";
import type { ProbeRecord } from "./harvest.js";

const DEALS = Number(process.env.AI_DET_DEALS ?? "40");
const SEATS = ["human", "ai-one", "ai-two"] as const;

type Reading = Readonly<{
  pool: number;
  /** Cards of the least-known opponent; the exponent of the combination. */
  unknownCards: number;
  combinations: number;
  conservation: number;
}>;

/** Binomial coefficient, saturating so a huge count cannot overflow the report. */
function choose(n: number, k: number): number {
  const smaller = Math.min(k, n - k);
  if (smaller < 0) {
    return 0;
  }
  let value = 1;
  for (let index = 1; index <= smaller; index += 1) {
    value = (value * (n - index + 1)) / index;
    if (value > 1e15) {
      return Number.POSITIVE_INFINITY;
    }
  }
  return Math.round(value);
}

function read(record: ProbeRecord): Reading {
  const snapshot = record.snapshot;
  let played = 0;
  for (const entry of snapshot.history) {
    const play = entry as { type?: string; play?: { cards?: readonly number[] } };
    played += play.play?.cards?.length ?? 0;
  }
  const others = SEATS.filter((seat) => seat !== snapshot.seat).map(
    (seat) => snapshot.remainingCardCounts[seat],
  );
  const pool = others.reduce((total, count) => total + count, 0);
  const unknownCards = Math.min(...others);
  return {
    pool,
    unknownCards,
    combinations: choose(pool, unknownCards),
    conservation: SEATS.reduce((total, seat) => total + snapshot.remainingCardCounts[seat], 0) + played,
  };
}

describe("unknown size at a master decision", () => {
  it(`reads ${String(DEALS)} deals`, async () => {
    const run = await runProbe({ seedBase: 301, deals: DEALS, strongProfile: "master", quiet: true });

    const actors = new Map<string, { decisions: number; sum: number }>();
    const buckets = new Map<number, number>();
    let conservationFailures = 0;
    let checked = 0;

    for (const record of run.records) {
      const reading = read(record);
      checked += 1;
      if (reading.conservation !== 54) {
        conservationFailures += 1;
      }
      buckets.set(reading.unknownCards, (buckets.get(reading.unknownCards) ?? 0) + 1);
      const role = record.seat === record.landlord ? "landlord" : "farmer";
      const entry = actors.get(role) ?? { decisions: 0, sum: 0 };
      entry.decisions += 1;
      entry.sum += reading.combinations === Number.POSITIVE_INFINITY ? 1e15 : reading.combinations;
      actors.set(role, entry);
    }

    const total = Math.max(1, checked);
    const sorted = [...buckets.entries()].sort((left, right) => left[0] - right[0]);
    const cumulative = (limit: number): number =>
      sorted.filter(([cards]) => cards <= limit).reduce((sum, [, count]) => sum + count, 0);

    console.log(
      [
        "",
        `master decisions: ${String(checked)} over ${String(DEALS)} deals`,
        `conservation failures: ${String(conservationFailures)}`,
        "",
        "unknown cards (the smaller opponent's hand) | decisions | cumulative",
        ...sorted.map(([cards, count]) =>
          `  ${String(cards).padStart(2)} | ${String(count).padStart(9)} | ${((cumulative(cards) / total) * 100).toFixed(1).padStart(5)}%`),
        "",
        ...["landlord", "farmer"].map((role) => {
          const entry = actors.get(role);
          return `${role.padEnd(9)}: ${String(entry?.decisions ?? 0).padStart(4)} decisions, mean consistent hands ${((entry?.sum ?? 0) / Math.max(1, entry?.decisions ?? 1)).toFixed(1)}`;
        }),
        "",
        `unknown <= 1 card: ${((cumulative(1) / total) * 100).toFixed(1)}%`,
        `unknown <= 2 cards: ${((cumulative(2) / total) * 100).toFixed(1)}%`,
        `unknown <= 3 cards: ${((cumulative(3) / total) * 100).toFixed(1)}%`,
        `unknown <= 4 cards: ${((cumulative(4) / total) * 100).toFixed(1)}%`,
        "",
      ].join("\n"),
    );

    expect(conservationFailures).toBe(0);
    expect(checked).toBeGreaterThan(0);
  }, 1_800_000);
});
