/**
 * Spec 064 Stage 1 — the fixed 200-group paired screen (`120001–120200`).
 *
 * Three env-gated modes.
 *
 *   invariant  AI_CF_PI_S1_INVARIANT=1 AI_BENCH_DEAL_START=120001 AI_BENCH_DEALS=8
 *   run        AI_CF_PI_S1_OUT=<shard.json> AI_CF_PI_S1_ARM=baseline|challenger \
 *              AI_BENCH_DEAL_START=120001 AI_BENCH_DEALS=200
 *   report     AI_CF_PI_S1_REPORT=<baseline.json>,<challenger.json>
 *
 * The two arms differ in exactly one thing: whether the strong seat's strategy
 * is the frozen selector alone (baseline) or the frozen selector with the π2
 * model stacked on it (challenger, spec §5). Same schedule, same deals, same
 * seeds, same opponents.
 *
 * Two deliberate reuses:
 *
 *   - the statistics come from `paired-compare.test.ts`, not from anything new
 *     here. This file only writes dumps in the shape that harness already reads.
 *     Re-deriving the interval for a new experiment is how two experiments stop
 *     being comparable.
 *   - the challenger is `cfSelectTwoLayerFarmerAction` — the same function the
 *     Stage 0 guards pin — called directly rather than through
 *     `createTwoLayerStrategy`, so the runner can accumulate the §10 structural
 *     cost counters the strategy wrapper discards. The wrapper's agreement with
 *     this call shape is guarded in `cf-policy-iteration.test.ts`.
 *
 * **Stage 1 cannot KEEP** (spec §9). It is a screen: the only outcomes are
 * "continue to Stage 2" and "stop this mechanism line". Nothing here computes a
 * verdict, and nothing here is allowed to look at the 200 deals before they are
 * all played.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SEAT_ORDER, type Seat } from "../src/core/game/index.js";
import {
  createRecorder,
  dealDeck,
  playGame,
  readConfig,
  report,
  runPairTournament,
  scheduleFor,
} from "./ai-tournament.js";
import { parseTreeModel, type TreeModel } from "./cf-model.js";
import { CF_FEATURE_NAMES } from "./cf-dataset.js";
import { createChallengerStrategy } from "./cf-challenger.js";
import {
  CF_PI_STAGE1_END,
  CF_PI_STAGE1_START,
  CF_PI_THRESHOLD,
  assertPiSeedBase,
  cfSelectTwoLayerFarmerAction,
} from "./cf-policy-iteration.js";
import { cfPiFrozenBaseline } from "./cf-pi-corpus.js";

const INVARIANT = process.env.AI_CF_PI_S1_INVARIANT === "1";
const OUT = process.env.AI_CF_PI_S1_OUT;
const REPORT = process.env.AI_CF_PI_S1_REPORT;
const ENABLED = INVARIANT || OUT !== undefined || REPORT !== undefined;

const CF_PI_S1_TIMEOUT_MS = 4 * 60 * 60 * 1000;

/** The π2 model, as a benchmark-only artifact. Never reachable from `src/`. */
const P2_MODEL_PATH = process.env.AI_CF_PI_P2_MODEL ?? ".local/cf-pi-rows/pi2-model.json";

/**
 * The π2 artifact, with its schema pinned to the frozen one.
 *
 * `parseTreeModel` checks that the tree table is internally consistent, but it
 * cannot know which columns the model expects those trees to be reading: a π2
 * artifact trained on a reordered feature list would score perfectly happily
 * and mean something else entirely. §7.18's whole claim is that the candidate
 * interface did not move, so the column order is checked here rather than
 * assumed from the fact that the file parsed.
 */
function loadP2Model(): TreeModel {
  const parsed = JSON.parse(readFileSync(P2_MODEL_PATH, "utf8")) as {
    featureNames?: readonly string[];
    numFeatures?: number;
    numTrees?: number;
    trees?: readonly unknown[];
  };
  if (parsed.featureNames === undefined ||
    parsed.featureNames.length !== CF_FEATURE_NAMES.length ||
    parsed.featureNames.some((name, index) => name !== CF_FEATURE_NAMES[index])) {
    throw new Error(`${P2_MODEL_PATH} does not carry the frozen feature order.`);
  }
  if (parsed.numFeatures !== CF_FEATURE_NAMES.length) {
    throw new Error(`${P2_MODEL_PATH} declares ${String(parsed.numFeatures)} features.`);
  }
  if (parsed.trees?.length !== parsed.numTrees) {
    throw new Error(`${P2_MODEL_PATH} carries ${String(parsed.trees?.length)} trees for ${String(parsed.numTrees)}.`);
  }
  return parseTreeModel(JSON.parse(readFileSync(P2_MODEL_PATH, "utf8")) as Parameters<typeof parseTreeModel>[0]);
}

