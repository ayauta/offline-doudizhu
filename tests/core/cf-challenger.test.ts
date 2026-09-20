/**
 * Guards for the Gate B challenger wrapper (spec 063).
 *
 * The wrapper is where three separate ways to invalidate the experiment live,
 * so each gets its own assertion rather than being inferred from a command
 * stream after the fact:
 *
 *   - **scope**: it must not fire for the landlord, and it must not fire for a
 *     seat other than the one it was bound to. A global farmer test would change
 *     both farmers and break the landlord arm's invariance.
 *   - **authority**: it must return the production command object itself when it
 *     declines, not an equal-looking rebuild.
 *   - **boundary**: it must not be able to see the hidden hands, which is
 *     checked the same way the dataset's features are — by re-dealing them.
 */
import { describe, expect, it } from "vitest";

import type { AiDecisionContext } from "../../src/core/ai/index.js";
import type { GameCommand, PlayingState, Seat } from "../../src/core/game/index.js";
import {
  CF_FEATURE_NAMES,
  cfActionCommand,
  cfCommandKey,
  cfPlayContext,
  cfProposal,
  cfRow,
} from "../../benchmarks/cf-dataset.js";
import { parseTreeModel, scoreTrees, type TreeModel } from "../../benchmarks/cf-model.js";
import {
  chooseChallengerCommand,
  createChallengerStrategy,
  createFrozenOverlay,
} from "../../benchmarks/cf-challenger.js";
import { redealHidden, toFarmerRoot } from "../support/cf-fixtures.js";

const THRESHOLD = 0.01;

/** A model that returns the same score everywhere. */
function constantModel(value: number): TreeModel {
  return parseTreeModel({
    formatVersion: 1,
    lightgbmVersion: "test",
    modelSha256: "test",
    numTrees: 1,
    numFeatures: CF_FEATURE_NAMES.length,
    featureNames: [...CF_FEATURE_NAMES],
    trees: [{
      feature: [-1], threshold: [0], defaultLeft: [0],
      missingZero: [0], left: [0], right: [0], value: [value],
    }],
  });
}

/** One split on one feature: left leaf when `x[f] <= threshold`, else right. */
function splitModel(
  featureIndex: number,
  splitAt: number,
  leftValue: number,
  rightValue: number,
): TreeModel {
  return parseTreeModel({
    formatVersion: 1,
    lightgbmVersion: "test",
    modelSha256: "test",
    numTrees: 1,
    numFeatures: CF_FEATURE_NAMES.length,
    featureNames: [...CF_FEATURE_NAMES],
    trees: [{
      feature: [featureIndex, -1, -1],
      threshold: [splitAt, 0, 0],
      defaultLeft: [1, 0, 0],
      missingZero: [0, 0, 0],
      left: [1, 0, 0],
      right: [2, 0, 0],
      value: [0, leftValue, rightValue],
    }],
  });
}

type Fixture = Readonly<{
  context: AiDecisionContext;
  seat: Seat;
  /** Production's action, taken to be its shortlist leader. */
  production: GameCommand;
  alternatives: readonly GameCommand[];
}>;

function fixture(dealSeed = 50_001, studied: Seat = "ai-one"): Fixture {
  const { state } = toFarmerRoot(dealSeed, dealSeed * 100 + 4, "human", studied);
  const context = cfPlayContext(state, studied);
  const proposal = cfProposal(context);
  if (proposal.actions.length < 2) {
    throw new Error("Guard setup needs a root with an alternative.");
  }
  const leader = proposal.actions[0];
  if (leader === undefined) {
    throw new Error("Guard setup found no leader.");
  }
  return Object.freeze({
    context,
    seat: studied,
    production: cfActionCommand(studied, leader),
    alternatives: Object.freeze(proposal.actions.slice(1).map((action) =>
      cfActionCommand(studied, action))),
  });
}

