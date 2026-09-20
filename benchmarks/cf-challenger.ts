/**
 * Benchmark-side wrapper around the frozen selector.
 *
 * The decision itself lives in `src/app/ai/cf-selector.ts` and is shared with
 * the shipped Worker; this file only adds the instrumentation the experiments
 * report and adapts it to the two install forms the harness supports — a
 * decorator around the measured strategy (designed runs) and an overlay inside
 * the shipped handler (shipped runs).
 *
 * Keeping the wrapper this thin is the point: it is the only place the two
 * benchmarks and the product could diverge, so there is as little of it as
 * possible.
 */
import type { AiDecisionContext, AiStrategy } from "../src/core/ai/index.js";
import type { GameCommand, Seat } from "../src/core/game/index.js";
import {
  cfSelectFarmerAction,
  type FarmerSelectorOptions,
  type SelectorEvent,
} from "../src/app/ai/cf-selector.js";
import type { TreeModel } from "../src/core/ai/cf-model.js";

export type { SelectorEvent };

export type SelectorRecord = Readonly<{
  /** Production candidate order of the chosen candidate; -1 when declining. */
  rank: number;
  overrode: boolean;
  score: number;
  /** Distance of the winning score above the threshold; negative when declined. */
  margin: number;
  farmerPosition: number;
  minRemaining: number;
}>;

export type SelectorStats = {
  decisions: number;
  eligible: number;
  overrides: number;
  featureMs: number;
  inferenceMs: number;
  proposalMs: number;
  chosenRank: Map<number, number>;
  scores: number[];
  records: SelectorRecord[];
};

export function createSelectorStats(): SelectorStats {
  return {
    decisions: 0,
    eligible: 0,
    overrides: 0,
    featureMs: 0,
    inferenceMs: 0,
    proposalMs: 0,
    chosenRank: new Map(),
    scores: [],
    records: [],
  };
}

export type ChallengerOptions = Readonly<{
  model: TreeModel;
  threshold: number;
  seat: Seat;
  stats?: SelectorStats;
  enabled?: boolean;
}>;

function observerFor(stats: SelectorStats | undefined): ((event: SelectorEvent) => void) | undefined {
  if (stats === undefined) {
    return undefined;
  }
  return (event) => {
    stats.decisions += 1;
    stats.proposalMs += event.proposalMs;
    if (!event.eligible) {
      return;
    }
    stats.eligible += 1;
    stats.featureMs += event.featureMs;
    stats.inferenceMs += event.inferenceMs;
    stats.scores.push(event.score);
    if (event.overrode) {
      stats.overrides += 1;
      stats.chosenRank.set(event.rank, (stats.chosenRank.get(event.rank) ?? 0) + 1);
    }
    stats.records.push(Object.freeze({
      rank: event.overrode ? event.rank : -1,
      overrode: event.overrode,
      score: event.score,
      margin: event.score - event.threshold,
      farmerPosition: event.farmerPosition,
      minRemaining: event.minRemaining,
    }));
  };
}

function optionsFor(options: ChallengerOptions): FarmerSelectorOptions {
  const observe = observerFor(options.stats);
  return {
    model: options.model,
    threshold: options.threshold,
    seat: options.seat,
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    ...(observe === undefined ? {} : { observe }),
  };
}

export function chooseChallengerCommand(
  context: AiDecisionContext,
  productionCommand: GameCommand,
  options: ChallengerOptions,
): GameCommand {
  return cfSelectFarmerAction(context, productionCommand, optionsFor(options));
}

/** The selector in the form the shipped handler consumes. */
export function createFrozenOverlay(options: ChallengerOptions): (
  context: AiDecisionContext,
  productionCommand: GameCommand,
) => GameCommand {
  const resolved = optionsFor(options);
  return (context, productionCommand) =>
    cfSelectFarmerAction(context, productionCommand, resolved);
}

/** Wraps one seat's production strategy with the frozen selector. */
export function createChallengerStrategy(
  production: AiStrategy,
  options: ChallengerOptions,
): AiStrategy {
  const resolved = optionsFor(options);
  return Object.freeze({
    chooseCommand(context: AiDecisionContext): GameCommand {
      const command = production.chooseCommand(context);
      return cfSelectFarmerAction(context, command, resolved);
    },
  });
}
