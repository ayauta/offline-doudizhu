/**
 * Spec 065 Stage 1 / Stage 2 — the paired screen and the confirmation.
 *
 * Three env-gated modes.
 *
 *   invariant  AI_CF_T5_S1_INVARIANT=1 AI_BENCH_DEAL_START=160001 AI_BENCH_DEALS=8
 *   arm        AI_CF_T5_S1_ARM_STDOUT=baseline|challenger   (one arm, printed to
 *              stdout, writes NO file — driven by scripts/cf-top5-stage-run.mjs)
 *   combined   AI_CF_T5_S1_COMBINED=<result.json> AI_BENCH_DEAL_START=160001 AI_BENCH_DEALS=200
 *   smoke      AI_CF_T5_S1_OUT=<arm.json> AI_CF_T5_S1_ARM=baseline|challenger \
 *              AI_BENCH_DEAL_START=50001 AI_BENCH_DEALS=2      (retired seeds only)
 *   report     AI_CF_T5_S1_REPORT=<combined.json>
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
 *   - the challenger is `cfSelectTop5FarmerAction` — the same function the Stage 0
 *     guards pin — called directly so the runner can accumulate the §10
 *     structural cost counters.
 *
 * **Stage 1 cannot KEEP** (spec §9). It is a screen: the only outcomes are
 * "continue to Stage 2" and "stop this mechanism line". Nothing here computes a
 * verdict, and nothing here is allowed to look at the 200 deals before they are
 * all played.
 *
 * **No-peek holds by construction.** `quiet: true` means the tournament prints
 * no per-deal totals, so there is no intermediate result on disk to read even
 * if someone opens the log. Spec 064's Stage 1 was invalidated by exactly the
 * opposite, and the guard in `cf-pi-corpus-guards.test.ts` pins this file's
 * quiet setting so it cannot regress.
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
import { CF_PI_THRESHOLD } from "./cf-policy-iteration.js";
import { cfPiFrozenBaseline } from "./cf-pi-corpus.js";
import {
  assertNotFormalRange,
  splitCombined,
  writeCombinedAtomic,
  type CfTop5CombinedResult,
} from "./cf-top5-stage.js";
import { cfSelectTop5FarmerAction } from "./cf-top5.js";
import {
  CF_TOP5_STAGE1_END,
  CF_TOP5_STAGE1_START,
  CF_TOP5_STAGE2_END,
  CF_TOP5_STAGE2_START,
  assertTop5SeedBase,
} from "./cf-top5-corpus.js";

const INVARIANT = process.env.AI_CF_T5_S1_INVARIANT === "1";
/**
 * The formal mode: both arms, one process, one file, written once at the end.
 *
 * §14 requires that a formal stage's results exist only as a completed whole.
 * A per-arm file would make "the baseline finished" a readable state, which is
 * exactly the shape of the Spec 064 violation — no misbehaviour required, the
 * partial result simply exists.
 */
const COMBINED = process.env.AI_CF_T5_S1_COMBINED;
/**
 * One arm, its result printed to stdout and **nothing written to disk**.
 *
 * This is how the formal stages run the two arms in parallel without ever
 * creating a partial result: the children hold their numbers in memory and the
 * parent collects them and writes the single combined document once both have
 * exited. A child that wrote its own file would reintroduce exactly the
 * one-armed-on-disk state §14 forbids.
 */
const ARM_STDOUT = process.env.AI_CF_T5_S1_ARM_STDOUT as "baseline" | "challenger" | undefined;
/** Smoke mode. Retired ranges only; the formal pools refuse it. */
const OUT = process.env.AI_CF_T5_S1_OUT;
const REPORT = process.env.AI_CF_T5_S1_REPORT;
const ENABLED = INVARIANT || COMBINED !== undefined || ARM_STDOUT !== undefined ||
  OUT !== undefined || REPORT !== undefined;

const CF_PI_S1_TIMEOUT_MS = 4 * 60 * 60 * 1000;

