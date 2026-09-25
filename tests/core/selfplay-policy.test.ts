import { describe, expect, it } from "vitest";

import { SEAT_ORDER, type Seat } from "../../src/core/game/index.js";
import { generateLegalActions } from "../../src/core/rules/index.js";
import { parseTreeModel, type TreeModel } from "../../src/core/ai/cf-model.js";
import {
  DEFAULT_MIXTURE_WEIGHTS,
  MIXTURE_VERSION,
  argmaxAction,
  assertMixtureWellFormed,
  createTierBundle,
  drawOpponents,
  keyedOpponentRandom,
  roleOfSeat,
  scenarioGameSeed,
  scenarioSpec,
  seatForRole,
  scoreLegalActions,
  type MixtureSpec,
} from "../../benchmarks/selfplay-policy.js";
import {
  SELFPLAY_FEATURE_COUNT,
  SELFPLAY_FEATURE_NAMES,
} from "../../benchmarks/selfplay-features.js";
import { dealDeck, startWithLandlord } from "../../benchmarks/ai-tournament.js";
import { createPlayerView, DEFAULT_AI_STRATEGY, type AiDecisionContext } from "../../src/core/ai/index.js";
import { transition, type GameState } from "../../src/core/game/index.js";

type PlayDecisionContext = Extract<AiDecisionContext, { kind: "play" }>;

/** A one-leaf model: every action scores the same, so every tie is a real tie. */
function constantModel(value: number): TreeModel {
  return parseTreeModel({
    formatVersion: 1,
    lightgbmVersion: "test",
    modelSha256: "test",
    numTrees: 1,
    numFeatures: SELFPLAY_FEATURE_COUNT,
    featureNames: [...SELFPLAY_FEATURE_NAMES],
    trees: [
      {
        feature: [-1],
        threshold: [0],
        defaultLeft: [0],
        missingZero: [0],
        left: [0],
        right: [0],
        value: [value],
      },
    ],
  });
}

/** A stump that splits on one feature column, so scores depend on the action. */
function stumpOn(featureIndex: number, threshold: number, low: number, high: number): TreeModel {
  return parseTreeModel({
    formatVersion: 1,
    lightgbmVersion: "test",
    modelSha256: "test",
    numTrees: 1,
    numFeatures: SELFPLAY_FEATURE_COUNT,
    featureNames: [...SELFPLAY_FEATURE_NAMES],
    trees: [
      {
        feature: [featureIndex, -1, -1],
        threshold: [threshold, 0, 0],
        defaultLeft: [1, 0, 0],
        missingZero: [0, 0, 0],
        left: [1, 0, 0],
        right: [2, 0, 0],
        value: [0, low, high],
      },
    ],
  });
}

function playContext(state: GameState, seat: Seat): PlayDecisionContext {
  const view = createPlayerView(state, seat);
  if (view === null || view.phase === "bidding") {
    throw new Error("Fixture expected a playing view.");
  }
  return Object.freeze({
    kind: "play",
    view,
    legalActions: generateLegalActions({ hand: view.hand, currentPlay: view.currentPlay }),
  });
}

/**
 * A real decision context, walking `plies` moves with the shipped default. The
 * landmark tests need a root with enough legal actions for "no truncation" and
 * "the choice depends on the action" to mean anything, so this scans forward to
 * the first ply whose legal set is wide enough.
 */
function seatToMove(state: GameState): Seat {
  if (state.phase !== "playing" && state.phase !== "ready-to-play") {
    throw new Error(`Fixture expected a playable state, saw ${state.phase}.`);
  }
  return state.currentSeat;
}

function wideContextAt(
  dealSeed: number,
  landlord: Seat,
  seat: Seat,
  minimumActions: number,
  responding = false,
): PlayDecisionContext {
  let state = startWithLandlord(dealDeck(dealSeed), landlord);
  for (let ply = 0; ply < 200; ply += 1) {
    if (state.phase === "finished") {
      break;
    }
    if (seatToMove(state) === seat) {
      const context = playContext(state, seat);
      if (
        context.legalActions.length >= minimumActions &&
        (!responding || context.view.currentPlay !== null)
      ) {
        return context;
      }
    }
    const result = transition(state, DEFAULT_AI_STRATEGY.chooseCommand(playContext(state, seatToMove(state))));
    if (!result.ok) {
      throw new Error(`Fixture played an illegal command: ${result.error.code}.`);
    }
    state = result.state;
  }
  throw new Error(`No decision with ${minimumActions} legal actions was reached.`);
}

function contextAt(dealSeed: number, landlord: Seat, plies: number): PlayDecisionContext {
  let state = startWithLandlord(dealDeck(dealSeed), landlord);
  for (let ply = 0; ply < plies; ply += 1) {
    const mover = seatToMove(state);
    const result = transition(state, DEFAULT_AI_STRATEGY.chooseCommand(playContext(state, mover)));
    if (!result.ok) {
      throw new Error(`Fixture played an illegal command: ${result.error.code}.`);
    }
    state = result.state;
    if (state.phase === "finished") {
      break;
    }
  }
  return playContext(state, seatToMove(state));
}

