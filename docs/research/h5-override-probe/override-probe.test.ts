/**
 * Counterfactual probe: when the rollout overrides the expert leader, does the
 * override help — and does terminal evidence predict that?
 *
 * The earlier diagnostic could only say "decisions in this bucket were won X% of
 * the time", which is an unconditional outcome rate: a useful signal that is
 * symmetric in sign averages to 50%, and bucketing by the *chosen* candidate
 * carries a selection effect. Neither answers the question H5 needs.
 *
 * This probe forks each overriding decision at the point of decision:
 *   branch E — force the expert leader the rollout overrode
 *   branch R — force the rollout's own choice
 * and plays both to the end with the identical production AI and seeds. Same
 * deal, same real hidden cards, same continuation; only that one action differs.
 * The strategy sees only ordinary public information throughout — the probe
 * holds the state, it never feeds hidden cards into a policy.
 *
 * A historical hypothesis diagnosis, not a strength experiment: it decides
 * nothing, and consumes no discovery pool.
 *
 * Requires docs/research/057-leaf-harvest/instrumentation.patch (leaf evidence).
 *
 *   AI_BENCH_PROBE_OUT=<shard.json> AI_BENCH_DEAL_START=5001 AI_BENCH_DEALS=50
 *   AI_BENCH_PROBE_MERGE=<shard dir>
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  setDecisionSink,
  type DecisionLeafRecord,
} from "../../../src/core/ai/master-policy.js";
import { rankScoredPlayActions, type ScoredPlayAction } from "../../../src/core/ai/scoring-policy.js";
import { createPlayerView, type AiDecisionContext } from "../../../src/core/ai/index.js";
import {
  INITIAL_GAME_STATE,
  SEAT_ORDER,
  transition,
  type GameCommand,
  type GameState,
  type Seat,
} from "../../../src/core/game/index.js";
import { generateLegalActions } from "../../../src/core/rules/index.js";
import {
  armSchedule,
  createMeasuredStrategy,
  createRecorder,
  dealDeck,
  playGame,
  readConfig,
  report,
  scheduleFor,
  type Profile,
} from "../../../benchmarks/ai-tournament.js";
import { formatPercent } from "../../../benchmarks/ai-stats.js";

const COLLECT_OUT = process.env.AI_BENCH_PROBE_OUT;
const MERGE_DIR = process.env.AI_BENCH_PROBE_MERGE;
const ROOT_ANALYZER_NODES = 220;

export type ProbeRecord = Readonly<{
  bucket: "no-terminal" | "terminal";
  branchEWon: boolean;
  branchRWon: boolean;
  rootSide: "landlord" | "peasant";
  /** Anchored score gap between the leader and the runner-up, at the decision. */
  expertGap: number;
}>;

export type ProbeShard = Readonly<{ records: readonly ProbeRecord[] }>;

function commandKey(command: GameCommand): string {
  if (command.type !== "play") {
    return command.type;
  }
  return `play:${[...command.cards].sort((left, right) => left - right).join(",")}`;
}

function commandOf(action: ScoredPlayAction | undefined, seat: Seat): GameCommand {
  if (action === undefined || action.action.type === "pass") {
    return Object.freeze({ type: "pass", seat });
  }
  return Object.freeze({
    type: "play",
    seat,
    cards: Object.freeze([...action.action.play.cards]),
  });
}

/** Plays a captured state to the end with the production AI. */
function continuationWinner(
  state: GameState,
  profiles: Readonly<Record<Seat, Profile>>,
  baseSeed: number,
): Seat | null {
  const recorder = createRecorder();
  const strategies: Record<Seat, ReturnType<typeof createMeasuredStrategy>> = {
    human: createMeasuredStrategy(profiles.human, recorder, { unboundedEvery: 0, seed: baseSeed + 1, designed: true }),
    "ai-one": createMeasuredStrategy(profiles["ai-one"], recorder, { unboundedEvery: 0, seed: baseSeed + 2, designed: true }),
    "ai-two": createMeasuredStrategy(profiles["ai-two"], recorder, { unboundedEvery: 0, seed: baseSeed + 3, designed: true }),
  };
  let current = state;
  for (let step = 0; step < 256; step += 1) {
    if (current.phase === "finished") {
      return current.winner;
    }
    if (current.phase !== "ready-to-play" && current.phase !== "playing") {
      return null;
    }
    const seat = current.currentSeat;
    const view = createPlayerView(current, seat);
    if (view === null || view.phase === "bidding") {
      return null;
    }
    const context: AiDecisionContext = Object.freeze({
      kind: "play",
      view,
      legalActions: generateLegalActions({ hand: view.hand, currentPlay: view.currentPlay }),
    });
    const applied = transition(current, strategies[seat].chooseCommand(context));
    if (!applied.ok) {
      return null;
    }
    current = applied.state;
  }
  return null;
}

