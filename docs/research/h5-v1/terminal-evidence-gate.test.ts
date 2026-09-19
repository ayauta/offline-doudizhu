/**
 * H5 v1's frozen contract: only high-confidence terminal evidence gets more
 * rollout influence, and nothing else moves.
 *
 * The mechanism (docs/research/h5-terminal-evidence.md) raises a candidate's
 * *terminal* component from production's `ROLLOUT_BLEND_WEIGHT` to
 * `terminalGateWeight`, and only when every terminal trajectory that candidate
 * produced agrees on the root side's outcome. Two properties carry the whole
 * design and are what this file pins:
 *
 *   1. The form is **incremental**, so `terminalGateWeight = 0.2` adds exactly
 *      `+0` and the score is production's, bit for bit. A component-wise
 *      rewrite (`W×T + 0.2×N`) sums the same evidence in another order and
 *      lands on different last bits — these assertions would fail, which is the
 *      point of comparing bit patterns instead of magnitudes.
 *   2. The verdict is read from the **root seat's side**. 斗地主 has two sides,
 *      and the seat acting inside a rollout is not the seat whose decision this
 *      is; a "did the acting seat win" formulation inverts the sign at a farmer
 *      seat. The exhaustive table below is that trap, written out.
 *
 * Position-level legs (real contexts, real rollouts) sit at the end and assert
 * the gate is *not vacuous* — they fail if no candidate ever gates, because an
 * identity that only ever compares two never-taken branches proves nothing.
 */
import { describe, expect, it } from "vitest";

import {
  CASUAL_AI_STRATEGY,
  createPlayerView,
  type AiDecisionContext,
} from "../../src/core/ai/index.js";
import {
  ROLLOUT_BLEND_WEIGHT,
  rankMasterPlayActions,
  rolloutBlendedScore,
  terminalVerdict,
  type CandidateRollout,
  type TerminalVerdict,
} from "../../src/core/ai/enhanced.js";
import { createDeck, shuffle, type RandomSource } from "../../src/core/cards/index.js";
import {
  INITIAL_GAME_STATE,
  SEAT_ORDER,
  transition,
  type GameState,
  type Seat,
} from "../../src/core/game/index.js";
import { generateLegalActions } from "../../src/core/rules/index.js";

type PlayContext = Extract<AiDecisionContext, { readonly kind: "play" }>;

/** Shipped master sizing, so the position legs run the real search. */
const WORLD_COUNT = 8;
const ROLLOUT_DEPTH = 3;
const ROOT_ANALYZER_NODES = 220;
/** H5 v1's frozen W_gate: terminal utility at its original design scale. */
const GATE_WEIGHT = 1;
const TERMINAL_UTILITY = 10_000;

/** The exact 64 bits of a double, so "identical" cannot hide behind rounding. */
function bits(value: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0).toString(16);
}

function candidate(overrides: Partial<CandidateRollout> = {}): CandidateRollout {
  return {
    expertScore: 1234.5,
    total: 0,
    terminalTotal: 0,
    terminalWinners: [],
    ...overrides,
  };
}

function sameSide(seat: Seat, other: Seat, landlord: Seat): boolean {
  return seat === landlord ? other === landlord : other !== landlord;
}

/** Production's own expression, written out as the specification to match. */
function productionScore(
  expertScore: number,
  total: number,
  completedWorlds: number,
): number {
  return expertScore +
    (completedWorlds === 0 ? 0 : (total / completedWorlds) * ROLLOUT_BLEND_WEIGHT);
}

const LANDLORD_ROOT = Object.freeze({ seat: "ai-one" as Seat, landlord: "ai-one" as Seat });
const PEASANT_ROOT = Object.freeze({ seat: "ai-two" as Seat, landlord: "ai-one" as Seat });