describe("role and scenario mapping", () => {
  it("names each seat's role from its distance to the landlord", () => {
    expect(roleOfSeat("ai-one", "ai-one")).toBe("landlord");
    // Seat order is human -> ai-one -> ai-two, so with ai-one as landlord the
    // human plays *before* him (上家) and ai-two plays after (下家).
    expect(roleOfSeat("ai-two", "ai-one")).toBe("farmer-next");
    expect(roleOfSeat("human", "ai-one")).toBe("farmer-previous");
    for (const landlord of SEAT_ORDER) {
      expect(seatForRole(landlord, "landlord")).toBe(landlord);
      expect(roleOfSeat(seatForRole(landlord, "farmer-next"), landlord)).toBe("farmer-next");
      expect(roleOfSeat(seatForRole(landlord, "farmer-previous"), landlord)).toBe("farmer-previous");
    }
  });

  it("rotates one learning seat across three roles and three landlords per group", () => {
    for (let dealIndex = 0; dealIndex < 9; dealIndex += 1) {
      const specs = (["L", "F-next", "F-prev"] as const).map((scenario) =>
        scenarioSpec(dealIndex, scenario),
      );
      expect(new Set(specs.map((spec) => spec.learningSeat)).size).toBe(1);
      expect(new Set(specs.map((spec) => spec.landlord))).toEqual(new Set(SEAT_ORDER));
      expect(specs.map((spec) => spec.role).sort()).toEqual(
        ["farmer-next", "farmer-previous", "landlord"].sort(),
      );
      expect(specs[0]!.landlord).toBe(specs[0]!.learningSeat);
    }
  });

  it("derives a distinct game seed per scenario", () => {
    const seeds = (["L", "F-next", "F-prev"] as const).map((scenario) =>
      scenarioGameSeed(5001, scenarioSpec(5001, scenario)),
    );
    expect(new Set(seeds).size).toBe(3);
    expect(scenarioGameSeed(5001, scenarioSpec(5001, "L"))).toBe(
      scenarioGameSeed(5001, scenarioSpec(5001, "L")),
    );
  });
});

describe("the canonical tie-break", () => {
  it("takes the highest score and breaks ties by earliest position", () => {
    expect(argmaxAction([1, 2, 3])).toBe(2);
    expect(argmaxAction([3, 3, 3])).toBe(0);
    expect(argmaxAction([0, 5, 5, 1])).toBe(1);
    expect(argmaxAction([Number.NaN, 0.5])).toBe(0);
  });

  it("never resolves a tie to pass, because pass sorts last", () => {
    const context = contextAt(5002, "human", 3);
    const passIndex = context.legalActions.findIndex((action) => action.type === "pass");
    if (passIndex < 0) {
      return;
    }
    expect(passIndex).toBe(context.legalActions.length - 1);
    const scores = context.legalActions.map(() => 0.25);
    expect(passIndex).not.toBe(argmaxAction(scores));
  });

  it("is stable across calls for a real state", () => {
    const context = contextAt(5003, "ai-two", 5);
    const scores = context.legalActions.map((_, index) => (index * 7919) % 13);
    expect(argmaxAction(scores)).toBe(argmaxAction([...scores]));
  });
});

describe("the opponent mixture", () => {
  const spec: MixtureSpec = Object.freeze({
    version: MIXTURE_VERSION,
    current: "A",
    history: Object.freeze(["B", "C"]),
    weights: DEFAULT_MIXTURE_WEIGHTS,
  });

  it("draws the same opponents for the same key and different ones across keys", () => {
    const first = drawOpponents(spec, 7, 5001, 0);
    expect(drawOpponents(spec, 7, 5001, 0)).toEqual(first);
    const draws = new Set(
      Array.from({ length: 200 }, (_, index) =>
        JSON.stringify(drawOpponents(spec, 7, 5001, index % 3)),
      ),
    );
    expect(draws.size).toBeGreaterThan(1);
  });

  it("puts most of its mass on the current bundle and never draws outside the pool", () => {
    const random = keyedOpponentRandom(11, 1, 1);
    const counts = new Map<string, number>();
    for (let index = 0; index < 4000; index += 1) {
      const draw = drawOpponents(spec, 11, index, 1);
      expect(["A", "B", "C"]).toContain(draw.bundleA);
      expect(["A", "B", "C"]).toContain(draw.bundleB);
      counts.set(draw.arm, (counts.get(draw.arm) ?? 0) + 1);
      void random;
    }
    const current = (counts.get("current") ?? 0) / 4000;
    expect(current).toBeGreaterThan(0.45);
    expect(current).toBeLessThan(0.55);
    expect((counts.get("shared-history") ?? 0) / 4000).toBeGreaterThan(0.2);
    expect((counts.get("independent-history") ?? 0) / 4000).toBeGreaterThan(0.2);
  });

  it("refuses a pool that lists the current bundle, or a duplicate", () => {
    expect(() =>
      assertMixtureWellFormed({ ...spec, history: Object.freeze(["A", "B"]) }),
    ).toThrow(/both arms/);
    expect(() =>
      assertMixtureWellFormed({ ...spec, history: Object.freeze(["B", "B"]) }),
    ).toThrow(/duplicate/);
    expect(() =>
      assertMixtureWellFormed({
        ...spec,
        weights: { current: 0.5, sharedHistory: 0.5, independentHistory: 0.5 },
      }),
    ).toThrow(/sum to 1/);
    expect(() => assertMixtureWellFormed(spec)).not.toThrow();
  });
});