/**
 * The structural cost gate's counters (spec §10), accumulated over real play.
 *
 * Every *studied* decision the composition reaches contributes one `cfProposal`
 * call and one traversal per alternative per layer. `proposalCalls` is the
 * number §7.17 turns on. It is **not** the decision count: landlord roots are
 * declined before anything is computed (§5.1), so the equality that holds is
 * `proposalCalls === decisions - landlordDecisions`.
 */
type PiCost = {
  decisions: number;
  proposalCalls: number;
  baselineRows: number;
  challengerRows: number;
  baselineOverrides: number;
  challengerOverrides: number;
  landlordDecisions: number;
};

function emptyCost(): PiCost {
  return {
    decisions: 0, proposalCalls: 0, baselineRows: 0, challengerRows: 0,
    baselineOverrides: 0, challengerOverrides: 0, landlordDecisions: 0,
  };
}

function runArm(arm: "baseline" | "challenger"): Readonly<{
  perDealA: number[];
  perDealB: number[];
  cost: PiCost;
}> {
  const config = readConfig();
  // §7.10 — the corpus and the strength run must name the same game the same
  // way. A non-zero base would silently move the whole screen onto other decks.
  assertPiSeedBase(config.seedBase);
  const { model, threshold } = cfPiFrozenBaseline();
  const cost = emptyCost();
  const recorder = createRecorder();

  // `quiet: true` is a protocol requirement, not a preference. `quiet: false`
  // makes `runPairTournament` print a cumulative win total and win rate after
  // every single deal (see its `report` call). If that stdout is redirected to
  // a file — as it is here — the run leaves a readable intermediate result on
  // disk for the whole two-arm window, and §14's no-peek rule then rests on
  // nobody opening it. A guarantee that holds only while nobody looks is not a
  // guarantee: the results must not exist in readable form until both arms are
  // done. Stage 1 was invalidated by exactly this on 2026-09-22.
  const pairRun = runPairTournament(config, "master", "default", recorder, {
    quiet: true,
    decoratorFor: (strongSeat: Seat) => {
      if (arm === "baseline") {
        // Frozen π1 and nothing else — the same wrapper Gate B measured.
        return (strategy: Parameters<typeof createChallengerStrategy>[0]) =>
          createChallengerStrategy(strategy, { model, threshold, seat: strongSeat });
      }
      const challengerModel = loadP2Model();
      return (strategy: Parameters<typeof createChallengerStrategy>[0]) => Object.freeze({
        chooseCommand: (context: Parameters<typeof strategy.chooseCommand>[0]) => {
          const production = strategy.chooseCommand(context);
          const outcome = cfSelectTwoLayerFarmerAction(context, production, {
            baselineModel: model,
            challengerModel,
            threshold: CF_PI_THRESHOLD,
            seat: strongSeat,
          });
          cost.decisions += 1;
          cost.proposalCalls += outcome.proposals;
          cost.baselineRows += outcome.baselineRows;
          cost.challengerRows += outcome.challengerRows;
          cost.baselineOverrides += outcome.baselineOverrode ? 1 : 0;
          cost.challengerOverrides += outcome.overrode ? 1 : 0;
          if (context.kind === "play" && context.view.seat === context.view.landlord) {
            cost.landlordDecisions += 1;
          }
          return outcome.command;
        },
      });
    },
  });

  return Object.freeze({
    perDealA: [...pairRun.perDealA],
    perDealB: [...pairRun.perDealB],
    cost,
  });
}