/** The π2 model, as a benchmark-only artifact. Never reachable from `src/`. */
const CHALLENGER_MODEL_PATH = process.env.AI_CF_T5_MODEL ?? ".local/cf-top5-rows/model.json";

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
function loadChallengerModel(): TreeModel {
  const parsed = JSON.parse(readFileSync(CHALLENGER_MODEL_PATH, "utf8")) as {
    featureNames?: readonly string[];
    numFeatures?: number;
    numTrees?: number;
    trees?: readonly unknown[];
  };
  if (parsed.featureNames === undefined ||
    parsed.featureNames.length !== CF_FEATURE_NAMES.length ||
    parsed.featureNames.some((name, index) => name !== CF_FEATURE_NAMES[index])) {
    throw new Error(`${CHALLENGER_MODEL_PATH} does not carry the frozen feature order.`);
  }
  if (parsed.numFeatures !== CF_FEATURE_NAMES.length) {
    throw new Error(`${CHALLENGER_MODEL_PATH} declares ${String(parsed.numFeatures)} features.`);
  }
  if (parsed.trees?.length !== parsed.numTrees) {
    throw new Error(`${CHALLENGER_MODEL_PATH} carries ${String(parsed.trees?.length)} trees for ${String(parsed.numTrees)}.`);
  }
  return parseTreeModel(JSON.parse(readFileSync(CHALLENGER_MODEL_PATH, "utf8")) as Parameters<typeof parseTreeModel>[0]);
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
  assertTop5SeedBase(config.seedBase);
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
      const challengerModel = loadChallengerModel();
      return (strategy: Parameters<typeof createChallengerStrategy>[0]) => Object.freeze({
        chooseCommand: (context: Parameters<typeof strategy.chooseCommand>[0]) => {
          const production = strategy.chooseCommand(context);
          const outcome = cfSelectTop5FarmerAction(context, production, {
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

describe.runIf(ENABLED)("Spec 065 Stage 1 / Stage 2", () => {
  it("checks the landlord invariant, runs one arm, or reports the pair", () => {
    if (INVARIANT) {
      // §5.1 / §7.13 — the landlord root has no override to make, and the
      // composition must decline there without doing any work. Measured on the
      // command stream, per game: equal win totals can hide different play.
      const config = readConfig();
      assertTop5SeedBase(config.seedBase);
      const { model, threshold } = cfPiFrozenBaseline();
      const challengerModel = loadChallengerModel();
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
                    cfSelectTop5FarmerAction(context, strategy.chooseCommand(context), {
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

    if (ARM_STDOUT !== undefined) {
      const arm = ARM_STDOUT;
      // No file, no temp path, no partial anything: the result leaves through
      // stdout and the parent process is the only writer.
      const result = runArm(arm);
      process.stdout.write(`CF_TOP5_ARM_RESULT=${JSON.stringify({ arm, ...result })}\n`);
      expect(result.perDealA.length).toBeGreaterThan(0);
      return;
    }

    if (COMBINED !== undefined) {
      const config = readConfig();
      // Both arms, sequentially, in this one process. Nothing is written until
      // both are complete — the baseline's numbers have nowhere to go.
      const baseline = runArm("baseline");
      const challenger = runArm("challenger");
      const payload = {
        label: "spec065-top5-combined",
        config: {
          deals: config.deals,
          seedBase: config.seedBase,
          dealStart: config.dealStart,
          designed: config.designed,
        },
        preregisteredUniverse: { start: CF_TOP5_STAGE1_START, end: CF_TOP5_STAGE1_END },
        preregisteredStage2: { start: CF_TOP5_STAGE2_START, end: CF_TOP5_STAGE2_END },
        arms: { baseline, challenger },
        completedAt: new Date().toISOString(),
      };
      writeCombinedAtomic(COMBINED, payload);
      report(
        `[spec065 combined] deals ${baseline.perDealA.length} written once to ${COMBINED}`,
      );
      report(`[spec065 cost] baseline ${JSON.stringify(baseline.cost)}`);
      report(`[spec065 cost] challenger ${JSON.stringify(challenger.cost)}`);
      expect(baseline.perDealA.length).toBe(challenger.perDealA.length);
      // §10 — within the challenger arm, the widened layer must out-traverse
      // the narrow one. The baseline arm is frozen π1 alone and has no composed
      // cost to compare against, so comparing across arms would be vacuous.
      expect(challenger.cost.challengerRows)
        .toBeGreaterThanOrEqual(challenger.cost.baselineRows);
      // §7.17 — one shared candidate set per studied root.
      expect(challenger.cost.proposalCalls)
        .toBe(challenger.cost.decisions - challenger.cost.landlordDecisions);
      return;
    }

    if (OUT !== undefined) {
      const arm = (process.env.AI_CF_T5_S1_ARM ?? "baseline") as "baseline" | "challenger";
      const config = readConfig();
      // A per-arm file on a formal pool is the partial-result shape §14 forbids.
      assertNotFormalRange(
        config.dealStart, config.deals, `The per-arm mode (arm ${arm})`);
      const { perDealA, perDealB, cost } = runArm(arm);
      writeFileSync(OUT, `${JSON.stringify({
        label: `spec065-top5-${arm}`,
        config: {
          deals: config.deals,
          seedBase: config.seedBase,
          dealStart: config.dealStart,
          designed: config.designed,
          // The round's preregistered pool, not this invocation's range:
          // a smoke run on retired seeds still reports the pool the real
          // screen is defined over. `dealStart`/`deals` above describe the run.
          preregisteredUniverse: { start: CF_TOP5_STAGE1_START, end: CF_TOP5_STAGE1_END },
          preregisteredStage2: { start: CF_TOP5_STAGE2_START, end: CF_TOP5_STAGE2_END },
        },
        runs: { "master-default": { perDealA, perDealB, stoppedEarly: false } },
        cost,
      }, null, 2)}\n`, "utf8");
      report(
        `[spec065 ${arm}] deals ${perDealA.length} winA ${perDealA.reduce((a, b) => a + b, 0)} ` +
        `winB ${perDealB.reduce((a, b) => a + b, 0)}`,
      );
      // §10 structural cost gate — only meaningful on the challenger arm, and
      // only when the seat was actually studied.
      if (arm === "challenger") {
        const studied = cost.decisions - cost.landlordDecisions;
        report(
          `[spec065 cost] decisions ${cost.decisions} proposals ${cost.proposalCalls} ` +
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
        // §10 — the two layers no longer have the same width, so their
        // traversal counts no longer agree. π1 scores `|C3| - 1` alternatives
        // and π2 scores `|C5| - 1`, and `C3` is a prefix of `C5`, so the
        // challenger's layer must traverse **at least** as many rows as the
        // baseline's on every root it reaches, and strictly more wherever the
        // set actually widened.
        expect(cost.challengerRows).toBeGreaterThanOrEqual(cost.baselineRows);
        expect(cost.challengerRows).toBeGreaterThan(0);
      }
      expect(perDealA.length).toBeGreaterThan(0);
      return;
    }

    // The report is a *view* of a completed combined result, never a merge of
    // two independently-written files: both arms were already on disk together
    // before this ran.
    const combined = JSON.parse(readFileSync(REPORT as string, "utf8")) as CfTop5CombinedResult;
    // Refuse to derive anything from a document that is missing an arm: a
    // "combined" file with one arm would be exactly the partial result this
    // whole protocol exists to prevent, and it must not be reportable either.
    for (const arm of ["baseline", "challenger"] as const) {
      if (combined.arms?.[arm] === undefined) {
        throw new Error(`The combined result has no ${arm} arm; refusing to report on it.`);
      }
    }
    const { baseline, challenger } = splitCombined(combined);
    const base = baseline as { runs: Record<string, unknown> };
    const cand = challenger as { runs: Record<string, unknown> };
    // The two dumps `paired-compare.test.ts` reads. Written here, *after* both
    // arms were already on disk together, so deriving them cannot create a
    // partial state — they are views of a finished result, not results.
    const baselinePath = `${REPORT as string}.baseline.json`;
    const challengerPath = `${REPORT as string}.challenger.json`;
    writeFileSync(baselinePath, `${JSON.stringify(baseline)}\n`, "utf8");
    writeFileSync(challengerPath, `${JSON.stringify(challenger)}\n`, "utf8");
    report(`paired dumps ${baselinePath} , ${challengerPath}`);
    report(`\n== Spec 065 paired run ==`);
    report(`combined    ${REPORT as string}`);
    report(`completed   ${combined.completedAt}`);
    report(`cost        baseline ${JSON.stringify(combined.arms.baseline.cost)}`);
    report(`cost        challenger ${JSON.stringify(combined.arms.challenger.cost)}`);
    // Deliberately no verdict here. The paired interval, the continue condition
    // and the STOP rule live in `paired-compare.test.ts` and spec §9, and Stage
    // 1 is not allowed to KEEP under any outcome.
    expect(Object.keys(base.runs).length).toBeGreaterThan(0);
    expect(Object.keys(cand.runs).length).toBeGreaterThan(0);
  }, CF_PI_S1_TIMEOUT_MS);
});
