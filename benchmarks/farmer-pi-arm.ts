/**
 * Farmer Policy Iteration Factory v1 — the farmer-arm paired full-game run.
 *
 * §16 changes what the Factory measures. Every earlier round reported a
 * *combined* number over both arms and divided by two; the Factory reports the
 * farmer arm alone, because the landlord is frozen for the whole Factory and a
 * landlord game cannot contain the thing under study. So the primary statistic
 * is built from `perDealB` — the three games of each deal in which the strong
 * seat is a farmer — and `perDealA` is kept beside it as a diagnostic rather
 * than folded into the answer.
 *
 * §17 changes how it is run. Every strength number here comes from a *designed*
 * run: an infinite deadline, a fixed deal list, no wall-clock cutoff anywhere
 * on the decision path, so the result is a property of the policies and not of
 * the machine's load. Shipped latency is a different question, asked once, at
 * the end of the Factory.
 *
 * §16 also fixes what the two arms *are*: the same tested farmer seat, on the
 * same deals, against the same landlord and the same teammate. The harness
 * provides that by construction — `decoratorFor` is handed one seat and its
 * decorator is installed on that seat alone — so this module never has to
 * reason about which seats changed.
 */
import type { AiStrategy } from "../src/core/ai/index.js";
import type { Seat } from "../src/core/game/index.js";
import {
  createRecorder,
  runPairTournament,
  type BenchmarkConfig,
} from "./ai-tournament.js";
import { createChainStrategy, type ChainOutcome, type ChampionChain } from "./farmer-pi-chain.js";
import { sha256, stableHash } from "./farmer-pi-stage.js";

/** The two arms of every Factory stage. */
export type FarmerArm = "champion" | "candidate";

export const FARMER_ARMS: readonly FarmerArm[] = Object.freeze(["champion", "candidate"]);

/**
 * The frozen run knobs.
 *
 * `secondsCap` is set to a value the comparison can never reach, and the arm
 * runner asserts `stoppedEarly === false` after every deal. That assertion is
 * the point: a cap that silently truncated a run would turn "this policy is
 * stronger" into "this policy got further down the deal list", and the harness
 * already stops cleanly between deals rather than mid-game, so the failure
 * would look like a slightly short result rather than a broken one.
 */
export const FARMER_RUN_CONFIG: Readonly<BenchmarkConfig> = Object.freeze({
  deals: 1,
  seedBase: 0,
  dealStart: 0,
  designed: true,
  secondsCap: Number.MAX_SAFE_INTEGER,
  probeDeals: 1,
  controlDeals: 1,
  unboundedEvery: 10,
  strict: false,
  truncationCeiling: 1,
  pairs: null,
});

/**
 * What one deal's run produced. Deterministic, and therefore hashed.
 *
 * `winsA`/`gamesA` are recorded but never promoted on: they are the landlord
 * arm, where the chain cannot act, and a difference there would mean the
 * installation leaked rather than that a policy improved.
 */
export type FarmerDealPayload = Readonly<{
  dealIndex: number;
  winsA: number;
  gamesA: number;
  winsB: number;
  gamesB: number;
  /** Chain decisions taken across the whole deal, all six games. */
  chainDecisions: number;
  /** Those where some layer replaced the action it was handed. */
  chainOverrides: number;
  /** Model traversals the chain made. */
  chainRows: number;
}>;

export type FarmerDealCost = Readonly<{
  elapsedMs: number;
  inferenceMs: number;
}>;

export type FarmerDealOutcome = Readonly<{
  payload: FarmerDealPayload;
  cost: FarmerDealCost;
}>;

/**
 * Runs one initial deal under one chain, and reports the farmer arm.
 *
 * The decorator is rebuilt per game from the seat the harness hands it, which
 * is what binds the chain to the studied seat and leaves the other two seats
 * running the production strategy they were created with.
 */
export function runFarmerDeal(options: Readonly<{
  chain: ChampionChain;
  dealIndex: number;
}>): FarmerDealOutcome {
  let chainDecisions = 0;
  let chainOverrides = 0;
  let chainRows = 0;
  let inferenceMs = 0;
  const recorder = createRecorder();
  const started = Date.now();
  const run = runPairTournament(
    Object.freeze({ ...FARMER_RUN_CONFIG, dealStart: options.dealIndex }),
    "master",
    "default",
    recorder,
    {
      quiet: true,
      decoratorFor: (strongSeat: Seat) => (strategy: AiStrategy) =>
        createChainStrategy(strategy, {
          chain: options.chain,
          seat: strongSeat,
          observe: (outcome: ChainOutcome) => {
            chainDecisions += 1;
            chainRows += outcome.totalRows;
            if (outcome.overrode) {
              chainOverrides += 1;
            }
            for (const ms of outcome.layerInferenceMs) {
              inferenceMs += ms;
            }
          },
        }),
    },
  );
  if (run.stoppedEarly || run.playedDeals !== 1) {
    throw new Error(
      `Designed deal ${options.dealIndex} stopped early after ${run.playedDeals} deals. ` +
      "A designed run has no deadline and must play every deal it was given.",
    );
  }
  const winsA = run.perDealA[0];
  const winsB = run.perDealB[0];
  if (winsA === undefined || winsB === undefined) {
    throw new Error(`Designed deal ${options.dealIndex} produced no per-deal result.`);
  }
  return Object.freeze({
    payload: Object.freeze({
      dealIndex: options.dealIndex,
      winsA,
      gamesA: 3,
      winsB,
      gamesB: 3,
      chainDecisions,
      chainOverrides,
      chainRows,
    }),
    cost: Object.freeze({
      elapsedMs: Date.now() - started,
      inferenceMs,
    }),
  });
}

