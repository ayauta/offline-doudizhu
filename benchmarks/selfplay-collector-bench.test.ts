/**
 * The three-role collector: does the loop close, is it deterministic, and what
 * does one batch of it cost?
 *
 * Every number here is measured, not derived. Feasibility is a question about
 * cost, and a cost estimated from a smaller run is exactly how the previous
 * research line lost a night to a deadline it had talked itself out of. The
 * mechanical tests run on a cheap two-bundle pool so they stay fast; the cost
 * tests run on the bundles the research proposal actually names.
 *
 * Run with `pnpm bench:ai` (or `vitest --config vitest.benchmark.config.ts`).
 */
import { describe, expect, it } from "vitest";

import { SEAT_ORDER } from "../src/core/game/index.js";
import {
  DEFAULT_MIXTURE_WEIGHTS,
  createPi1Bundle,
  createTierBundle,
  roleOfSeat,
  scenarioSpec,
  type MixtureSpec,
  type PolicyBundle,
} from "./selfplay-policy.js";
import {
  SELFPLAY_EPSILON,
  collectEpisode,
  groupScenarios,
  type CollectorConfig,
  type EpisodeResult,
} from "./selfplay-collector.js";
import { SELFPLAY_FEATURE_COUNT } from "./selfplay-features.js";

/** Retired range 5001–5400: mechanical prototype seeds, never a formal corpus. */
const FEASIBILITY_START = 5001;

/** The bundle ids the research proposal names, with the tiers that realise them. */
const P0_TIER = "master" as const;
const REHEARSAL_TIERS = { current: "default", history: "casual" } as const;

function report(line: string): void {
  console.log(line);
}

function registryOf(entries: readonly (readonly [string, PolicyBundle])[]): Map<string, PolicyBundle> {
  return new Map(entries.map(([id, bundle]) => [id, bundle]));
}

function configFor(options: {
  readonly bundles: ReadonlyMap<string, PolicyBundle>;
  readonly learningBundleId: string;
  readonly history: readonly string[];
  readonly auditProposal: boolean;
}): CollectorConfig {
  const mixture: MixtureSpec = Object.freeze({
    version: "fas-mixture-v1",
    current: options.learningBundleId,
    history: Object.freeze([...options.history]),
    weights: DEFAULT_MIXTURE_WEIGHTS,
  });
  return Object.freeze({
    bundles: options.bundles,
    learningBundleId: options.learningBundleId,
    mixture,
    epsilon: SELFPLAY_EPSILON,
    explorationSalt: 0x5eed_1001,
    mixtureSalt: 0x5eed_2002,
    auditProposal: options.auditProposal,
  });
}

/** A cheap two-bundle pool: enough to exercise the machinery, not to learn from. */
function rehearsalConfig(auditProposal: boolean): CollectorConfig {
  const bundles = registryOf([
    ["REH-current", createTierBundle("REH-current", REHEARSAL_TIERS.current)],
    ["REH-history", createTierBundle("REH-history", REHEARSAL_TIERS.history)],
  ]);
  return configFor({
    bundles,
    learningBundleId: "REH-current",
    history: ["REH-history"],
    auditProposal,
  });
}

/** The pool the research proposal names: the old self-developed bundle and π1. */
function researchConfig(): CollectorConfig {
  const bundles = registryOf([
    ["P0", createTierBundle("P0", P0_TIER)],
    ["PI1", createPi1Bundle(P0_TIER)],
  ]);
  return configFor({
    bundles,
    learningBundleId: "P0",
    history: ["PI1"],
    auditProposal: true,
  });
}

function runGroup(config: CollectorConfig, dealIndex: number): readonly EpisodeResult[] {
  return groupScenarios().map((scenario) => collectEpisode(config, dealIndex, scenario));
}

