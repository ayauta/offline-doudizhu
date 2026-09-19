/**
 * Is terminal rollout evidence actually informative about the real game?
 *
 * H5's whole premise is that a rollout which reached a decided position carries
 * better evidence than one that did not, and that the fixed 0.2 blend therefore
 * under-uses it. That premise is testable without fitting anything: bucket
 * decisions by the terminal evidence the chosen candidate's rollout produced,
 * and look at the *actual* game outcome in each bucket.
 *
 * If unanimous-win evidence does not correspond to a higher real win rate than
 * conflicting or absent evidence, there is no signal to gate on and H5 should
 * close. No threshold is chosen here, no weight is searched, and nothing is
 * fitted to outcomes — the buckets are mechanical and the outcome is only ever
 * read, never optimised.
 *
 *   collect: AI_BENCH_TE_OUT=<shard.json> AI_BENCH_DEAL_START=5001 AI_BENCH_DEALS=50
 *   report:  AI_BENCH_TE_MERGE=<shard dir> [AI_BENCH_TE_CORPUS=.local/calibration]
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SEAT_ORDER, type Seat } from "../src/core/game/index.js";
import { formatPercent } from "./ai-stats.js";
import {
  armSchedule,
  createRecorder,
  dealDeck,
  playGame,
  readConfig,
  report,
  scheduleFor,
} from "./ai-tournament.js";
import {
  handSizes,
  shippedUtility,
  type CorpusDecision,
  type CorpusShard,
} from "./leaf-corpus.js";
import { estimateBasicHandTurns } from "../src/core/ai/hand-analyzer.js";

const COLLECT_OUT = process.env.AI_BENCH_TE_OUT;
const MERGE_DIR = process.env.AI_BENCH_TE_MERGE;
const CORPUS_DIR = process.env.AI_BENCH_TE_CORPUS ?? ".local/calibration";
const ROOT_BLEND_WEIGHT = 0.2;

type GameRecord = Readonly<{ gameSeed: number; winner: Seat }>;
type GameShard = Readonly<{ shard: { dealStart: number; deals: number }; games: readonly GameRecord[] }>;

function readJsonDir<T>(directory: string, pick: (parsed: T) => boolean): readonly T[] {
  const out: T[] = [];
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".json")).sort()) {
    const parsed = JSON.parse(readFileSync(join(directory, name), "utf8")) as T;
    if (pick(parsed)) {
      out.push(parsed);
    }
  }
  return out;
}

function sameSide(seat: Seat, other: Seat, landlord: Seat): boolean {
  return seat === landlord ? other === landlord : other !== landlord;
}

describe.runIf(COLLECT_OUT !== undefined || MERGE_DIR !== undefined)("H5 terminal evidence", () => {
  it("collects real game outcomes, or measures whether terminal evidence tracks them", () => {
    if (MERGE_DIR !== undefined) {
      const games = readJsonDir<GameShard>(MERGE_DIR, (parsed) => Array.isArray(parsed.games))
        .flatMap((shard) => shard.games);
      const bySeed = new Map<number, Seat>(games.map((game) => [game.gameSeed, game.winner]));
      const decisions = readJsonDir<CorpusShard>(CORPUS_DIR, (parsed) => Array.isArray(parsed.decisions))
        .flatMap((shard) => shard.decisions);

      report(`\n== H5 terminal evidence (${games.length} games, ${decisions.length} decisions) ==`);

      type Bucket = { decisions: number; realWins: number; rollouts: number; rolloutsWithTerminal: number };
      const buckets = new Map<string, Bucket>();
      const bucketFor = (name: string): Bucket => {
        const existing = buckets.get(name) ?? { decisions: 0, realWins: 0, rollouts: 0, rolloutsWithTerminal: 0 };
        buckets.set(name, existing);
        return existing;
      };
      let joined = 0;
      let unjoined = 0;

      // Also: how often the rollout's own ordering ever mattered at all.
      let overturnedTop1 = 0;
      let multiCandidate = 0;
      const contributionByBucket = new Map<string, number[]>();

      for (const decision of decisions as readonly CorpusDecision[]) {
        const winner = bySeed.get(decision.gameSeed);
        if (winner === undefined) {
          unjoined += 1;
          continue;
        }
        joined += 1;
        const rootSideWon = sameSide(decision.seat, winner, decision.landlord);

        const chosen = decision.chosen;
        let terminal = 0;
        let terminalWins = 0;
        const totals = decision.expertScores.map(() => 0);
        const counts = decision.expertScores.map(() => 0);
        const terminalByCandidate = decision.expertScores.map(() => ({ wins: 0, losses: 0 }));
        for (const leaf of decision.leaves) {
          const value = shippedUtility(decision, leaf, estimateBasicHandTurns);
          totals[leaf.candidate] = (totals[leaf.candidate] ?? 0) + value;
          counts[leaf.candidate] = (counts[leaf.candidate] ?? 0) + 1;
          if (leaf.winner !== null) {
            const slot = terminalByCandidate[leaf.candidate];
            if (slot !== undefined) {
              if (sameSide(decision.seat, leaf.winner, decision.landlord)) {
                slot.wins += 1;
              } else {
                slot.losses += 1;
              }
            }
            if (leaf.candidate === chosen) {
              terminal += 1;
              if (sameSide(decision.seat, leaf.winner, decision.landlord)) {
                terminalWins += 1;
              }
            }
          }
        }

        const chosenTerminals = terminal;
        const name = chosenTerminals === 0
          ? "0 terminal"
          : terminalWins === chosenTerminals
            ? "all wins"
            : terminalWins === 0
              ? "all losses"
              : "conflicting";
        const bucket = bucketFor(name);
        bucket.decisions += 1;
        if (rootSideWon) {
          bucket.realWins += 1;
        }
        bucket.rollouts += chosenTerminals;
        bucket.rolloutsWithTerminal += chosenTerminals > 0 ? 1 : 0;

        if (decision.expertScores.length >= 2) {
          multiCandidate += 1;
          const order = (values: readonly number[]) =>
            values.map((value, index) => ({ value, index }))
              .sort((left, right) => right.value - left.value || left.index - right.index);
          const anchoredOrder = order(decision.expertScores).map((entry) => entry.index);
          const blended = decision.expertScores.map(
            (score, index) => score + ROOT_BLEND_WEIGHT * ((totals[index] ?? 0) / Math.max(1, counts[index] ?? 1)),
          );
          if ((order(blended)[0]?.index ?? -1) !== (anchoredOrder[0] ?? -1)) {
            overturnedTop1 += 1;
          }
          const contribution = Math.abs(
            ROOT_BLEND_WEIGHT * ((totals[chosen] ?? 0) / Math.max(1, counts[chosen] ?? 1)),
          );
          const list = contributionByBucket.get(name) ?? [];
          list.push(contribution);
          contributionByBucket.set(name, list);
        }
      }

      report(`joined ${joined} decisions to their game (${unjoined} unjoined)`);
      report(`\nreal root-side win rate, by the chosen candidate's terminal evidence:`);
      for (const name of ["0 terminal", "conflicting", "all wins", "all losses"]) {
        const bucket = buckets.get(name);
        if (bucket === undefined) continue;
        const contributions = contributionByBucket.get(name) ?? [];
        const meanContribution = contributions.length === 0
          ? 0
          : contributions.reduce((sum, value) => sum + value, 0) / contributions.length;
        report(
          `${name.padEnd(14)} decisions=${String(bucket.decisions).padStart(6)}  ` +
          `REAL WIN RATE=${formatPercent(bucket.decisions === 0 ? 0 : bucket.realWins / bucket.decisions).padStart(7)}  ` +
          `|0.2xrollout| p50≈${meanContribution.toFixed(0)}`,
        );
      }
      report(
        `\nrollout overturned the anchored leader on ${overturnedTop1}/${multiCandidate} ` +
        `multi-candidate decisions (${formatPercent(multiCandidate === 0 ? 0 : overturnedTop1 / multiCandidate)})`,
      );
      report(
        `\nreading: if terminal evidence is informative, "all wins" should sit clearly above ` +
        `"0 terminal", which should sit above "all losses". No threshold is derived here.`,
      );
      expect(joined).toBeGreaterThan(0);
      return;
    }

    const config = readConfig();
    expect(config.designed).toBe(true);
    const recorder = createRecorder();
    const games: GameRecord[] = [];
    for (let offset = 0; offset < config.deals; offset += 1) {
      const dealIndex = config.dealStart + offset;
      const dealSeed = config.seedBase + dealIndex;
      const deck = dealDeck(dealSeed);
      for (const slot of armSchedule(dealIndex)) {
        const gameSeed = dealSeed * 100 +
          SEAT_ORDER.indexOf(slot.strongSeat) * 10 +
          SEAT_ORDER.indexOf(slot.landlord);
        const outcome = playGame(deck, slot.landlord, scheduleFor("master", "default", slot.strongSeat), recorder, {
          unboundedEvery: config.unboundedEvery,
          seed: gameSeed,
          designed: true,
        });
        games.push(Object.freeze({ gameSeed, winner: outcome.winner }));
      }
    }
    report(`collected ${games.length} game outcomes`);
    if (COLLECT_OUT !== undefined) {
      writeFileSync(COLLECT_OUT, `${JSON.stringify({
        shard: { dealStart: config.dealStart, deals: config.deals },
        games,
      })}\n`, "utf8");
    }
    void handSizes;
    expect(games.length).toBeGreaterThan(0);
  });
});