describe("H5 v1: the confidence gate reads the root side", () => {
  it("classifies every root/landlord/winner combination by the root side, not the acting seat", () => {
    for (const rootSeat of SEAT_ORDER) {
      for (const landlord of SEAT_ORDER) {
        for (const winner of SEAT_ORDER) {
          const expected: TerminalVerdict = sameSide(rootSeat, winner, landlord) ? "win" : "loss";
          expect(
            terminalVerdict(rootSeat, landlord, [winner]),
            `root ${rootSeat}, landlord ${landlord}, winner ${winner}`,
          ).toBe(expected);
        }
      }
    }
  });

  it("inverts nothing at a farmer seat: the landlord losing is the peasants' win", () => {
    // Both farmers hold the same side, so a win by the *other* farmer is this
    // root's win, and a win by the landlord is this root's loss. A verdict
    // written as "the acting seat won" reverses both of these.
    expect(terminalVerdict("ai-two", "human", ["ai-one"])).toBe("win");
    expect(terminalVerdict("ai-two", "human", ["human"])).toBe("loss");
    expect(terminalVerdict("ai-two", "human", ["ai-two"])).toBe("win");
    // Landlord root, same seats, opposite reading.
    expect(terminalVerdict("human", "human", ["human"])).toBe("win");
    expect(terminalVerdict("human", "human", ["ai-one"])).toBe("loss");
  });

  it("closes the gate on no evidence, on disagreement, and on anything unattributable", () => {
    expect(terminalVerdict("ai-one", "ai-one", [])).toBe("none");
    expect(terminalVerdict("ai-one", "ai-one", ["ai-one", "ai-two"])).toBe("conflicting");
    expect(terminalVerdict("ai-one", "ai-one", ["ai-one", "ai-one", "ai-two"])).toBe("conflicting");
    // Two trajectories from the same side agree, however many there are.
    expect(terminalVerdict("ai-two", "human", ["ai-one", "ai-two", "ai-one"])).toBe("win");
    expect(terminalVerdict("ai-two", "human", ["human", "human"])).toBe("loss");
    // A terminal trajectory always names a winner; a null one cannot be
    // attributed to a side, and the freeze treats that as no evidence.
    expect(terminalVerdict("ai-one", "ai-one", [null])).toBe("conflicting");
    expect(terminalVerdict("ai-one", "ai-one", ["ai-one", null])).toBe("conflicting");
  });
});