/**
 * The config hash a stage's checkpoints are bound to.
 *
 * Covers the chain identity and every frozen run knob — anything that could
 * change a deal's result. Two runs whose hashes differ are two different
 * experiments, and the checkpoint layer refuses to mix them.
 */
export function armConfigHash(options: Readonly<{
  chain: ChampionChain;
  arm: FarmerArm;
  protocolHash: string;
}>): string {
  return sha256(JSON.stringify({
    arm: options.arm,
    protocolHash: options.protocolHash,
    championId: options.chain.championId,
    layers: options.chain.layers.map((layer) => ({
      modelSha256: layer.modelSha256,
      threshold: layer.threshold,
      modelBytes: layer.modelBytes,
    })),
    schemaHash: options.chain.schemaHash,
    baseMasterVersion: options.chain.baseMasterVersion,
    top3Version: options.chain.top3Version,
    run: {
      designed: FARMER_RUN_CONFIG.designed,
      seedBase: FARMER_RUN_CONFIG.seedBase,
      unboundedEvery: FARMER_RUN_CONFIG.unboundedEvery,
      strict: FARMER_RUN_CONFIG.strict,
    },
  }));
}

/** One arm's per-deal farmer win counts, indexed by absolute deal index. */
export type FarmerArmResult = Readonly<{
  arm: FarmerArm;
  /** Absolute deal index of `winsB[0]`. */
  start: number;
  /** Wins out of three, farmer arm, one entry per deal in order. */
  winsB: readonly number[];
  winsA: readonly number[];
  chainDecisions: number;
  chainOverrides: number;
  chainRows: number;
  inferenceMs: number;
  elapsedMs: number;
}>;

export function emptyArmAccumulator(arm: FarmerArm, start: number): {
  arm: FarmerArm;
  start: number;
  winsB: number[];
  winsA: number[];
  chainDecisions: number;
  chainOverrides: number;
  chainRows: number;
  inferenceMs: number;
  elapsedMs: number;
} {
  return {
    arm, start, winsB: [], winsA: [],
    chainDecisions: 0, chainOverrides: 0, chainRows: 0, inferenceMs: 0, elapsedMs: 0,
  };
}

export function accumulateDeal(
  accumulator: ReturnType<typeof emptyArmAccumulator>,
  outcome: FarmerDealOutcome,
): void {
  accumulator.winsB.push(outcome.payload.winsB);
  accumulator.winsA.push(outcome.payload.winsA);
  accumulator.chainDecisions += outcome.payload.chainDecisions;
  accumulator.chainOverrides += outcome.payload.chainOverrides;
  accumulator.chainRows += outcome.payload.chainRows;
  accumulator.inferenceMs += outcome.cost.inferenceMs;
  accumulator.elapsedMs += outcome.cost.elapsedMs;
}

export function freezeArm(
  accumulator: ReturnType<typeof emptyArmAccumulator>,
): FarmerArmResult {
  return Object.freeze({
    arm: accumulator.arm,
    start: accumulator.start,
    winsB: Object.freeze([...accumulator.winsB]),
    winsA: Object.freeze([...accumulator.winsA]),
    chainDecisions: accumulator.chainDecisions,
    chainOverrides: accumulator.chainOverrides,
    chainRows: accumulator.chainRows,
    inferenceMs: accumulator.inferenceMs,
    elapsedMs: accumulator.elapsedMs,
  });
}

/**
 * The primary statistic: deal-level paired farmer differences.
 *
 * Each deal contributes `(candidate − champion) / 3` — the difference in that
 * deal's farmer-arm win *rate*, in the three games that deal contains. Deals
 * are the unit because the three games of a deal share a deck and a landlord
 * rotation, so they are not independent observations of the same thing.
 */
export function pairedFarmerDifferences(
  champion: FarmerArmResult,
  candidate: FarmerArmResult,
): readonly number[] {
  if (champion.start !== candidate.start) {
    throw new Error(
      `Arms start at different deals: ${champion.start} and ${candidate.start}.`,
    );
  }
  if (champion.winsB.length !== candidate.winsB.length) {
    throw new Error(
      `Arms cover ${champion.winsB.length} and ${candidate.winsB.length} deals.`,
    );
  }
  const differences: number[] = [];
  for (let index = 0; index < champion.winsB.length; index += 1) {
    const base = champion.winsB[index] ?? 0;
    const cand = candidate.winsB[index] ?? 0;
    differences.push((cand - base) / 3);
  }
  return Object.freeze(differences);
}

/** The identity a stage's result is filed under, for the archive. */
export function armResultHash(result: FarmerArmResult): string {
  return stableHash({
    arm: result.arm,
    start: result.start,
    winsB: result.winsB,
    winsA: result.winsA,
  });
}