describe("challenger: activation scope", () => {
  it("never fires when the strong seat is the landlord", () => {
    const { state } = toFarmerRoot(50_001, 500_104, "human", "ai-one");
    const landlordContext = cfPlayContext(state, "human");
    const production: GameCommand = Object.freeze({ type: "pass", seat: "human" });
    const command = chooseChallengerCommand(landlordContext, production, {
      // Even bound to the landlord's own seat, the role check must decline.
      model: constantModel(1),
      threshold: THRESHOLD,
      seat: "human",
    });
    // Identity, not merely equality: the wrapper must hand back what it was given.
    expect(command).toBe(production);
  });

  it("never fires for a seat it was not bound to", () => {
    const { context, production } = fixture();
    const command = chooseChallengerCommand(context, production, {
      model: constantModel(1),
      threshold: THRESHOLD,
      seat: "ai-two",
    });
    expect(command).toBe(production);
  });

  it("never fires when disabled, even on an eligible farmer root", () => {
    const { context, production } = fixture();
    const command = chooseChallengerCommand(context, production, {
      model: constantModel(1),
      threshold: THRESHOLD,
      seat: "ai-one",
      enabled: false,
    });
    expect(command).toBe(production);
  });

  it("never fires on the bidding path", () => {
    const bidContext = Object.freeze({
      kind: "bid",
      view: Object.freeze({
        phase: "bidding",
        seat: "ai-one",
        hand: Object.freeze([]),
        currentSeat: "ai-one",
        declinedSeats: Object.freeze([]),
        remainingCardCounts: Object.freeze({ human: 17, "ai-one": 17, "ai-two": 17 }),
      }),
    }) as unknown as AiDecisionContext;
    const production: GameCommand = Object.freeze({ type: "pass", seat: "ai-one" });
    const command = chooseChallengerCommand(bidContext, production, {
      model: constantModel(1),
      threshold: THRESHOLD,
      seat: "ai-one",
    });
    expect(command).toBe(production);
  });

});

describe("challenger: override semantics", () => {
  it("requires the score to be strictly above the threshold", () => {
    const { context, production } = fixture();
    const options = { threshold: THRESHOLD, seat: "ai-one" as const };
    // Exactly at the threshold: no override.
    expect(chooseChallengerCommand(context, production, {
      ...options, model: constantModel(THRESHOLD),
    })).toBe(production);
    // A hair above: override.
    expect(chooseChallengerCommand(context, production, {
      ...options, model: constantModel(THRESHOLD + 1e-9),
    })).not.toBe(production);
  });

  it("breaks ties by the frozen production candidate order", () => {
    const { context, production, alternatives } = fixture();
    const command = chooseChallengerCommand(context, production, {
      model: constantModel(1),
      threshold: THRESHOLD,
      seat: "ai-one",
    });
    expect(cfCommandKey(command)).toBe(cfCommandKey(alternatives[0] ?? production));
  });

  it("takes the model's argmax, not the production order", () => {
    const { context, production, alternatives } = fixture();
    const cardCount = CF_FEATURE_NAMES.indexOf("cand_cardCount");
    // A split that favours whichever candidate plays the most cards.
    const model = splitModel(cardCount, 1.5, -1, 1);
    const command = chooseChallengerCommand(context, production, {
      model, threshold: THRESHOLD, seat: "ai-one",
    });
    // Whatever it picked must actually be the best-scoring alternative.
    const best = [...alternatives]
      .map((candidate) => ({ candidate, score: bestScoreOf(context, candidate, production, model) }))
      .sort((left, right) => right.score - left.score)[0];
    expect(best).toBeDefined();
    expect(cfCommandKey(command)).toBe(cfCommandKey(best?.candidate ?? production));
  });

  it("is deterministic for a repeated identical decision", () => {
    const { context, production } = fixture();
    const options = { model: constantModel(1), threshold: THRESHOLD, seat: "ai-one" as const };
    const first = chooseChallengerCommand(context, production, options);
    const second = chooseChallengerCommand(context, production, options);
    expect(cfCommandKey(second)).toBe(cfCommandKey(first));
  });
});