describe("H5 v1: the frozen scoring form", () => {
  it("is production, bit for bit, with no gate weight configured", () => {
    const cases: readonly CandidateRollout[] = [
      candidate(),
      candidate({ total: 37_500, terminalTotal: 10_000, terminalWinners: ["ai-one"] }),
      candidate({ total: -12_345.678, terminalTotal: -20_000, terminalWinners: ["ai-two", "human"] }),
      candidate({ expertScore: -0, total: 0 }),
    ];
    for (const entry of cases) {
      for (const worlds of [0, 1, 3, 8]) {
        expect(bits(rolloutBlendedScore(entry, LANDLORD_ROOT, worlds, undefined)))
          .toBe(bits(productionScore(entry.expertScore, entry.total, worlds)));
      }
    }
  });

  it("is production, bit for bit, when the gate weight is production's own weight", () => {
    // The gate fires in every one of these; the added term is exactly +0, so
    // the identity holds on the branch that actually takes it.
    const cases: readonly CandidateRollout[] = [
      candidate({ terminalTotal: 10_000, terminalWinners: ["ai-one"] }),
      candidate({ terminalTotal: -30_000, terminalWinners: ["ai-two", "human", "ai-two"] }),
      candidate({ total: 888.25, terminalTotal: 10_000, terminalWinners: ["ai-one"] }),
      candidate({ expertScore: 0, total: -4_000, terminalTotal: -10_000, terminalWinners: ["human"] }),
    ];
    for (const entry of cases) {
      for (const root of [LANDLORD_ROOT, PEASANT_ROOT]) {
        for (const worlds of [1, 8]) {
          const gated = rolloutBlendedScore(entry, root, worlds, ROLLOUT_BLEND_WEIGHT);
          const production = rolloutBlendedScore(entry, root, worlds, undefined);
          expect(bits(gated)).toBe(bits(production));
          expect(bits(gated)).toBe(
            bits(productionScore(entry.expertScore, entry.total, worlds)),
          );
        }
      }
    }
  });

  it("leaves a candidate with no terminal evidence exactly where production left it", () => {
    const none = candidate({ total: 5_000, terminalTotal: 0, terminalWinners: [] });
    const base = rolloutBlendedScore(none, LANDLORD_ROOT, WORLD_COUNT, undefined);
    expect(bits(rolloutBlendedScore(none, LANDLORD_ROOT, WORLD_COUNT, GATE_WEIGHT)))
      .toBe(bits(base));
  });

  it("leaves a candidate whose terminal trajectories disagree exactly where production left it", () => {
    const conflicting: readonly CandidateRollout[] = [
      candidate({ total: 5_000, terminalTotal: 0, terminalWinners: ["ai-one", "ai-two"] }),
      // Disagreement whose terminal utilities do *not* cancel: the reason to
      // close the gate is the disagreement itself, not a zero sum. A gate
      // written as "add the terminal component whenever there is one" passes on
      // the balanced case and fails here.
      candidate({
        total: 5_000,
        terminalTotal: TERMINAL_UTILITY,
        terminalWinners: ["ai-one", "ai-two", "ai-one"],
      }),
      candidate({
        total: -5_000,
        terminalTotal: -TERMINAL_UTILITY,
        terminalWinners: ["ai-two", "ai-one", "human"],
      }),
    ];
    for (const entry of conflicting) {
      const base = rolloutBlendedScore(entry, LANDLORD_ROOT, WORLD_COUNT, undefined);
      expect(bits(rolloutBlendedScore(entry, LANDLORD_ROOT, WORLD_COUNT, GATE_WEIGHT)))
        .toBe(bits(base));
      // Identical verdict for the peasant root: the gate is about agreement,
      // not about which side the sampled worlds favoured.
      expect(bits(rolloutBlendedScore(entry, PEASANT_ROOT, WORLD_COUNT, GATE_WEIGHT)))
        .toBe(bits(rolloutBlendedScore(entry, PEASANT_ROOT, WORLD_COUNT, undefined)));
    }
  });

  it("adds only the terminal component when the evidence is unanimous", () => {
    const worlds = WORLD_COUNT;
    const terminalCount = 3;
    const win = candidate({
      total: 6_000,
      terminalTotal: terminalCount * TERMINAL_UTILITY,
      terminalWinners: ["ai-one", "ai-one", "ai-one"],
    });
    const loss = candidate({
      total: -6_000,
      terminalTotal: -terminalCount * TERMINAL_UTILITY,
      terminalWinners: ["ai-two", "human", "ai-two"],
    });
    for (const [entry, sign] of [[win, 1], [loss, -1]] as const) {
      const base = rolloutBlendedScore(entry, LANDLORD_ROOT, worlds, undefined);
      const gated = rolloutBlendedScore(entry, LANDLORD_ROOT, worlds, GATE_WEIGHT);
      const delta = gated - base;
      expect(Math.sign(delta)).toBe(sign);
      // Exactly the terminal component at its original scale — the whole
      // candidate's rollout is not what got re-weighted.
      expect(delta).toBe(
        sign * (GATE_WEIGHT - ROLLOUT_BLEND_WEIGHT) * (terminalCount * TERMINAL_UTILITY) / worlds,
      );
      // The non-terminal part of the same candidate is untouched. These values
      // are chosen so every division and product is exact: a changed
      // non-terminal total moves the increment by nothing at all.
      const otherTotal = candidate({ ...entry, total: entry.total + 2_000 });
      expect(
        rolloutBlendedScore(otherTotal, LANDLORD_ROOT, worlds, GATE_WEIGHT) -
        rolloutBlendedScore(otherTotal, LANDLORD_ROOT, worlds, undefined),
      ).toBe(delta);
      // And when the base is not exactly representable the sum rounds, so the
      // same statement can only hold to within that rounding — still orders of
      // magnitude tighter than any leak of the non-terminal term would be.
      const rounded = candidate({ ...entry, total: entry.total + 1_234, expertScore: 1234.5 });
      expect(
        Math.abs(
          (rolloutBlendedScore(rounded, LANDLORD_ROOT, worlds, GATE_WEIGHT) -
            rolloutBlendedScore(rounded, LANDLORD_ROOT, worlds, undefined)) - delta,
        ),
      ).toBeLessThan(1e-9);
    }
    // Symmetric: same evidence size, opposite direction, mirrored increment.
    const winDelta = rolloutBlendedScore(win, LANDLORD_ROOT, worlds, GATE_WEIGHT) -
      rolloutBlendedScore(win, LANDLORD_ROOT, worlds, undefined);
    const lossDelta = rolloutBlendedScore(loss, LANDLORD_ROOT, worlds, GATE_WEIGHT) -
      rolloutBlendedScore(loss, LANDLORD_ROOT, worlds, undefined);
    expect(winDelta).toBe(-lossDelta);
  });

  it("shrugs when no world completed, evidence or not", () => {
    const entry = candidate({ terminalTotal: 10_000, terminalWinners: ["ai-one"] });
    expect(bits(rolloutBlendedScore(entry, LANDLORD_ROOT, 0, undefined)))
      .toBe(bits(entry.expertScore + 0));
    expect(bits(rolloutBlendedScore(entry, LANDLORD_ROOT, 0, GATE_WEIGHT)))
      .toBe(bits(entry.expertScore + 0));
  });
});

function seeded(seed: number): RandomSource {
  let value = seed >>> 0;
  return {
    next() {
      value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
      return value / 0x1_0000_0000;
    },
  };
}

function dealWithLandlord(seed: number, landlord: Seat): GameState {
  const deck = shuffle(createDeck(), seeded(seed));
  const dealt = transition(INITIAL_GAME_STATE, { type: "deal", deck });
  if (!dealt.ok) {
    throw new Error("test deal failed");
  }
  let state = dealt.state;
  for (const seat of SEAT_ORDER) {
    const bid = transition(state, {
      type: "bid",
      seat,
      decision: seat === landlord ? "call" : "decline",
    });
    if (!bid.ok) {
      throw new Error("test bid failed");
    }
    if (seat === landlord) {
      return bid.state;
    }
    state = bid.state;
  }
  throw new Error("test landlord was not selected");
}

