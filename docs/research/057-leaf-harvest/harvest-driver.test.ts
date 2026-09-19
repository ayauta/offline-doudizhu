/**
 * TEMPORARY E1 calibration harvester — deleted after the corpus is frozen.
 *
 * Requires the instrumentation patch on `src/core/ai/master-policy.ts`
 * (`setDecisionSink`); both are archived under docs/research/057-leaf-harvest/.
 * It plays the designed path and dumps every `rootUtility` leaf, so a future
 * evaluator can be compared against the shipped one offline.
 *
 *   AI_BENCH_DEAL_START=5001 AI_BENCH_DEALS=50 AI_BENCH_HARVEST_OUT=... \
 *     vitest run --config vitest.benchmark.config.ts benchmarks/zz-leaf-harvest.test.ts
 */
import { writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { setDecisionSink, type DecisionLeafRecord } from "../src/core/ai/master-policy.js";
import { SEAT_ORDER, type Seat } from "../src/core/game/index.js";
import {
  armSchedule,
  createRecorder,
  dealDeck,
  playGame,
  readConfig,
  report,
  scheduleFor,
} from "./ai-tournament.js";
import { packHand, type CorpusDecision, type CorpusLeaf } from "./leaf-corpus.js";

const config = readConfig();
const out = process.env.AI_BENCH_HARVEST_OUT;

const SEAT_INDEX = new Map<Seat, number>(SEAT_ORDER.map((seat, index) => [seat, index]));

/** Set before each `playGame` so the sink can attribute its records. */
let current: { deal: number; arm: "A" | "B"; gameSeed: number } = {
  deal: -1,
  arm: "A",
  gameSeed: -1,
};

const decisions: CorpusDecision[] = [];

function recordDecision(record: DecisionLeafRecord): void {
  const leaves: CorpusLeaf[] = record.leaves.map((leaf) => Object.freeze({
    world: leaf.world,
    candidate: leaf.candidate,
    winner: leaf.winner,
    packed: Object.freeze([
      packHand(leaf.hands.human),
      packHand(leaf.hands["ai-one"]),
      packHand(leaf.hands["ai-two"]),
    ]) as readonly [number, number, number],
  }));
  decisions.push(Object.freeze({
    deal: current.deal,
    arm: current.arm,
    landlord: record.landlord,
    seat: record.seat,
    gameSeed: current.gameSeed,
    legalActions: record.legalActionCount,
    completedWorlds: record.completedWorlds,
    expertScores: Object.freeze([...record.expertScores]),
    chosen: record.chosen,
    leaves: Object.freeze(leaves),
  }));
}

describe.runIf(out !== undefined)("E1 calibration harvest", () => {
  it("dumps every rootUtility leaf on the designed path", () => {
    setDecisionSink(recordDecision);
    try {
      const recorder = createRecorder();
      for (let offset = 0; offset < config.deals; offset += 1) {
        const dealIndex = config.dealStart + offset;
        const dealSeed = config.seedBase + dealIndex;
        const deck = dealDeck(dealSeed);
        for (const slot of armSchedule(dealIndex)) {
          const profiles = scheduleFor("master", "default", slot.strongSeat);
          current = {
            deal: dealIndex,
            arm: slot.arm,
            gameSeed: dealSeed * 100 +
              (SEAT_INDEX.get(slot.strongSeat) ?? 0) * 10 +
              (SEAT_INDEX.get(slot.landlord) ?? 0),
          };
          playGame(deck, slot.landlord, profiles, recorder, {
            unboundedEvery: config.unboundedEvery,
            seed: current.gameSeed,
            designed: true,
          });
        }
      }
    } finally {
      setDecisionSink(null);
    }

    const leaves = decisions.reduce((sum, decision) => sum + decision.leaves.length, 0);
    report(
      `harvest: deals ${config.dealStart}..${config.dealStart + config.deals - 1} ` +
      `decisions=${decisions.length} leaves=${leaves}`,
    );

    if (out !== undefined) {
      writeFileSync(out, `${JSON.stringify({
        shard: {
          dealStart: config.dealStart,
          deals: config.deals,
          seedBase: config.seedBase,
        },
        decisions,
      })}\n`, "utf8");
      report(`harvest: wrote ${out}`);
    }
    expect(decisions.length).toBeGreaterThan(0);
  });
});