describe.runIf(ENABLED)("Spec 064 Stage 1", () => {
  it("checks the landlord invariant, runs one arm, or reports the pair", () => {
    if (INVARIANT) {
      // §5.1 / §7.13 — the landlord root has no override to make, and the
      // composition must decline there without doing any work. Measured on the
      // command stream, per game: equal win totals can hide different play.
      const config = readConfig();
      assertPiSeedBase(config.seedBase);
      const { model, threshold } = cfPiFrozenBaseline();
      const challengerModel = loadP2Model();
      let games = 0;
      let divergences = 0;
      let firstDivergence = -1;
      let commandCount = 0;

      for (let offset = 0; offset < config.deals; offset += 1) {
        const dealIndex = config.dealStart + offset;
        const dealSeed = config.seedBase + dealIndex;
        const deck = dealDeck(dealSeed);
        for (const strongSeat of SEAT_ORDER) {
          const profiles = scheduleFor("master", "default", strongSeat);
          const gameSeed = dealSeed * 100 +
            SEAT_ORDER.indexOf(strongSeat) * 10 + SEAT_ORDER.indexOf(strongSeat);
          const play = (twoLayer: boolean): readonly string[] => {
            const rec = createRecorder({ logCommands: true });
            playGame(deck, strongSeat, profiles, rec, {
              unboundedEvery: config.unboundedEvery,
              seed: gameSeed,
              designed: true,
              decorate: (seat, strategy) => {
                if (seat !== strongSeat) {
                  return strategy;
                }
                if (!twoLayer) {
                  return createChallengerStrategy(strategy, { model, threshold, seat: strongSeat });
                }
                return Object.freeze({
                  chooseCommand: (context: Parameters<typeof strategy.chooseCommand>[0]) =>
                    cfSelectTwoLayerFarmerAction(context, strategy.chooseCommand(context), {
                      baselineModel: model,
                      challengerModel,
                      threshold: CF_PI_THRESHOLD,
                      seat: strongSeat,
                    }).command,
                });
              },
            });
            return rec.commands ?? [];
          };
          const baseline = play(false);
          const challenger = play(true);
          games += 1;
          commandCount += baseline.length;
          if (baseline.length !== challenger.length ||
            baseline.some((command, index) => command !== challenger[index])) {
            divergences += 1;
            if (firstDivergence < 0) {
              firstDivergence = games;
            }
          }
        }
      }
      report(`\nStage 1 arm-A invariant: ${games} games, ${commandCount} baseline commands`);
      report(`divergent games ${divergences}${firstDivergence >= 0 ? ` (first #${firstDivergence})` : ""}`);
      expect(divergences).toBe(0);
      return;
    }

    if (OUT !== undefined) {
      const arm = (process.env.AI_CF_PI_S1_ARM ?? "baseline") as "baseline" | "challenger";
      const { perDealA, perDealB, cost } = runArm(arm);
      const config = readConfig();
      writeFileSync(OUT, `${JSON.stringify({
        label: `spec064-stage1-${arm}`,
        config: {
          deals: config.deals,
          seedBase: config.seedBase,
          dealStart: config.dealStart,
          designed: config.designed,
          // The round's preregistered pool, not this invocation's range:
          // a smoke run on retired seeds still reports the pool the real
          // screen is defined over. `dealStart`/`deals` above describe the run.
          preregisteredUniverse: { start: CF_PI_STAGE1_START, end: CF_PI_STAGE1_END },
        },
        runs: { "master-default": { perDealA, perDealB, stoppedEarly: false } },
        cost,
      }, null, 2)}\n`, "utf8");
      report(
        `[stage1 ${arm}] deals ${perDealA.length} winA ${perDealA.reduce((a, b) => a + b, 0)} ` +
        `winB ${perDealB.reduce((a, b) => a + b, 0)}`,
      );
      // §10 structural cost gate — only meaningful on the challenger arm, and
      // only when the seat was actually studied.
      if (arm === "challenger") {
        const studied = cost.decisions - cost.landlordDecisions;
        report(
          `[stage1 cost] decisions ${cost.decisions} proposals ${cost.proposalCalls} ` +
          `baselineRows ${cost.baselineRows} challengerRows ${cost.challengerRows} ` +
          `baselineOverrides ${cost.baselineOverrides} challengerOverrides ${cost.challengerOverrides} ` +
          `landlordDecisions ${cost.landlordDecisions}`,
        );
        // §7.17 — exactly one shared proposal per studied root, never two.
        // The landlord roots are *not* studied roots: §5.1 requires the
        // composition to decline there before it computes anything, so they
        // contribute zero proposals. Measured on a retired-seed smoke: 119
        // decisions and 59 landlord decisions produced 60 proposals, which is
        // the equality below and not `proposalCalls === decisions`.
        expect(cost.proposalCalls).toBe(cost.decisions - cost.landlordDecisions);
        expect(studied).toBe(cost.decisions - cost.landlordDecisions);
        // §5.1's structural half, measured rather than asserted: the landlord
        // arm really was exercised, and it really did decline.
        expect(cost.landlordDecisions).toBeGreaterThan(0);
        // §10 — each layer scores `|C| - 1` alternatives at every root it is
        // given, so the two traversal counts agree root for root.
        expect(cost.baselineRows).toBe(cost.challengerRows);
        expect(cost.baselineRows).toBeGreaterThanOrEqual(cost.proposalCalls);
      }
      expect(perDealA.length).toBeGreaterThan(0);
      return;
    }

    const [basePath, candPath] = (REPORT as string).split(",");
    if (basePath === undefined || candPath === undefined) {
      throw new Error("AI_CF_PI_S1_REPORT must be <baseline.json>,<challenger.json>");
    }
    const base = JSON.parse(readFileSync(basePath, "utf8")) as {
      runs: Record<string, { perDealA: number[]; perDealB: number[] }>;
      cost?: PiCost;
    };
    const cand = JSON.parse(readFileSync(candPath, "utf8")) as {
      runs: Record<string, { perDealA: number[]; perDealB: number[] }>;
      cost?: PiCost;
    };
    report(`\n== Stage 1 screen ==`);
    report(`baseline    ${basePath}`);
    report(`challenger  ${candPath}`);
    report(`cost        ${JSON.stringify(cand.cost)}`);
    // Deliberately no verdict here. The paired interval, the continue condition
    // and the STOP rule live in `paired-compare.test.ts` and spec §9, and Stage
    // 1 is not allowed to KEEP under any outcome.
    expect(Object.keys(base.runs).length).toBeGreaterThan(0);
    expect(Object.keys(cand.runs).length).toBeGreaterThan(0);
  }, CF_PI_S1_TIMEOUT_MS);
});