describe("full-action scoring", () => {
  it("scores every legal action, in the enumerator's own order, with no truncation", () => {
    const context = wideContextAt(5004, "human", "ai-one", 12);
    const scored = scoreLegalActions(context.view, constantModel(0.5), context.legalActions);
    expect(scored.actions).toHaveLength(context.legalActions.length);
    expect(scored.scores).toHaveLength(context.legalActions.length);
    expect(scored.actions.length).toBeGreaterThan(3);
  });

  it("makes the choice depend on the action, not only on the state", () => {
    // A flat model ties everywhere and the tie-break takes index 0. A model that
    // scores `pass` highly must move the choice to the pass, which sorts last —
    // so the two choices differ, and the difference can only come from a column
    // that describes the action.
    const passColumn = SELFPLAY_FEATURE_NAMES.indexOf("act_isPass");
    let checked = 0;

    for (let dealSeed = 5001; dealSeed < 5060 && checked < 3; dealSeed += 1) {
      for (const landlord of SEAT_ORDER) {
        for (const seat of SEAT_ORDER) {
          let context: PlayDecisionContext;
          try {
            context = wideContextAt(dealSeed, landlord, seat, 8, true);
          } catch {
            continue;
          }
          const passIndex = context.legalActions.findIndex((action) => action.type === "pass");
          if (passIndex <= 0) {
            continue;
          }
          const flat = scoreLegalActions(context.view, constantModel(1), context.legalActions);
          expect(new Set(flat.scores).size).toBe(1);
          expect(flat.chosenIndex).toBe(0);

          const split = scoreLegalActions(
            context.view,
            stumpOn(passColumn, 0.5, -9, 9),
            context.legalActions,
          );
          expect(split.chosenIndex).toBe(passIndex);
          expect(split.scores[passIndex]).toBeGreaterThan(split.scores[0]!);
          checked += 1;
        }
      }
    }

    expect(checked).toBeGreaterThan(0);
  });

  it("never returns an action outside the legal set, across many real states", () => {
    const bundle = createTierBundle("P0-rehearsal", "casual");
    let checked = 0;
    for (const landlord of SEAT_ORDER) {
      for (const seat of SEAT_ORDER) {
        const context = wideContextAt(5006, landlord, seat, 1);
        const role = roleOfSeat(context.view.seat, context.view.landlord);
        const chosen = bundle.roles[role]({
          context,
          seat: context.view.seat,
          role,
          dealSeed: 5006,
          gameSeed: 500_601,
          decisionIndex: 0,
        });
        const key = chosen.type === "pass" ? "pass" : chosen.play.cards.join(",");
        const legal = new Set(
          context.legalActions.map((action) =>
            action.type === "pass" ? "pass" : action.play.cards.join(","),
          ),
        );
        expect(legal.has(key), `${landlord}/${seat}`).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBe(9);
  });
});

describe("tie and near-tie behaviour", () => {
  it("resolves an exact tie to the earliest canonical position, deterministically", () => {
    const context = wideContextAt(5007, "human", "human", 8);
    const flat = constantModel(0.5);
    const scored = scoreLegalActions(context.view, flat, context.legalActions);
    expect(new Set(scored.scores).size).toBe(1);
    expect(scored.chosenIndex).toBe(0);
    // The same rule, applied twice, is the same answer — ties are not luck.
    expect(scoreLegalActions(context.view, flat, context.legalActions).chosenIndex).toBe(0);
  });

  it("breaks a near-tie by the score, not by the position", () => {
    // A stump whose two leaves differ by 1e-9: far below any practical
    // precision, but strictly ordered, so the larger score must win even when it
    // sits at a later position than its rival.
    const passColumn = SELFPLAY_FEATURE_NAMES.indexOf("act_isPass");
    let context: PlayDecisionContext | null = null;
    for (let seed = 5001; seed < 5060 && context === null; seed += 1) {
      for (const landlord of SEAT_ORDER) {
        try {
          const candidate = wideContextAt(seed, landlord, "human", 8, true);
          if (candidate.legalActions.findIndex((action) => action.type === "pass") > 0) {
            context = candidate;
            break;
          }
        } catch {
          continue;
        }
      }
    }
    if (context === null) {
      throw new Error("No responding root with a pass was found.");
    }
    const passIndex = context.legalActions.findIndex((action) => action.type === "pass");
    const near = scoreLegalActions(context.view, stumpOn(passColumn, 0.5, 0, 1e-9), context.legalActions);
    expect(near.scores[passIndex]).toBeGreaterThan(near.scores[0]!);
    expect(near.chosenIndex).toBe(passIndex);
    expect(near.chosenIndex).not.toBe(0);
  });
});