function readRecords(directory: string): readonly ProbeRecord[] {
  const out: ProbeRecord[] = [];
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".json")).sort()) {
    const parsed = JSON.parse(readFileSync(join(directory, name), "utf8")) as Partial<ProbeShard>;
    if (Array.isArray(parsed.records)) {
      out.push(...parsed.records);
    }
  }
  return out;
}

describe.runIf(COLLECT_OUT !== undefined || MERGE_DIR !== undefined)("H5 override probe", () => {
  it("forks overriding decisions into expert vs rollout branches", () => {
    if (MERGE_DIR !== undefined) {
      const records = readRecords(MERGE_DIR);
      report(`\n== H5 override probe (${records.length} overriding decisions) ==`);
      for (const bucket of ["no-terminal", "terminal"] as const) {
        const rows = records.filter((record) => record.bucket === bucket);
        const rWins = rows.filter((record) => record.branchRWon && !record.branchEWon).length;
        const eWins = rows.filter((record) => record.branchEWon && !record.branchRWon).length;
        const same = rows.length - rWins - eWins;
        const landlord = rows.filter((record) => record.rootSide === "landlord");
        const peasant = rows.filter((record) => record.rootSide === "peasant");
        const sideRate = (subset: readonly ProbeRecord[]) =>
          subset.length === 0 ? "n/a" : formatPercent(
            subset.filter((record) => record.branchRWon && !record.branchEWon).length / subset.length);
        report(
          `\n${bucket.padEnd(12)} decisions=${String(rows.length).padStart(5)}  ` +
          `rollout branch wins ${rWins}  expert branch wins ${eWins}  same ${same}  ` +
          `NET=${rWins - eWins >= 0 ? "+" : ""}${((rWins - eWins) / Math.max(1, rows.length) * 100).toFixed(2)}pp`,
        );
        report(
          `${"".padEnd(12)} landlord n=${landlord.length} rollout-better=${sideRate(landlord)}   ` +
          `peasant n=${peasant.length} rollout-better=${sideRate(peasant)}`,
        );
      }
      report(
        `\nreading: NET is the real counterfactual — same deal, same hidden cards, same continuation,` +
        `\nonly the overriding action differs. It is a hypothesis diagnostic, not a strength result.`,
      );
      expect(records.length).toBeGreaterThan(0);
      return;
    }

    const config = readConfig();
    expect(config.designed).toBe(true);
    const records: ProbeRecord[] = [];
    let overrides = 0;

    for (let offset = 0; offset < config.deals; offset += 1) {
      const dealIndex = config.dealStart + offset;
      const dealSeed = config.seedBase + dealIndex;
      const deck = dealDeck(dealSeed);
      for (const slot of armSchedule(dealIndex)) {
        const profiles = scheduleFor("master", "default", slot.strongSeat);
        if (profiles[slot.strongSeat] !== "master") {
          continue;
        }
        const gameSeed = dealSeed * 100 +
          SEAT_ORDER.indexOf(slot.strongSeat) * 10 +
          SEAT_ORDER.indexOf(slot.landlord);
        // Replay the game decision by decision so an overriding decision can be
        // forked where it happens. The loop mirrors `playGame` exactly, and the
        // self-check below proves it produces the same winners.
        const recorder = createRecorder();
        const strategies: Record<Seat, ReturnType<typeof createMeasuredStrategy>> = {
          human: createMeasuredStrategy(profiles.human, recorder, { unboundedEvery: 0, seed: gameSeed + 1, designed: true }),
          "ai-one": createMeasuredStrategy(profiles["ai-one"], recorder, { unboundedEvery: 0, seed: gameSeed + 2, designed: true }),
          "ai-two": createMeasuredStrategy(profiles["ai-two"], recorder, { unboundedEvery: 0, seed: gameSeed + 3, designed: true }),
        };
        const started = transition(INITIAL_GAME_STATE, { type: "deal", deck });
        if (!started.ok) {
          throw new Error("probe deal failed");
        }
        let state = started.state;
        for (const seat of SEAT_ORDER) {
          const bid = transition(state, {
            type: "bid",
            seat,
            decision: seat === slot.landlord ? "call" : "decline",
          });
          if (!bid.ok) {
            throw new Error("probe bid failed");
          }
          if (seat === slot.landlord) {
            state = bid.state;
            break;
          }
          state = bid.state;
        }

        let decisionIndex = 0;
        for (let step = 0; step < 256; step += 1) {
          if (state.phase === "finished") {
            break;
          }
          if (state.phase !== "ready-to-play" && state.phase !== "playing") {
            throw new Error(`probe unexpected phase ${state.phase}`);
          }
          const seat = state.currentSeat;
          const view = createPlayerView(state, seat);
          if (view === null || view.phase === "bidding") {
            throw new Error("probe expected a playing view");
          }
          const context: AiDecisionContext = Object.freeze({
            kind: "play",
            view,
            legalActions: generateLegalActions({ hand: view.hand, currentPlay: view.currentPlay }),
          });
          decisionIndex += 1;

          let evidence: DecisionLeafRecord | null = null;
          if (profiles[seat] === "master") {
            setDecisionSink((record) => {
              evidence = record;
            });
          }
          const command = strategies[seat].chooseCommand(context);
          setDecisionSink(null);

          const leader = commandOf(
            rankScoredPlayActions(context, "expert", { analyzerNodes: ROOT_ANALYZER_NODES })[0],
            seat,
          );
          const isOverride = commandKey(command) !== commandKey(leader);
          if (isOverride && profiles[seat] === "master" && view.landlord !== undefined) {
            // The base state for both branches: the position *before* the action.
            const before = state;
            const expertBranch = transition(before, leader);
            const rolloutBranch = transition(before, command);
            const seen = evidence as DecisionLeafRecord | null;
            if (expertBranch.ok && rolloutBranch.ok && seen !== null) {
              const anyTerminal = seen.leaves.some((leaf) => leaf.winner !== null);
              const expertWon = continuationWinner(expertBranch.state, profiles, gameSeed * 7 + decisionIndex);
              const rolloutWon = continuationWinner(rolloutBranch.state, profiles, gameSeed * 7 + decisionIndex);
              const rootIsLandlord = seat === view.landlord;
              if (expertWon !== null && rolloutWon !== null) {
                overrides += 1;
                records.push(Object.freeze({
                  bucket: anyTerminal ? "terminal" : "no-terminal",
                  branchEWon: rootIsLandlord ? expertWon === view.landlord : expertWon !== view.landlord,
                  branchRWon: rootIsLandlord ? rolloutWon === view.landlord : rolloutWon !== view.landlord,
                  rootSide: rootIsLandlord ? "landlord" : "peasant",
                  expertGap: Math.abs((seen.expertScores[0] ?? 0) - (seen.expertScores[1] ?? 0)),
                }));
              }
            }
          }

          const applied = transition(state, command);
          if (!applied.ok) {
            throw new Error(`probe command failed: ${applied.error.code}`);
          }
          state = applied.state;
        }
        // Self-check: the replay must agree with `playGame` on the same seed, or
        // the forks are being taken from a different game than the one measured.
        const reference = playGame(deck, slot.landlord, profiles, createRecorder(), {
          unboundedEvery: 0,
          seed: gameSeed,
          designed: true,
        });
        if (state.phase === "finished" && state.winner !== reference.winner) {
          throw new Error("probe replay diverged from playGame");
        }
      }
    }

    report(`collected ${overrides} forked overrides`);
    if (COLLECT_OUT !== undefined) {
      writeFileSync(COLLECT_OUT, `${JSON.stringify({ records })}\n`, "utf8");
    }
    expect(records.length).toBeGreaterThan(0);
  });
});
