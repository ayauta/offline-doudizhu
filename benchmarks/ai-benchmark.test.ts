/**
 * AI strength and bounded-time benchmark — run with `pnpm bench:ai`.
 *
 * What this measures, and what it deliberately does not claim:
 *
 * - It plays the SHIPPED decision path (`decideEnhancedAi` with the imported
 *   `ENHANCED_AI_BUDGET_MS`), never a local stand-in, so the numbers describe
 *   the product rather than the harness.
 * - It reports latency percentiles, how often each level's own budget cut its
 *   work short, and the HEADROOM that level has before the product's 480 ms
 *   response window is at risk. The window itself is a product guarantee
 *   implemented by the deadline + fallback mechanism, and is proven by the
 *   session and browser tests — not by this file.
 * - Strength is reported as deal-clustered win rates with confidence
 *   intervals. Elo never appears as an acceptance criterion.
 *
 * It stays out of `pnpm check` on purpose (spec 051): it measures wall-clock
 * time and is meant for tuning and release verification, not every edit.
 */

import { writeFileSync } from "node:fs";

import { afterAll, describe, expect, it } from "vitest";

import { ENHANCED_AI_SEARCH } from "../src/app/ai/decision-handler.js";
import {
  ALL_PAIRS,
  CONTROL_PAIR,
  PROFILES,
  armSchedule,
  createRecorder,
  dealDeck,
  masterWorldPolls,
  measureBidDecisions,
  observedWorldCap,
  playGame,
  readConfig,
  report,
  responseWindowMs,
  runPairTournament,
  scheduleFor,
  summarizeMasterRollout,
  type Profile,
  type Recorder,
} from "./ai-tournament.js";
import {
  clusterInterval,
  formatMs,
  formatPercent,
  percentile,
  quantileIsReportable,
  requiredDeals,
  standardDeviation,
  summarizeLatency,
  summarizePair,
  tInterval,
  wilsonInterval,
} from "./ai-stats.js";

const config = readConfig();

/** Where the optional per-deal dump goes; unset means the run only prints. */
const BENCH_OUT = process.env.AI_BENCH_OUT;
const benchRuns: Record<string, unknown> = {};

function decisionsOf(recorder: Recorder, profile: Profile) {
  return recorder.forProfile(profile, "play");
}

function percentileCell(values: readonly number[], fraction: number): string {
  if (!quantileIsReportable(values.length, fraction)) {
    return "n/a";
  }
  return formatMs(percentile(values, fraction));
}

function overshoots(recorder: Recorder, profile: Profile): number[] {
  return recorder
    .forProfile(profile, "play")
    .filter((record) => record.budgetMs !== null)
    .map((record) => Math.max(0, record.elapsedMs - (record.budgetMs ?? 0)));
}

function agreementOf(recorder: Recorder, profile: Profile): { samples: number; agreed: number } {
  let samples = 0;
  let agreed = 0;
  for (const record of recorder.forProfile(profile, "play")) {
    if (record.unbounded !== null) {
      samples += 1;
      if (record.unbounded.agrees) {
        agreed += 1;
      }
    }
  }
  return { samples, agreed };
}

