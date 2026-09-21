/**
 * Reproducible throughput measurement for the Spec 065 corpus.
 *
 *   source scripts/activate-toolchain.sh
 *   AI_CF_T5_RATE_N=30 node node_modules/vitest/vitest.mjs run \
 *     --config vitest.benchmark.config.ts benchmarks/cf-top5-rate.test.ts
 *
 * Measures the **retired** Phase 2 v1 deals (`50_001+` by default, spent and
 * permanently retired), so a cost estimate costs Spec 065 no seed. It captures
 * the same deals twice — once at top3, once at top5 — so the widening's price
 * is a measured ratio on identical work rather than a comparison against a
 * number remembered from another night.
 *
 * This file exists because the first projection for this round was an ad-hoc
 * probe. An estimate that cannot be re-run is not evidence, and the projection
 * is what decides whether the corpus fits before the 08:30 hard stop.
 *
 * Writes `AI_CF_T5_RATE_OUT` (default `/tmp/cf-top5-rate.json`) and prints the
 * same numbers.
 */
import { writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { dealDeck, armSchedule, dealGameSeed, scheduleFor, report } from "./ai-tournament.js";
import { CF_GROUP_SNAPSHOT_CAP, type CfGroupSpec } from "./cf-dataset.js";
import { cfPiFrozenBaseline } from "./cf-pi-corpus.js";
import { cfPiCaptureGroup } from "./cf-policy-iteration.js";
import { cfTop5CaptureGroup } from "./cf-top5.js";

const N = Number.parseInt(process.env.AI_CF_T5_RATE_N ?? "30", 10);
const START = Number.parseInt(process.env.AI_CF_T5_RATE_START ?? "50001", 10);
const OUT = process.env.AI_CF_T5_RATE_OUT ?? "/tmp/cf-top5-rate.json";
const UNIVERSE = 20_000;

function specFor(dealIndex: number): CfGroupSpec {
  const variants = armSchedule(dealIndex)
    .filter((slot) => slot.arm === "B" && slot.strongSeat !== slot.landlord)
    .map((slot) => Object.freeze({
      variantId: `${dealIndex}:${slot.landlord}:${slot.strongSeat}`,
      landlord: slot.landlord,
      studiedSeat: slot.strongSeat,
      gameSeed: dealGameSeed(dealIndex, slot.strongSeat, slot.landlord),
      tiers: scheduleFor("master", "default", slot.strongSeat),
    }));
  return Object.freeze({
    groupId: `deal-${dealIndex}`,
    dealIndex,
    dealSeed: dealIndex,
    variants: Object.freeze(variants),
    snapshotCap: CF_GROUP_SNAPSHOT_CAP,
    policyCommit: "rate",
  });
}

type Measurement = Readonly<{
  width: "top3" | "top5";
  groups: number;
  wallSeconds: number;
  secondsPerGroup: number;
  snapshots: number;
  meanCandidates: number;
  forkGames: number;
}>;

function measure(width: "top3" | "top5"): Measurement {
  const baseline = cfPiFrozenBaseline();
  const started = performance.now();
  let groups = 0;
  let snapshots = 0;
  let candidates = 0;
  let forks = 0;
  for (let offset = 0; offset < N; offset += 1) {
    const dealIndex = START + offset;
    const spec = specFor(dealIndex);
    const result = width === "top5"
      ? cfTop5CaptureGroup(dealDeck(spec.dealSeed), spec, baseline)
      : cfPiCaptureGroup(dealDeck(spec.dealSeed), spec, baseline);
    groups += 1;
    snapshots += result.snapshots.length;
    forks += result.forkGames;
    for (const snapshot of result.snapshots) {
      candidates += snapshot.candidates.length;
    }
  }
  const wallSeconds = (performance.now() - started) / 1000;
  return Object.freeze({
    width,
    groups,
    wallSeconds,
    secondsPerGroup: wallSeconds / Math.max(1, groups),
    snapshots,
    meanCandidates: candidates / Math.max(1, snapshots),
    forkGames: forks,
  });
}

describe("Spec 065 corpus throughput (retired seeds)", () => {
  it("measures top3 and top5 capture cost on identical retired deals", () => {
    const parallelism = Number.parseInt(process.env.AI_CF_T5_RATE_JOBS ?? "15", 10);
    const top3 = measure("top3");
    const top5 = measure("top5");
    const serialMinutes = (top5.secondsPerGroup * UNIVERSE) / 60;
    const shardedMinutes = serialMinutes / parallelism;
    // Spec 064's corpus ran 15 shards on 16 cores and took 152 min against a
    // 68-min single-process projection — a 2.2x contention factor. Reported as
    // a separate, labelled figure rather than folded into the raw measurement.
    const contention = Number.parseFloat(process.env.AI_CF_T5_RATE_CONTENTION ?? "2.2");

    const payload = {
      measuredAt: new Date().toISOString(),
      seedRange: { start: START, groups: N, note: "retired Phase 2 v1 deals" },
      parallelism,
      contentionFactor: contention,
      top3,
      top5,
      wideningRatio: top5.secondsPerGroup / Math.max(1e-9, top3.secondsPerGroup),
      projection: {
        universeGroups: UNIVERSE,
        serialMinutes,
        shardedMinutes,
        shardedMinutesWithContention: shardedMinutes * contention,
      },
    };
    writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

    report(`\n== Spec 065 throughput (retired seeds ${START}..${START + N - 1}) ==`);
    for (const m of [top3, top5]) {
      report(
        `[${m.width}] groups ${m.groups}  wall ${m.wallSeconds.toFixed(1)}s  ` +
        `${m.secondsPerGroup.toFixed(3)} s/group  snapshots ${m.snapshots}  ` +
        `meanCandidates ${m.meanCandidates.toFixed(2)}  forks ${m.forkGames}`,
      );
    }
    report(`widening ratio ${payload.wideningRatio.toFixed(3)}x`);
    report(
      `projection for ${UNIVERSE} groups: serial ${serialMinutes.toFixed(0)} min  ` +
      `÷${parallelism} shards ${shardedMinutes.toFixed(0)} min  ` +
      `×${contention} contention ${(shardedMinutes * contention).toFixed(0)} min`,
    );
    report(`written to ${OUT}`);

    expect(top5.groups).toBe(N);
    expect(top3.secondsPerGroup).toBeGreaterThan(0);
  }, 3_600_000);
});