describe("three-role collector", () => {
  it("closes the loop: three scenarios per group, one learning seat each", () => {
    const config = rehearsalConfig(false);
    const started = Date.now();

    let groups = 0;
    let episodes = 0;
    let rows = 0;
    const rolesSeen = new Set<string>();
    const learningSeats = new Set<string>();

    for (let dealIndex = FEASIBILITY_START; dealIndex < FEASIBILITY_START + 10; dealIndex += 1) {
      const group = runGroup(config, dealIndex);
      expect(group).toHaveLength(3);
      groups += 1;
      for (const episode of group) {
        episodes += 1;
        rows += episode.records.length;
        rolesSeen.add(episode.role);
        learningSeats.add(episode.learningSeat);
        // Exactly one seat learns, and its decisions are the only rows.
        expect(
          episode.records.every((record) => record.learningSeat === episode.learningSeat),
        ).toBe(true);
        expect(episode.records.every((record) => record.role === episode.role)).toBe(true);
        expect(
          episode.records.every((record) => record.features.length === SELFPLAY_FEATURE_COUNT),
        ).toBe(true);
        // The reward is the learning team's terminal result: one value per episode.
        const rewards = new Set(episode.records.map((record) => record.terminalReward));
        expect(rewards.size).toBeLessThanOrEqual(1);
        for (const reward of rewards) {
          expect(reward).toBe(episode.learningTeamWon ? 1 : 0);
        }
        // The two other seats are the only ones with a bundle, and they are not
        // the learning seat.
        expect(episode.records[0]?.opponents.map((entry) => entry.seat)).not.toContain(
          episode.learningSeat,
        );
      }
    }

    expect(groups).toBe(10);
    expect(episodes).toBe(30);
    expect(rolesSeen).toEqual(new Set(["landlord", "farmer-next", "farmer-previous"]));
    report(
      `[selfplay] collector smoke: ${groups} groups / ${episodes} episodes / ${rows} learning rows ` +
        `in ${((Date.now() - started) / 1000).toFixed(1)} s; learning seats ${[...learningSeats].join(",")}`,
    );
  }, 900_000);

  it("is deterministic: the same configuration replays byte for byte", () => {
    const config = rehearsalConfig(false);
    for (const dealIndex of [FEASIBILITY_START, FEASIBILITY_START + 7]) {
      expect(JSON.stringify(runGroup(config, dealIndex))).toBe(
        JSON.stringify(runGroup(config, dealIndex)),
      );
    }
  }, 900_000);

  it("resumes to the same result: a group alone equals the same group inside a window", () => {
    const config = rehearsalConfig(false);
    const window: EpisodeResult[] = [];
    for (let dealIndex = FEASIBILITY_START; dealIndex < FEASIBILITY_START + 5; dealIndex += 1) {
      window.push(...runGroup(config, dealIndex));
    }
    const alone = runGroup(config, FEASIBILITY_START + 3);
    expect(JSON.stringify(window.filter((episode) => episode.dealIndex === FEASIBILITY_START + 3))).toBe(
      JSON.stringify(alone),
    );
  }, 900_000);

  it("keeps every seat's chosen action inside the enumerated legal set", () => {
    const config = rehearsalConfig(false);
    for (let dealIndex = FEASIBILITY_START; dealIndex < FEASIBILITY_START + 6; dealIndex += 1) {
      for (const episode of runGroup(config, dealIndex)) {
        for (const step of episode.trajectory) {
          expect(step.legalActionCount).toBeGreaterThan(0);
        }
        for (const record of episode.records) {
          expect(record.executedIndex).toBeGreaterThanOrEqual(0);
          expect(record.executedIndex).toBeLessThan(record.legalActionCount);
          expect(record.greedyIndex).toBeGreaterThanOrEqual(0);
          expect(record.greedyIndex).toBeLessThan(record.legalActionCount);
        }
      }
    }
  }, 900_000);

  it("gives every scenario the landlord rotation the spec names", () => {
    for (let dealIndex = 0; dealIndex < 9; dealIndex += 1) {
      const learners = new Set<string>();
      const landlords = new Set<string>();
      for (const scenario of groupScenarios()) {
        const spec = scenarioSpec(dealIndex, scenario);
        expect(roleOfSeat(spec.learningSeat, spec.landlord)).toBe(spec.role);
        learners.add(spec.learningSeat);
        landlords.add(spec.landlord);
      }
      expect(learners.size).toBe(1);
      expect(landlords).toEqual(new Set(SEAT_ORDER));
    }
  });

  it("reports what exploration covered in the rehearsal pool, and what a batch would cost", () => {
    const config = rehearsalConfig(true);
    const deals = 40;
    const started = Date.now();
    const all: EpisodeResult[] = [];
    for (let dealIndex = FEASIBILITY_START; dealIndex < FEASIBILITY_START + deals; dealIndex += 1) {
      all.push(...runGroup(config, dealIndex));
    }
    const elapsed = Date.now() - started;

    let rows = 0;
    let explored = 0;
    let outsideC3 = 0;
    let outsideC5 = 0;
    let withProposal = 0;
    let greedyOutsideC3 = 0;
    let plies = 0;
    const actionCounts: number[] = [];
    const patternKinds = new Map<string, number>();
    const attachmentKinds = new Map<string, number>();

    for (const episode of all) {
      plies += episode.audit.plies;
      greedyOutsideC3 += episode.audit.greedyOutsideC3;
      for (const [kind, count] of Object.entries(episode.audit.patternKindCounts)) {
        patternKinds.set(kind, (patternKinds.get(kind) ?? 0) + count);
      }
      for (const [kind, count] of Object.entries(episode.audit.attachmentKindCounts)) {
        attachmentKinds.set(kind, (attachmentKinds.get(kind) ?? 0) + count);
      }
      for (const record of episode.records) {
        rows += 1;
        actionCounts.push(record.legalActionCount);
        if (record.explored) {
          explored += 1;
        }
        if (record.proposalAvailable) {
          withProposal += 1;
          if (!record.inOldC3) {
            outsideC3 += 1;
          }
          if (!record.inOldC5) {
            outsideC5 += 1;
          }
        }
      }
    }

    const rowsPerGroup = rows / deals;
    const msPerGroup = elapsed / deals;
    const batchGroups = 7500;

    report(
      `[selfplay] rehearsal pool cost over ${deals} groups (${all.length} episodes):\n` +
        `  wall           ${(elapsed / 1000).toFixed(1)} s  ->  ${msPerGroup.toFixed(1)} ms/group\n` +
        `  plies/game     ${(plies / all.length).toFixed(1)}\n` +
        `  rows/group     ${rowsPerGroup.toFixed(2)}\n` +
        `  rows/batch     ${(rowsPerGroup * batchGroups).toFixed(0)}  (7500 groups)\n` +
        `  exploration    ${explored}/${rows} (${((100 * explored) / rows).toFixed(2)}%, target ${SELFPLAY_EPSILON * 100}%)\n` +
        `  executed out   C3 ${outsideC3}/${withProposal}  C5 ${outsideC5}/${withProposal}\n` +
        `  greedy out     C3 ${greedyOutsideC3}/${withProposal}\n` +
        `  action kinds   ${[...patternKinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k}:${c}`).join(" ")}\n` +
        `  attachments    ${[...attachmentKinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k}:${c}`).join(" ")}\n` +
        `  7500-group batch: ${((msPerGroup * batchGroups) / 3_600_000).toFixed(2)} h`,
    );

    expect(rows).toBeGreaterThan(0);
    expect(actionCounts.length).toBe(rows);
  }, 900_000);

  it("runs the π1 environment the proposal names, and reports what it costs", () => {
    const config = researchConfig();
    const deals = 6;
    const started = Date.now();
    let rows = 0;
    let episodes = 0;
    for (let dealIndex = FEASIBILITY_START; dealIndex < FEASIBILITY_START + deals; dealIndex += 1) {
      for (const episode of runGroup(config, dealIndex)) {
        rows += episode.records.length;
        episodes += 1;
      }
    }
    const elapsed = Date.now() - started;
    const msPerGroup = elapsed / deals;

    report(
      `[selfplay] P0/PI1 pool (both master): ${deals} groups / ${episodes} episodes in ` +
        `${(elapsed / 1000).toFixed(1)} s -> ${msPerGroup.toFixed(0)} ms/group, ${rows} rows\n` +
        `  7500-group batch: ${((msPerGroup * 7500) / 3_600_000).toFixed(2)} h` +
        `  |  3 batches: ${((msPerGroup * 7500 * 3) / 3_600_000).toFixed(1)} h`,
    );
    expect(rows).toBeGreaterThan(0);
  }, 900_000);

  it("builds the π1 bundle against the shipped champion identity", () => {
    const pi1 = createPi1Bundle(P0_TIER);
    expect(pi1.bundleId).toBe("PI1");
    expect(pi1.identity).toContain("ai-v1");
    expect(Object.keys(pi1.roles).sort()).toEqual(
      ["farmer-next", "farmer-previous", "landlord"].sort(),
    );
  });
});
