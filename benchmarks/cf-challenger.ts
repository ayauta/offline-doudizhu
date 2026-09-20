/**
 * The Gate B challenger: production master, plus a frozen counterfactual
 * override at farmer roots.
 *
 * Two properties this file exists to enforce, because both are easy to get
 * wrong in a way that silently invalidates the experiment:
 *
 *   1. **Identity-scoped activation.** The selector is installed by decorating
 *      exactly one seat's strategy, so it never fires for the other farmer. A
 *      global `if (seat !== landlord)` test would change both farmers and make
 *      the landlord arm non-invariant for reasons that have nothing to do with
 *      the strong agent's strength.
 *
 *   2. **The model has real authority.** The score replaces the choice; it is
 *      never blended back into `expertScore`. `expertScore` continues to do the
 *      only job it has ever had here — propose the shortlist.
 *
 * Everything else is the production path, untouched: the same master decision
 * produces `a0`, the same shortlist supplies the alternatives, and when the
 * selector declines, the command handed back is the very object the production
 * strategy returned.
 */
import type { AiDecisionContext, AiStrategy } from "../src/core/ai/index.js";
import type { GameCommand } from "../src/core/game/index.js";

import { cfActionCommand, cfCommandKey, cfProposal, cfRow } from "./cf-dataset.js";
import { scoreTrees, type TreeModel } from "./cf-model.js";

export type SelectorRecord = Readonly<{
  /** Production candidate order of the chosen candidate; -1 when declining. */
  rank: number;
  overrode: boolean;
  score: number;
  /** Distance of the winning score above the threshold; negative when declined. */
  margin: number;
  /** The acting seat's distance from the landlord, 1 or 2. */
  farmerPosition: number;
  /** Cards left for the player closest to going out. */
  minRemaining: number;
}>;

export type SelectorStats = {
  decisions: number;
  eligible: number;
  overrides: number;
  featureMs: number;
  inferenceMs: number;
  /** Candidate rank chosen, counted by production candidate order. */
  chosenRank: Map<number, number>;
  /** The score the selector saw at the moment it decided. */
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
    chosenRank: new Map(),
    scores: [],
    records: [],
  };
}

export type ChallengerOptions = Readonly<{
  model: TreeModel;
  threshold: number;
  /**
   * The seat this challenger occupies. Bound at construction so that activation
   * cannot be forgotten at a call site.
   */
  seat: string;
  stats?: SelectorStats;
  /** Set false to make the wrapper a pure pass-through (baseline arm). */
  enabled?: boolean;
}>;

type PlayContext = Extract<AiDecisionContext, { readonly kind: "play" }>;

/**
 * The override decision, as a pure function of the visible context and the
 * production command. Exported so it can be unit-tested without a game, and so
 * the activation rules can be asserted directly rather than inferred from
 * command streams.
 */
export function chooseChallengerCommand(
  context: AiDecisionContext,
  productionCommand: GameCommand,
  options: ChallengerOptions,
): GameCommand {
  const stats = options.stats;
  if (options.enabled === false) {
    return productionCommand;
  }
  if (context.kind !== "play") {
    return productionCommand;
  }
  const view = context.view;
  // Role check. The identity check already happened when the decorator was
  // bound to this seat; this is the other half of the same condition.
  if (view.seat !== options.seat || view.seat === view.landlord) {
    return productionCommand;
  }

  if (stats !== undefined) {
    stats.decisions += 1;
  }

  const playContext = context as PlayContext;
  const proposal = cfProposal(playContext);
  if (proposal.actions.length < 2) {
    return productionCommand;
  }
  const productionKey = cfCommandKey(productionCommand);
  const productionIndex = proposal.actions.findIndex(
    (action) => cfCommandKey(cfActionCommand(view.seat, action)) === productionKey,
  );
  if (productionIndex < 0) {
    // Production's action is not among its own shortlist. That cannot happen on
    // the shipped path, and guessing here would be worse than declining.
    return productionCommand;
  }
  const reference = proposal.actions[productionIndex];
  if (reference === undefined) {
    return productionCommand;
  }

  if (stats !== undefined) {
    stats.eligible += 1;
  }

  let bestIndex = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < proposal.actions.length; index += 1) {
    if (index === productionIndex) {
      continue;
    }
    const action = proposal.actions[index];
    if (action === undefined) {
      continue;
    }
    const featureStart = performance.now();
    const row = cfRow(view, action, reference);
    const inferStart = performance.now();
    const score = scoreTrees(options.model, row);
    const end = performance.now();
    if (stats !== undefined) {
      stats.featureMs += inferStart - featureStart;
      stats.inferenceMs += end - inferStart;
    }
    // Strict `>` keeps the first maximum, which — because the candidates arrive
    // in production candidate order — is the frozen tie-break.
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  if (stats !== undefined) {
    stats.scores.push(bestScore);
  }
  if (bestIndex < 0 || !(bestScore > options.threshold)) {
    if (stats !== undefined) {
      stats.records.push(Object.freeze({
        rank: -1,
        overrode: false,
        score: bestScore,
        margin: bestScore - options.threshold,
        farmerPosition: (["human", "ai-one", "ai-two"].indexOf(view.seat) -
          ["human", "ai-one", "ai-two"].indexOf(view.landlord) + 3) % 3,
        minRemaining: Math.min(
          view.remainingCardCounts.human,
          view.remainingCardCounts["ai-one"],
          view.remainingCardCounts["ai-two"],
        ),
      }));
    }
    return productionCommand;
  }
  const chosen = proposal.actions[bestIndex];
  if (chosen === undefined) {
    return productionCommand;
  }
  if (stats !== undefined) {
    stats.overrides += 1;
    stats.chosenRank.set(bestIndex, (stats.chosenRank.get(bestIndex) ?? 0) + 1);
    stats.records.push(Object.freeze({
      rank: bestIndex,
      overrode: true,
      score: bestScore,
      margin: bestScore - options.threshold,
      farmerPosition: (["human", "ai-one", "ai-two"].indexOf(view.seat) -
        ["human", "ai-one", "ai-two"].indexOf(view.landlord) + 3) % 3,
      minRemaining: Math.min(
        view.remainingCardCounts.human,
        view.remainingCardCounts["ai-one"],
        view.remainingCardCounts["ai-two"],
      ),
    }));
  }
  return cfActionCommand(view.seat, chosen);
}

/** Wraps one seat's production strategy with the frozen selector. */
export function createChallengerStrategy(
  production: AiStrategy,
  options: ChallengerOptions,
): AiStrategy {
  return Object.freeze({
    chooseCommand(context: AiDecisionContext): GameCommand {
      const command = production.chooseCommand(context);
      return chooseChallengerCommand(context, command, options);
    },
  });
}