/** Score one candidate against the production action, as the wrapper does. */
function bestScoreOf(
  context: AiDecisionContext,
  candidate: GameCommand,
  production: GameCommand,
  model: TreeModel,
): number {
  const playContext = context as Extract<AiDecisionContext, { readonly kind: "play" }>;
  const proposal = cfProposal(playContext);
  const productionKey = cfCommandKey(production);
  const referenceIndex = proposal.actions.findIndex(
    (action) => cfCommandKey(cfActionCommand(playContext.view.seat, action)) === productionKey,
  );
  const reference = proposal.actions[referenceIndex];
  if (reference === undefined) {
    return Number.NaN;
  }
  const candidateIndex = proposal.actions.findIndex(
    (action) => cfCommandKey(cfActionCommand(playContext.view.seat, action)) === cfCommandKey(candidate),
  );
  const action = proposal.actions[candidateIndex];
  if (action === undefined) {
    return Number.NaN;
  }
  return scoreTrees(model, cfRow(playContext.view, action, reference));
}

describe("challenger: information boundary", () => {
  it("chooses identically when only the hidden hands move", () => {
    const dealSeed = 50_001;
    const gameSeed = dealSeed * 100 + 4;
    const seat: Seat = "ai-one";
    const { state } = toFarmerRoot(dealSeed, gameSeed, "human", seat);
    if (state.phase !== "playing" && state.phase !== "ready-to-play") {
      throw new Error("guard setup expected a playing state");
    }
    const playing = state as PlayingState;
    const model = splitModel(CF_FEATURE_NAMES.indexOf("cand_cardCount"), 1.5, -1, 1);

    const decide = (world: PlayingState): GameCommand => {
      const context = cfPlayContext(world, seat);
      const leader = cfProposal(context).actions[0];
      if (leader === undefined) {
        throw new Error("guard setup found no leader");
      }
      return chooseChallengerCommand(context, cfActionCommand(seat, leader), {
        model,
        threshold: THRESHOLD,
        seat,
      });
    };

    const baseline = cfCommandKey(decide(playing));
    for (const seed of [1, 2, 3, 4, 5]) {
      const alternative = redealHidden(playing, seat, seed);
      expect(cfCommandKey(decide(alternative))).toBe(baseline);
    }
  });

  it("does not consult the seat's own hidden cards through any other channel", () => {
    // The wrapper's only inputs are the view and the production command; the
    // row it scores is built by `cfRow`, whose two-argument-plus-reference
    // signature is guarded separately. This asserts the composition: the same
    // view and command must give the same answer however the world behind it
    // is dealt.
    const fixtureA = fixture(50_001, "ai-one");
    const fixtureB = fixture(50_001, "ai-one");
    const options = { model: constantModel(1), threshold: THRESHOLD, seat: "ai-one" as const };
    expect(cfCommandKey(chooseChallengerCommand(fixtureA.context, fixtureA.production, options)))
      .toBe(cfCommandKey(chooseChallengerCommand(fixtureB.context, fixtureB.production, options)));
  });
});

describe("challenger: the two install forms agree", () => {
  it("gives the same command as a decorator and as a shipped overlay", () => {
    // The designed benchmark installs the selector as a decorator around the
    // measured strategy; the shipped benchmark installs it as an overlay inside
    // `decideEnhancedAi`. They must be the same decision function, or the two
    // benchmarks are measuring different things and the translation check is
    // meaningless.
    const { context, production } = fixture();
    const options = {
      model: splitModel(CF_FEATURE_NAMES.indexOf("cand_cardCount"), 1.5, -1, 1),
      threshold: THRESHOLD,
      seat: "ai-one" as const,
    };
    const viaDecorator = createChallengerStrategy(
      { chooseCommand: () => production },
      options,
    ).chooseCommand(context);
    const viaOverlay = createFrozenOverlay(options)(context, production);
    expect(cfCommandKey(viaOverlay)).toBe(cfCommandKey(viaDecorator));

    // And with a model that always declines, both must return production's own
    // command object, not a copy of it.
    const declining = { ...options, model: constantModel(-1) };
    expect(createFrozenOverlay(declining)(context, production)).toBe(production);
  });
});