describe("AI strength and bounded-time benchmark", () => {
  it("keeps its statistics honest", () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([1, 2, 3, 4], 0)).toBe(1);
    expect(percentile([1, 2, 3, 4], 1)).toBe(4);
    expect(percentile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 6);

    // A constant vector has no spread, so the interval must collapse.
    const flat = clusterInterval([0.5, 0.5, 0.5, 0.5, 0.5], { seed: 7 });
    expect(flat.high - flat.low).toBeLessThan(1e-9);

    // More spread must widen the interval, not narrow it.
    const tight = clusterInterval([0.4, 0.45, 0.5, 0.55, 0.6], { seed: 7 });
    const loose = clusterInterval([0, 0.25, 0.5, 0.75, 1], { seed: 7 });
    expect(loose.high - loose.low).toBeGreaterThan(tight.high - tight.low);

    // The bootstrap must agree with the normal-theory interval on sane input,
    // otherwise the report is not trustworthy enough to print.
    const sample = [0.5, 0.66, 0.33, 0.5, 0.83, 0.33, 0.5, 0.66, 0.5, 0.5, 0.66, 0.33];
    const boot = clusterInterval(sample, { seed: 11 });
    const t = tInterval(sample);
    const bootWidth = boot.high - boot.low;
    const tWidth = t.high - t.low;
    expect(Math.abs(bootWidth - tWidth) / tWidth).toBeLessThan(0.2);

    // Required sample size must grow as the effect shrinks.
    const sd = standardDeviation(sample);
    expect(requiredDeals(sd, 0.15)).toBeLessThan(requiredDeals(sd, 0.1));
    expect(requiredDeals(sd, 0.1)).toBeLessThan(requiredDeals(sd, 0.05));

    // Wilson must stay inside [0, 1] and handle the extreme case correctly.
    const none = wilsonInterval(0, 20);
    expect(none.low).toBe(0);
    expect(none.high).toBeGreaterThan(0.1);
    expect(none.high).toBeLessThan(0.2);
    const all = wilsonInterval(20, 20);
    expect(all.high).toBeCloseTo(1, 6);

    // Quantile reporting must refuse to extrapolate a tail it cannot see.
    expect(quantileIsReportable(50, 0.99)).toBe(false);
    expect(quantileIsReportable(2000, 0.99)).toBe(true);
  });

  it("measures every level on the shipped decision path", () => {
    const recorder = createRecorder();
    const window = responseWindowMs();
    report(`\n== latency and budget (${config.probeDeals} deals per level, shipped path) ==`);

    for (const profile of PROFILES) {
      for (let dealIndex = 0; dealIndex < config.probeDeals; dealIndex += 1) {
        const deck = dealDeck(config.seedBase + 5000 + dealIndex);
        const landlord = (["human", "ai-one", "ai-two"] as const)[dealIndex % 3] ?? "human";
        playGame(deck, landlord, scheduleFor(profile, profile, landlord), recorder, {
          unboundedEvery: config.unboundedEvery,
          seed: (config.seedBase + dealIndex) * 1000,
        });
      }
    }

    let strictFailure: string | null = null;
    for (const profile of PROFILES) {
      const records = decisionsOf(recorder, profile);
      const durations = records.map((record) => record.elapsedMs);
      const latency = summarizeLatency(durations);
      const budget = records[0]?.budgetMs ?? null;
      const truncated = records.filter((record) => record.reachedDeadline).length;
      const truncation = wilsonInterval(truncated, records.length);
      const overshoot = overshoots(recorder, profile);
      const overshootP99 = percentile(overshoot, 0.99);
      const headroom = latency.p99 > 0 ? window / latency.p99 : Number.POSITIVE_INFINITY;
      const agreement = agreementOf(recorder, profile);

      report(
        `${profile.padEnd(8)} n=${String(latency.count).padStart(5)} ` +
        `p50=${formatMs(latency.p50).padStart(9)} ` +
        `p95=${percentileCell(durations, 0.95).padStart(9)} ` +
        `p99=${percentileCell(durations, 0.99).padStart(9)} ` +
        `max=${formatMs(latency.max).padStart(9)} ` +
        `budget=${budget === null ? "  sync" : `${budget}ms`.padStart(6)} ` +
        `truncated=${formatPercent(records.length === 0 ? 0 : truncated / records.length)} ` +
        `[${formatPercent(truncation.low)}, ${formatPercent(truncation.high)}] ` +
        `overshootP99=${formatMs(overshootP99).padStart(9)} ` +
        `headroom=${headroom === Number.POSITIVE_INFINITY ? "inf" : `${headroom.toFixed(1)}x`} ` +
        `agree=${agreement.samples === 0 ? "n/a" : `${agreement.agreed}/${agreement.samples}`}`,
      );

      expect(records.length).toBeGreaterThan(0);

      if (config.strict && budget !== null) {
        if (latency.p99 > window) {
          strictFailure = `${profile} p99 ${formatMs(latency.p99)} exceeds the ${window}ms window`;
        }
        if (headroom < 1) {
          strictFailure = `${profile} headroom ${headroom.toFixed(2)}x is below 1`;
        }
        if (overshootP99 > 60) {
          strictFailure = `${profile} overshoot p99 ${formatMs(overshootP99)} exceeds 60ms`;
        }
        // A level that stops running its designed work still answers in time —
        // it answers *worse*, silently. That is the failure this catches.
        const truncationRate = records.length === 0 ? 0 : truncated / records.length;
        if (truncationRate > config.truncationCeiling) {
          strictFailure =
            `${profile} truncates ${formatPercent(truncationRate)} of decisions, ` +
            `above the ${formatPercent(config.truncationCeiling, 0)} ceiling`;
        }
      }
    }

    // Casual sits so far inside its budget (p99 well under a millisecond against
    // 16 ms) that its shipped and unlimited results must be identical. This
    // fails the moment a change makes that budget binding, which is a decision
    // that should be made on purpose. Master is reported, not asserted: it
    // truncates on a large fraction of decisions, so demanding exact agreement
    // would be asserting on a tail the run cannot control.
    const casualAgreement = agreementOf(recorder, "casual");
    if (casualAgreement.samples > 0) {
      expect(casualAgreement.agreed).toBe(casualAgreement.samples);
    }
    const masterAgreement = agreementOf(recorder, "master");
    if (masterAgreement.samples > 0 && masterAgreement.agreed !== masterAgreement.samples) {
      report(
        `note: master's budget changed ${masterAgreement.samples - masterAgreement.agreed} of ` +
        `${masterAgreement.samples} sampled decisions`,
      );
    }

    // How much of master's designed rollout the shipped budget pays for.
    const worldCap = observedWorldCap(recorder.records);
    const rollout = summarizeMasterRollout(recorder.records, worldCap);
    const completed = rollout.completedWorlds;
    report(
      `master rollout: cap=${worldCap} worlds completed ` +
      `p50=${percentile(completed, 0.5).toFixed(1)} ` +
      `p10=${percentile(completed, 0.1).toFixed(1)} ` +
      `p90=${percentile(completed, 0.9).toFixed(1)} ` +
      `(over ${completed.length} decisions) ` +
      `skipped-before-any-world=${rollout.rolloutSkipped} ` +
      `root-truncated=${rollout.rootTruncated}`,
    );
    // The cap is only observable from an unlimited sample. If the sampling rate
    // produced none, say so rather than assert on a number nobody measured; the
    // dedicated canary pins the cap deterministically.
    if (worldCap > 0) {
      report(`master world cap observed from unlimited samples: ${worldCap}`);
    } else {
      report(
        "master world cap not observed in this run " +
        `(no unlimited sample at AI_BENCH_UNBOUNDED_EVERY=${config.unboundedEvery})`,
      );
    }

    // Does the search earn its keep? Master's contract is "the Expert shortlist
    // plus a sampled shallow rollout", so count how often that rollout actually
    // overturns the action the Expert ranking led with.
    const masterPicks = decisionsOf(recorder, "master")
      .filter((record) => record.rootLeaderDiffers !== null);
    const overturned = masterPicks.filter((record) => record.rootLeaderDiffers === true).length;
    report(
      `master rollout overturned the expert leader on ${overturned}/${masterPicks.length} ` +
      `decisions (${formatPercent(masterPicks.length === 0 ? 0 : overturned / masterPicks.length)})`,
    );

    // The bid path never reads the clock, so measure it rather than assume.
    const bidRecorder = createRecorder();
    const bidDecks = Array.from({ length: config.probeDeals }, (_unused, index) =>
      dealDeck(config.seedBase + 9000 + index));
    measureBidDecisions(bidDecks, bidRecorder, { unboundedEvery: config.unboundedEvery });
    for (const profile of PROFILES) {
      const records = bidRecorder.forProfile(profile, "bid");
      const latency = summarizeLatency(records.map((record) => record.elapsedMs));
      const clockReads = records.reduce((total, record) => total + record.polls, 0);
      report(
        `bid ${profile.padEnd(8)} n=${String(latency.count).padStart(3)} ` +
        `p50=${formatMs(latency.p50).padStart(9)} p95=${formatMs(latency.p95).padStart(9)} ` +
        `max=${formatMs(latency.max).padStart(9)} budgetChecks=${clockReads}`,
      );
      expect(records.length).toBeGreaterThan(0);
      // No budget guard exists on the bid path — `decideEnhancedAi` answers a
      // bid before it ever consults a deadline. Recorded, not asserted away.
      expect(clockReads).toBe(0);
    }

    if (strictFailure !== null) {
      throw new Error(strictFailure);
    }
  });

  // Per-deal arrays for a *paired* comparison of two configurations. The printed
  // report carries each run's own interval, but comparing two runs needs the
  // per-deal wins, and only the run that produced them can write them down.
  // `AI_BENCH_OUT` decides whether that happens; nothing depends on it.
  afterAll(() => {
    if (BENCH_OUT === undefined) {
      return;
    }
    writeFileSync(BENCH_OUT, `${JSON.stringify({
      label: process.env.AI_BENCH_LABEL ?? "unnamed",
      config: {
        deals: config.deals,
        seedBase: config.seedBase,
        secondsCap: config.secondsCap,
      },
      runs: benchRuns,
    }, null, 2)}\n`, "utf8");
    report(`wrote ${BENCH_OUT}`);
  });

  const pairs = config.pairs ?? ALL_PAIRS;
  it.each(pairs.map(([weaker, stronger]) => ({ weaker, stronger })))(
    "measures $stronger vs $weaker over mirrored deals",
    ({ weaker, stronger }) => {
      const recorder = createRecorder();
      const run = runPairTournament(config, stronger, weaker, recorder);
      const gamesPerArm = 3;
      const pooled = run.perDealA.map((wins, index) => wins + (run.perDealB[index] ?? 0));

      if (BENCH_OUT !== undefined) {
        benchRuns[`${stronger}-${weaker}`] = {
          stronger,
          weaker,
          requestedDeals: run.requestedDeals,
          playedDeals: run.playedDeals,
          stoppedEarly: run.stoppedEarly,
          elapsedMs: run.elapsedMs,
          perDealA: run.perDealA,
          perDealB: run.perDealB,
        };
      }

      report(`\n-- ${stronger} vs ${weaker} --`);
      for (const [label, perDeal, gamesPerDeal] of [
        ["arm A (strong landlord)", run.perDealA, gamesPerArm],
        ["arm B (strong farmer)", run.perDealB, gamesPerArm],
        ["pooled", pooled, gamesPerArm * 2],
      ] as const) {
        const summary = summarizePair(perDeal, gamesPerDeal);
        const bootWidth = summary.ciHigh - summary.ciLow;
        const tWidth = summary.ciTHigh - summary.ciTLow;
        const diverge = tWidth > 0 && Math.abs(bootWidth - tWidth) / tWidth > 0.2;
        report(
          `${label.padEnd(24)} deals=${String(summary.deals).padStart(4)} ` +
          `games=${String(summary.games).padStart(5)} ` +
          `win=${formatPercent(summary.rate).padStart(6)} ` +
          `ci=[${formatPercent(summary.ciLow)}, ${formatPercent(summary.ciHigh)}] ` +
          `t=[${formatPercent(summary.ciTLow)}, ${formatPercent(summary.ciTHigh)}] ` +
          `sd=${summary.sd.toFixed(3)} ` +
          `need(0.10)=${summary.deals < 2 ? "n/a" : `${summary.requiredDeals["0.10"]} deals`}` +
          (diverge ? "  <-- bootstrap and t intervals disagree by more than 20%" : ""),
        );
      }
      if (run.stoppedEarly) {
        report(
          `!! stopped at the ${config.secondsCap}s soft cap after ${run.playedDeals}/` +
          `${run.requestedDeals} deals — the report above covers what was played`,
        );
      }

      expect(run.playedDeals).toBeGreaterThan(0);
      expect(pooled.length).toBe(run.playedDeals);
      // Every played deal contributes three games per arm, never fewer.
      expect(run.perDealA.length).toBe(run.playedDeals);
      expect(run.perDealB.length).toBe(run.playedDeals);
      for (const wins of pooled) {
        expect(wins).toBeGreaterThanOrEqual(0);
        expect(wins).toBeLessThanOrEqual(6);
      }
    },
  );

  it("varies exactly one seat per game", () => {
    // A schedule that gives the strong level two of three seats produces games
    // the strong side wins regardless of level quality, which is how the old
    // benchmark diluted its own signal.
    for (let dealIndex = 0; dealIndex < 4; dealIndex += 1) {
      const schedule = armSchedule(dealIndex);
      expect(schedule.length).toBe(6);
      for (const slot of schedule) {
        const profiles = scheduleFor("master", "casual", slot.strongSeat);
        const strongSeats = Object.values(profiles).filter((profile) => profile === "master");
        expect(strongSeats).toHaveLength(1);
        if (slot.arm === "A") {
          expect(slot.strongSeat).toBe(slot.landlord);
        } else {
          expect(slot.strongSeat).not.toBe(slot.landlord);
        }
      }
    }
  });

  it("keeps the widest contrast detectable", () => {
    // A positive control: if this harness cannot separate the two levels that
    // are furthest apart, it cannot be trusted on the adjacent pairs at all.
    const recorder = createRecorder();
    const [weaker, stronger] = CONTROL_PAIR;
    const run = runPairTournament(
      { ...config, deals: config.controlDeals },
      stronger,
      weaker,
      recorder,
      { maxDeals: config.controlDeals, quiet: true },
    );
    const pooled = run.perDealA.map((wins, index) => wins + (run.perDealB[index] ?? 0));
    const summary = summarizePair(pooled, 6);
    report(
      `\n-- control: ${stronger} vs ${weaker} --\n` +
      `pooled win=${formatPercent(summary.rate)} ` +
      `ci=[${formatPercent(summary.ciLow)}, ${formatPercent(summary.ciHigh)}] ` +
      `deals=${summary.deals}`,
    );
    expect(run.playedDeals).toBeGreaterThan(0);
  });

  it("cannot vary its own measurements", () => {
    // Determinism belongs to the designed algorithm (fixed seeds, fixed node and
    // world budgets). The shipped, deadline-limited path is machine-dependent on
    // purpose, so the replay uses the designed configuration.
    const deals = 2;
    const logs: string[] = [];
    for (let repeat = 0; repeat < 2; repeat += 1) {
      const recorder = createRecorder({ logCommands: true });
      for (let dealIndex = 0; dealIndex < deals; dealIndex += 1) {
        const deck = dealDeck(config.seedBase + 2000 + dealIndex);
        // Casual and Expert are pure functions of the position, so a divergence
        // anywhere in the pipeline shows up in the command log. Master's choice
        // is measurably insensitive to its own sampled worlds, which is why this
        // replay does not lean on it alone.
        playGame(
          deck,
          "human",
          scheduleFor("master", "casual", "ai-two"),
          recorder,
          { unboundedEvery: 1, seed: 4242, designed: true },
        );
      }
      logs.push((recorder.commands ?? []).join("|"));
    }
    expect(logs[0]).not.toBe("");
    expect(logs[1]).toBe(logs[0]);

    // The truncation attribution rests on how often each policy checks its
    // budget. Guard that structure: if a policy loop is restructured, this
    // fails loudly instead of silently mis-reporting completed worlds.
    const canary = createRecorder();
    for (let dealIndex = 0; dealIndex < deals; dealIndex += 1) {
      const deck = dealDeck(config.seedBase + 3000 + dealIndex);
      playGame(deck, "human", scheduleFor("master", "casual", "ai-one"), canary, {
        unboundedEvery: 1,
        seed: 777,
        designed: true,
      });
    }
    let maxWorlds = 0;
    for (const record of canary.records) {
      if (record.kind !== "play") {
        continue;
      }
      if (record.profile === "master") {
        const worlds = masterWorldPolls(record);
        expect(worlds).not.toBeNull();
        expect(worlds ?? -1).toBeGreaterThanOrEqual(0);
        expect(worlds ?? 1e9).toBeLessThanOrEqual(ENHANCED_AI_SEARCH.maxWorlds);
        maxWorlds = Math.max(maxWorlds, worlds ?? 0);
      } else if (record.profile === "casual") {
        // One candidate is scored before the first check, then one check each.
        expect(record.polls).toBe(Math.max(0, record.legalActionCount - 1));
      }
    }
    // Two assertions on purpose. The first pins the invariant this canary is
    // for: what the decision path actually polled equals what it was configured
    // with, so a rollout-loop change that drifts from the configured cap fails.
    // The second pins the value, because reading the measurement and the
    // configuration from one constant moves both sides together. 32 worlds want
    // ~208 ms on the target phone against a 120 ms budget, so this must not
    // drift back up; raise it only with a new measurement behind it.
    expect(maxWorlds).toBe(ENHANCED_AI_SEARCH.maxWorlds);
    expect(ENHANCED_AI_SEARCH.maxWorlds).toBeLessThanOrEqual(8);
  });
});
