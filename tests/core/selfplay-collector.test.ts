import { describe, expect, it } from "vitest";

import { SEAT_ORDER } from "../../src/core/game/index.js";
import {
  DEFAULT_MIXTURE_WEIGHTS,
  createTierBundle,
  roleOfSeat,
  type MixtureSpec,
  type PolicyBundle,
} from "../../benchmarks/selfplay-policy.js";
import {
  SELFPLAY_EPSILON,
  collectEpisode,
  groupScenarios,
  keyedExplorationRandom,
  type CollectorConfig,
} from "../../benchmarks/selfplay-collector.js";
import { rowsOfEpisodes, splitOfDealGroup } from "../../benchmarks/selfplay-dataset.js";

/** Cheap two-bundle pool: the machinery under test, not the strength. */
function configWith(epsilon = SELFPLAY_EPSILON, auditProposal = false): CollectorConfig {
  const registry = new Map<string, PolicyBundle>([
    ["A", createTierBundle("A", "casual")],
    ["B", createTierBundle("B", "default")],
  ]);
  const mixture: MixtureSpec = Object.freeze({
    version: "fas-mixture-v1",
    current: "A",
    history: Object.freeze(["B"]),
    weights: DEFAULT_MIXTURE_WEIGHTS,
  });
  return Object.freeze({
    bundles: registry,
    learningBundleId: "A",
    mixture,
    epsilon,
    explorationSalt: 0x5eed_1001,
    mixtureSalt: 0x5eed_2002,
    auditProposal,
  });
}

function groupOf(config: CollectorConfig, dealIndex: number) {
  return groupScenarios().map((scenario) => collectEpisode(config, dealIndex, scenario));
}