/**
 * Real positions from the endgame, where a three-ply rollout can actually reach
 * a decided hand — the short-hand regime terminal evidence lives in. Every seat
 * is played by the casual strategy, which is many times cheaper than the search
 * this file is measuring.
 */
function playToEndgame(
  dealSeed: number,
  landlord: Seat,
  minimumHand: number,
): readonly PlayContext[] {
  let state = dealWithLandlord(dealSeed, landlord);
  const contexts: PlayContext[] = [];
  for (let step = 0; step < 256; step += 1) {
    if (state.phase === "finished") {
      break;
    }
    if (state.phase !== "ready-to-play" && state.phase !== "playing") {
      throw new Error(`unexpected phase ${state.phase}`);
    }
    const seat = state.currentSeat;
    const view = createPlayerView(state, seat);
    if (view === null || view.phase === "bidding") {
      throw new Error("expected a playing view");
    }
    const context = Object.freeze({
      kind: "play" as const,
      view,
      legalActions: generateLegalActions({ hand: view.hand, currentPlay: view.currentPlay }),
    });
    if (Math.min(...SEAT_ORDER.map((entry) => view.remainingCardCounts[entry])) <= minimumHand) {
      contexts.push(context);
    }
    const applied = transition(state, CASUAL_AI_STRATEGY.chooseCommand(context));
    if (!applied.ok) {
      throw new Error(`test turn failed: ${applied.error.code}`);
    }
    state = applied.state;
  }
  return contexts;
}

const POSITIONS = Object.freeze([
  ...playToEndgame(4242, "human", 2),
  ...playToEndgame(4243, "ai-one", 2),
  ...playToEndgame(4244, "ai-two", 2),
]);

function withGate(context: PlayContext, weight: number) {
  return rankMasterPlayActions(context, {
    seed: 99 + context.legalActions.length,
    maxWorlds: WORLD_COUNT,
    rolloutDepth: ROLLOUT_DEPTH,
    rootAnalyzerNodes: ROOT_ANALYZER_NODES,
    terminalGateWeight: weight,
  });
}

function withoutGate(context: PlayContext) {
  return rankMasterPlayActions(context, {
    seed: 99 + context.legalActions.length,
    maxWorlds: WORLD_COUNT,
    rolloutDepth: ROLLOUT_DEPTH,
    rootAnalyzerNodes: ROOT_ANALYZER_NODES,
  });
}

describe("H5 v1 on real positions", () => {
  it("ranks identically at the gate weight production already uses", () => {
    expect(POSITIONS.length).toBeGreaterThan(0);
    for (const context of POSITIONS) {
      const production = withoutGate(context);
      const identity = withGate(context, ROLLOUT_BLEND_WEIGHT);
      expect(identity.map((entry) => bits(entry.score))).toEqual(
        production.map((entry) => bits(entry.score)),
      );
      expect(identity.map((entry) => entry.action)).toEqual(
        production.map((entry) => entry.action),
      );
    }
  });

  it("gates, and moves only terminal evidence at the frozen weight", () => {
    // One terminal trajectory is worth `(1 - 0.2) × 10000 / worlds` here: these
    // positions run with no deadline and sampling never throws, so every one of
    // them completes all `WORLD_COUNT` worlds.
    const quantum = ((GATE_WEIGHT - ROLLOUT_BLEND_WEIGHT) * TERMINAL_UTILITY) / WORLD_COUNT;
    let gatedCandidates = 0;
    for (const context of POSITIONS) {
      const production = withoutGate(context);
      const gated = withGate(context, GATE_WEIGHT);
      // Candidate generation is frozen: the same actions, in the same set.
      expect(gated.map((entry) => entry.action)).toEqual(production.map((entry) => entry.action));
      gated.forEach((entry, index) => {
        const delta = entry.score - (production[index]?.score ?? 0);
        if (delta === 0) {
          return;
        }
        gatedCandidates += 1;
        // A gated candidate moves by whole terminal trajectories at the gate's
        // own scale — never a fraction of one, and never more than the worlds
        // that produced them. A wrong denominator, a component-wise rewrite, or
        // a non-terminal term leaking into the increment breaks this.
        const terminalTrajectories = delta / quantum;
        expect(Math.abs(terminalTrajectories - Math.round(terminalTrajectories)))
          .toBeLessThan(1e-6);
        expect(Math.abs(Math.round(terminalTrajectories))).toBeGreaterThanOrEqual(1);
        expect(Math.abs(Math.round(terminalTrajectories))).toBeLessThanOrEqual(WORLD_COUNT);
      });
    }
    // Not vacuous: the gate has to have fired somewhere, or the identity above
    // only ever compared two branches nothing ever took.
    expect(gatedCandidates).toBeGreaterThan(0);
  });
});