describe("the three-role collector", () => {
  it("runs three scenarios per group with exactly one learning seat each", () => {
    const config = configWith();
    for (let dealIndex = 5001; dealIndex < 5006; dealIndex += 1) {
      const group = groupOf(config, dealIndex);
      expect(group).toHaveLength(3);
      const roles = new Set(group.map((episode) => episode.role));
      expect(roles).toEqual(new Set(["landlord", "farmer-next", "farmer-previous"]));
      const learners = new Set(group.map((episode) => episode.learningSeat));
      expect(learners.size).toBe(1);
      for (const episode of group) {
        expect(episode.role).toBe(roleOfSeat(episode.learningSeat, episode.landlord));
        for (const record of episode.records) {
          expect(record.learningSeat).toBe(episode.learningSeat);
          expect(record.role).toBe(episode.role);
          expect(record.opponents.map((entry) => entry.seat)).not.toContain(episode.learningSeat);
        }
      }
    }
  });

  it("attaches one reward per episode: the learning team's terminal result", () => {
    const config = configWith();
    for (let dealIndex = 5001; dealIndex < 5006; dealIndex += 1) {
      for (const episode of groupOf(config, dealIndex)) {
        const rewards = new Set(episode.records.map((record) => record.terminalReward));
        expect(rewards.size).toBeLessThanOrEqual(1);
        for (const reward of rewards) {
          expect(reward).toBe(episode.learningTeamWon ? 1 : 0);
        }
      }
    }
  });

  it("writes the exact epsilon-greedy behaviour probability on every row", () => {
    const config = configWith(0.25);
    let exploredSeen = 0;
    let greedySeen = 0;
    for (let dealIndex = 5001; dealIndex < 5008; dealIndex += 1) {
      for (const episode of groupOf(config, dealIndex)) {
        for (const record of episode.records) {
          const k = record.legalActionCount;
          if (record.explored) {
            expect(record.behaviorProbability).toBeCloseTo(0.25 / k, 12);
            exploredSeen += 1;
          } else {
            expect(record.behaviorProbability).toBeCloseTo(0.75 + 0.25 / k, 12);
            expect(record.executedIndex).toBe(record.greedyIndex);
            expect(record.actionChanged).toBe(false);
            greedySeen += 1;
          }
          // A uniform draw can land back on the greedy action, so `explored`
          // does not imply a different action. The reverse does hold.
          expect(record.actionChanged).toBe(record.executedIndex !== record.greedyIndex);
          if (record.actionChanged) {
            expect(record.explored).toBe(true);
          }
        }
      }
    }
    expect(exploredSeen).toBeGreaterThan(0);
    expect(greedySeen).toBeGreaterThan(0);
  });

  it("explores at roughly the rate epsilon asks for", () => {
    const config = configWith(SELFPLAY_EPSILON);
    let rows = 0;
    let explored = 0;
    for (let dealIndex = 5001; dealIndex < 5061; dealIndex += 1) {
      for (const episode of groupOf(config, dealIndex)) {
        for (const record of episode.records) {
          rows += 1;
          explored += record.explored ? 1 : 0;
        }
      }
    }
    expect(rows).toBeGreaterThan(500);
    expect(explored / rows).toBeGreaterThan(SELFPLAY_EPSILON - 0.05);
    expect(explored / rows).toBeLessThan(SELFPLAY_EPSILON + 0.05);
  });

  it("keys exploration on the decision, not on the run", () => {
    const salt = 1234;
    const first = keyedExplorationRandom(salt, 5001, 1, 3);
    const second = keyedExplorationRandom(salt, 5001, 1, 3);
    expect([first(), first(), first()]).toEqual([second(), second(), second()]);

    const other = keyedExplorationRandom(salt, 5001, 1, 4);
    const a = keyedExplorationRandom(salt, 5001, 1, 3);
    expect(a()).not.toBe(other());

    const otherSalt = keyedExplorationRandom(salt + 1, 5001, 1, 3);
    const b = keyedExplorationRandom(salt, 5001, 1, 3);
    expect(b()).not.toBe(otherSalt());
  });

  it("puts a group's three scenarios on the same side of the split", () => {
    for (let dealIndex = 5001; dealIndex < 5040; dealIndex += 1) {
      const split = splitOfDealGroup(dealIndex);
      expect(["train", "dev"]).toContain(split);
      expect(splitOfDealGroup(dealIndex)).toBe(split);
    }
    const episodes = groupOf(configWith(), 5001);
    const { train, dev } = rowsOfEpisodes(episodes);
    expect(train.length === 0 || dev.length === 0).toBe(true);
  });

  it("replays a forked run exactly when the forced action is the one that was taken", () => {
    const config = configWith();
    for (let dealIndex = 5001; dealIndex < 5009; dealIndex += 1) {
      for (const episode of groupOf(config, dealIndex)) {
        const record = episode.records[Math.floor(episode.records.length / 2)];
        if (record === undefined) {
          continue;
        }
        // Forcing the same action the episode already took, with the mixture
        // left untouched, must reproduce the episode's own winner. If the walk
        // diverged anywhere before the fork point, this is where it shows.
        const forked = collectEpisode(config, dealIndex, episode.scenario, {
          seatDecisionIndex: record.seatDecisionIndex,
          choose: () => record.executedIndex,
          continuationBundleId: null,
          explorationAfterFork: "inherit",
        });
        expect(forked.winner, `deal ${dealIndex} ${episode.scenario}`).toBe(episode.winner);
        expect(forked.learningTeamWon).toBe(episode.learningTeamWon);
      }
    }
  });

  it("replays the pre-fork plies exactly even when the post-fork play is greedy", () => {
    // `explorationAfterFork: "off"` must not reach back before the fork point.
    // It did once: the exploration coin was skipped for every ply, the replay
    // diverged, and the fork silently measured a state the corpus never visited.
    const config = configWith();
    for (let dealIndex = 5001; dealIndex < 5009; dealIndex += 1) {
      for (const episode of groupOf(config, dealIndex)) {
        const record = episode.records.find((entry) => entry.legalActionCount >= 2);
        if (record === undefined) {
          continue;
        }
        let legalAtFork = -1;
        collectEpisode(config, dealIndex, episode.scenario, {
          seatDecisionIndex: record.seatDecisionIndex,
          choose: (_view, legalActions) => {
            legalAtFork = legalActions.length;
            return record.executedIndex;
          },
          continuationBundleId: null,
          explorationAfterFork: "off",
        });
        expect(legalAtFork, `deal ${dealIndex} ${episode.scenario}`).toBe(
          record.legalActionCount,
        );
      }
    }
  });

  it("measures a different outcome when a different action is forced", () => {
    const config = configWith();
    let differences = 0;
    let attempts = 0;
    for (let dealIndex = 5001; dealIndex < 5015; dealIndex += 1) {
      for (const episode of groupOf(config, dealIndex)) {
        const record = episode.records.find((entry) => entry.legalActionCount >= 3);
        if (record === undefined) {
          continue;
        }
        const other = (record.executedIndex + 1) % record.legalActionCount;
        const forked = collectEpisode(config, dealIndex, episode.scenario, {
          seatDecisionIndex: record.seatDecisionIndex,
          choose: () => other,
          continuationBundleId: "A",
          explorationAfterFork: "off",
        });
        attempts += 1;
        if (forked.learningTeamWon !== episode.learningTeamWon) {
          differences += 1;
        }
      }
    }
    expect(attempts).toBeGreaterThan(0);
    // A single forced action cannot be guaranteed to change every game, but it
    // must change some of them, or the fork is not measuring anything.
    expect(differences).toBeGreaterThan(0);
  });

  it("refuses a forced action index outside the legal set", () => {
    const config = configWith();
    const episode = collectEpisode(config, 5001, "L");
    const record = episode.records[0];
    if (record === undefined) {
      return;
    }
    expect(() =>
      collectEpisode(config, 5001, "L", {
        seatDecisionIndex: record.seatDecisionIndex,
        choose: () => 9999,
        continuationBundleId: null,
        explorationAfterFork: "inherit",
      }),
    ).toThrow(/legal/);
  });

  it("rotates the learning seat across the three seats", () => {
    const config = configWith();
    const seats = new Set<string>();
    for (const dealIndex of [5001, 5002, 5003]) {
      seats.add(groupOf(config, dealIndex)[0]!.learningSeat);
    }
    expect(seats).toEqual(new Set(SEAT_ORDER));
  });
});
