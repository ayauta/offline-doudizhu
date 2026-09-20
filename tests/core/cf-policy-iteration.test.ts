/**
 * Public-contract guards for the Phase 2 Night Lab π1→π2 policy iteration
 * (`docs/specs/064-phase2-night-policy-iteration/spec.md`).
 *
 * The mechanism is one idea: keep every frozen v1 constant and change only
 * *where the data comes from* — visit under π1, take π1's own executed action
 * `b1` as the reference, and let both fork branches continue under π1. Several
 * independent ways to invalidate the round follow from that, so each gets its
 * own assertion instead of being inferred from a win total afterwards:
 *
 *   - **reference identity**: the row's third argument must be `b1`, never `b0`.
 *     A composition that scored π2 against `b0` would still produce a model, a
 *     corpus and a plausible number; it would just be answering Gate A's
 *     question again with different data. `b0` must also survive as one of
 *     layer 2's alternatives whenever it differs from `b1`.
 *   - **continuation identity**: the reference branch must reproduce the
 *     original game's continuation *exactly* — command for command and per-seat
 *     decision index for decision index. A matching winner is not evidence of
 *     that, so the trace comparison is tested on traces that share a winner and
 *     differ one command later, and the fork is checked against a replay built
 *     here rather than against the capture's own self-report.
 *   - **scope**: the composition must not fire for the landlord or for a seat it
 *     was not bound to, and it must do *no work at all* when it declines — no
 *     proposal, no model traversal.
 *   - **cost**: one shared proposal, one traversal per layer. The composition's
 *     only claimed cost is a second model traversal, so a second `cfProposal`
 *     call would make the structural cost gate a fiction.
 *
 * Two kinds of fixture, deliberately kept apart:
 *
 *   - **synthetic models** for every threshold, tie-break, scope and cost
 *     question, so the answer does not depend on what a real model happens to
 *     score;
 *   - **retired-pool deals** (`50_0xx`) for anything that needs a real root. The
 *     fresh pools this spec allocates are never dealt, never played and never
 *     looked at here — `cfPiGroupSpecFor` is exercised on them for *shape and
 *     refusal only*, which builds a spec object out of arithmetic and plays
 *     nothing.
 */
import { describe, expect, it } from "vitest";

import { createPlayerView, type AiDecisionContext, type AiStrategy } from "../../src/core/ai/index.js";
import {
  transition,
  type GameCommand,
  type GameState,
  type PlayingState,
  type Seat,
} from "../../src/core/game/index.js";
import {
  cfActionCommand,
  cfCommandKey,
  cfProposal,
  cfScoreAlternatives,
  cfSelectFarmerAction,
  parseTreeModel,
  type CfProposal,
  type TreeModel,
} from "../../src/app/ai/cf-selector.js";
import { CF_MODEL_SHA256, CF_SELECTOR_THRESHOLD } from "../../src/app/ai/cf-model-data.js";
import {
  CF_DATASET_VERSION,
  CF_FEATURE_NAMES,
  CF_GROUP_SNAPSHOT_CAP,
  CF_SNAPSHOT_SALT,
  CF_SPLIT_COUNTS,
  CF_SPLIT_SALT,
  cfCaptureGroup,
  cfForkLabels,
  cfPlayContext,
  cfPlayToTerminal,
  cfPolicyCommand,
  cfRow,
  cfRows,
  cfSnapshotPriority,
  type CfForkResult,
  type CfGroupResult,
  type CfGroupSpec,
  type CfPolicyCounters,
  type CfSeatTiers,
  type CfSnapshot,
} from "../../benchmarks/cf-dataset.js";
import {
  CF_PI_DATASET_VERSION,
  CF_PI_GROUP_SNAPSHOT_CAP,
  CF_PI_MODEL_SHA256,
  CF_PI_POOLS,
  CF_PI_SEED_BASE,
  CF_PI_SNAPSHOT_SALT,
  CF_PI_SPLIT_COUNTS,
  CF_PI_SPLIT_SALT,
  CF_PI_STAGE1_END,
  CF_PI_STAGE1_START,
  CF_PI_STAGE2_END,
  CF_PI_STAGE2_START,
  CF_PI_THRESHOLD,
  CF_PI_UNAVAILABLE_RANGES,
  CF_PI_UNIVERSE_END,
  CF_PI_UNIVERSE_START,
  assertPiSeedBase,
  cfPiCaptureGroup,
  cfPiDecision,
  cfPiGroupSpecFor,
  cfPiPolicy,
  cfPiPoolOf,
  cfPiSplitOf,
  cfSelectTwoLayerFarmerAction,
  cfTraceDivergence,
  createTwoLayerStrategy,
  type CfPiBaseline,
} from "../../benchmarks/cf-policy-iteration.js";
import { cfSchemaHash } from "../../benchmarks/cf-corpus.js";
import { createChallengerStrategy } from "../../benchmarks/cf-challenger.js";
import {
  armSchedule,
  createRecorder,
  dealDeck,
  dealGameSeed,
  playGame,
  scheduleFor,
  startWithLandlord,
} from "../../benchmarks/ai-tournament.js";
import { LIGHT_TIERS, redealHidden, studiedTiers, toFarmerRoot } from "../support/cf-fixtures.js";

// ---------------------------------------------------------------------------
// Synthetic models
// ---------------------------------------------------------------------------

/** A tree-table model that returns `value` for every row. */
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

/**
 * A model whose tree array counts how many times a walk *starts*.
 *
 * `parseTreeModel` freezes the record it returns, so a tripwire cannot be
 * defined onto `model.trees` after the fact — the property is non-configurable
 * and `Object.defineProperty` throws rather than arming anything. The array
 * itself is not frozen, so the counter lives on a proxy supplied at
 * construction and is armed only once `parseTreeModel`'s own validation pass is
 * out of the way.
 *
 * Counting rather than throwing is deliberate: the same fixture states "this
 * layer did no work" and serves as the positive control that proves the counter
 * is wired at all.
 */
function countingModel(value: number): Readonly<{
  model: TreeModel;
  traversals: () => number;
  arm: () => void;
}> {
  const trees = [{
    feature: [-1], threshold: [0], defaultLeft: [0],
    missingZero: [0], left: [0], right: [0], value: [value],
  }];
  let armed = false;
  let traversals = 0;
  const proxy = new Proxy(trees, {
    get(target, property, receiver) {
      if (armed && property === Symbol.iterator) {
        traversals += 1;
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  const model = parseTreeModel({
    formatVersion: 1,
    lightgbmVersion: "test",
    modelSha256: "test",
    numTrees: 1,
    numFeatures: CF_FEATURE_NAMES.length,
    featureNames: [...CF_FEATURE_NAMES],
    trees: proxy,
  });
  return { model, traversals: () => traversals, arm: () => { armed = true; } };
}

const ALWAYS = constantModel(1);
const NEVER = constantModel(-1);

function baselineOf(model: TreeModel): CfPiBaseline {
  return Object.freeze({ model, threshold: CF_PI_THRESHOLD });
}

/** A counting wrapper around the *frozen* proposal, so §7.17 counts real calls. */
function countingProposal(): Readonly<{
  proposalOf: (context: Parameters<typeof cfProposal>[0]) => CfProposal;
  calls: () => number;
}> {
  let calls = 0;
  return {
    proposalOf: (context) => {
      calls += 1;
      return cfProposal(context);
    },
    calls: () => calls,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STUDIED: Seat = "ai-one";
const LANDLORD: Seat = "human";
const OTHER: Seat = "ai-two";
const TALLY: CfPolicyCounters = { human: 0, "ai-one": 0, "ai-two": 0 };

type Fixture = Readonly<{
  dealIndex: number;
  gameSeed: number;
  state: GameState;
  context: ReturnType<typeof cfPlayContext>;
  counters: CfPolicyCounters;
  /** The raw production action at this root — the `b0` of §3. */
  raw: GameCommand;
  proposal: CfProposal;
  rawIndex: number;
}>;

let fixtureCache: Fixture | null = null;

/**
 * A retired-pool farmer root with a real `b0`, sitting at candidate index 0 of
 * a three-wide shortlist.
 *
 * The studied seat carries `master` for the single decision taken here, because
 * that is the schedule the corpus actually runs: `b0` is a master action, and a
 * master action comes out of the same expert shortlist `cfProposal`
 * reproduces — which is why `b0 ∈ C` is a property of the shipped pipeline and
 * not of this fixture. A `default`-tier action is a different policy's choice
 * and need not be a candidate at all.
 *
 * Two shape requirements, both load-bearing rather than convenient:
 *
 *   - **three candidates**, so "the shortlist minus one" is distinguishable
 *     from "everything legal" and the tie-break has somewhere to land;
 *   - **`b0` at index 0**, which is what makes §7.1 checkable rather than
 *     assertable. Both layers scan `C` from the front and skip one index each,
 *     so π1 takes `C[1]` and π2 lands back on `C[0]`: if π2 returns `b0`, then
 *     `b0` was demonstrably among the alternatives it was offered.
 *
 * The search is explicit rather than assumed. "The fixture root happens to have
 * this shape" is exactly the kind of setup belief that turns a guard vacuous,
 * and the deals that satisfy it are a small minority — 15 of the first 119
 * farmer roots.
 */
function fixture(): Fixture {
  if (fixtureCache === null) {
    for (let dealIndex = 50_001; dealIndex < 50_060; dealIndex += 1) {
      const gameSeed = dealGameSeed(dealIndex, STUDIED, LANDLORD);
      const { state, counters } = toFarmerRoot(dealIndex, gameSeed, LANDLORD, STUDIED);
      if (state.phase !== "playing" && state.phase !== "ready-to-play") {
        continue;
      }
      const context = cfPlayContext(state, STUDIED);
      const raw = cfPolicyCommand(
        studiedTiers(STUDIED), gameSeed, STUDIED, context, counters[STUDIED]);
      const proposal = cfProposal(context);
      if (proposal.actions.length !== 3) {
        continue;
      }
      const rawIndex = keysOf(STUDIED, proposal).indexOf(cfCommandKey(raw));
      if (rawIndex !== 0) {
        continue;
      }
      fixtureCache = Object.freeze({
        dealIndex, gameSeed, state, context, counters, raw, proposal, rawIndex,
      });
      break;
    }
    if (fixtureCache === null) {
      throw new Error("Guard setup found no root with b0 at index 0 of a three-wide shortlist.");
    }
  }
  return fixtureCache;
}

function keysOf(seat: Seat, proposal: CfProposal): readonly string[] {
  return proposal.actions.map((action) => cfCommandKey(cfActionCommand(seat, action)));
}

function actionAt(proposal: CfProposal, index: number) {
  const action = proposal.actions[index];
  if (action === undefined) {
    throw new Error(`Guard setup has no candidate at ${index}.`);
  }
  return action;
}

function keyAt(proposal: CfProposal, seat: Seat, index: number): string {
  return cfCommandKey(cfActionCommand(seat, actionAt(proposal, index)));
}

/** The first candidate index that is none of `excluded`. */
function firstOther(proposal: CfProposal, excluded: readonly number[]): number {
  return proposal.actions.findIndex((_action, index) => !excluded.includes(index));
}

/**
 * A π1 group spec on a **retired** deal, shaped exactly like
 * `cfPiGroupSpecFor`'s output for the same index. The fresh universe is never
 * dealt here, so this rebuilds the shape rather than calling the pool gate.
 */
function piSpecFor(dealIndex: number): CfGroupSpec {
  const variants = armSchedule(dealIndex)
    .filter((slot) => slot.arm === "B" && slot.strongSeat !== slot.landlord)
    .map((slot) => Object.freeze({
      variantId: `${dealIndex}:${slot.landlord}:${slot.strongSeat}`,
      landlord: slot.landlord,
      studiedSeat: slot.strongSeat,
      gameSeed: dealGameSeed(dealIndex, slot.strongSeat, slot.landlord),
      tiers: scheduleFor("master", "default", slot.strongSeat),
    }));
  if (variants.length === 0) {
    throw new Error("Guard setup built a spec with no variants.");
  }
  return Object.freeze({
    groupId: `deal-${dealIndex}`,
    dealIndex,
    dealSeed: dealIndex,
    variants: Object.freeze(variants),
    snapshotCap: CF_PI_GROUP_SNAPSHOT_CAP,
    policyCommit: "guard",
  });
}

/**
 * The same shape with a single variant, for the tests that need one game rather
 * than six.
 *
 * The studied seat keeps `master`, and that is not incidental: π1 can only
 * differ from π0 where production's own action is one of production's own
 * candidates, and that is a property of the `master` tier. Running these
 * fixtures on `default` makes the selector decline at every single root, which
 * turns "the fork resumed π1" into a claim no continuation could fail.
 */
function singleVariantPiSpec(dealIndex: number): CfGroupSpec {
  const spec = piSpecFor(dealIndex);
  const variant = spec.variants[0];
  if (variant === undefined) {
    throw new Error("Guard setup built a spec with no variants.");
  }
  return Object.freeze({ ...spec, variants: Object.freeze([variant]) });
}

let captured: CfGroupResult | null = null;

/**
 * The suite's single real π1 capture. A `master` capture costs real games, so
 * everything that needs a snapshot shares this one.
 */
function group(): CfGroupResult {
  if (captured === null) {
    const spec = piSpecFor(50_011);
    captured = cfPiCaptureGroup(dealDeck(spec.dealSeed), spec, baselineOf(ALWAYS));
    if (captured.snapshots.length === 0) {
      throw new Error("Guard setup captured no snapshots.");
    }
  }
  return captured;
}

function actionAtIn(snapshot: CfSnapshot, actionIndex: number) {
  const action = snapshot.actions[actionIndex];
  if (action === undefined) {
    throw new Error(`Guard setup lost the action at ${actionIndex}.`);
  }
  return action;
}

/** The action a snapshot's candidate at `index` refers to. */
function candidateActionAt(snapshot: CfSnapshot, index: number) {
  const candidate = snapshot.candidates[index];
  if (candidate === undefined) {
    throw new Error(`Guard setup lost the candidate at ${index}.`);
  }
  return actionAtIn(snapshot, candidate.actionIndex);
}

/**
 * Replays one variant under π1 from its deal, without `cfCaptureGroup`, keeping
 * the state and counters at every studied-seat decision.
 *
 * This exists so §7.7 is checked against a continuation built *here* rather
 * than against the capture's own counter — a module that asserted its own
 * replay had happened would keep asserting it after the replay stopped
 * happening.
 */
function replayVariant(
  dealIndex: number,
  landlord: Seat,
  studied: Seat,
  tiers: CfSeatTiers,
  baseline: CfPiBaseline,
): Readonly<{
  trace: CfForkResult;
  roots: readonly Readonly<{
    state: GameState;
    context: ReturnType<typeof cfPlayContext>;
    counters: CfPolicyCounters;
    step: number;
    index: number;
  }>[];
}> {
  const gameSeed = dealGameSeed(dealIndex, studied, landlord);
  const policy = cfPiPolicy(baseline, studied);
  let state: GameState = startWithLandlord(dealDeck(dealIndex), landlord);
  const counters: CfPolicyCounters = { ...TALLY };
  const roots: Array<{
    state: GameState;
    context: ReturnType<typeof cfPlayContext>;
    counters: CfPolicyCounters;
    step: number;
    index: number;
  }> = [];
  const commands: string[] = [];
  const decisions: Array<Readonly<{ seat: Seat; index: number }>> = [];
  for (let step = 0; step < 256; step += 1) {
    if (state.phase === "finished") {
      return Object.freeze({
        trace: Object.freeze({
          winner: state.winner,
          commands: Object.freeze(commands),
          decisions: Object.freeze(decisions),
        }),
        roots: Object.freeze(roots.map((root) => Object.freeze(root))),
      });
    }
    if (state.phase !== "playing" && state.phase !== "ready-to-play") {
      throw new Error(`Guard replay reached phase ${state.phase}.`);
    }
    const seat = state.currentSeat;
    const context = cfPlayContext(state, seat);
    const raw = cfPolicyCommand(tiers, gameSeed, seat, context, counters[seat]);
    const command = policy(context, raw);
    if (seat === studied) {
      roots.push({ state, context, counters: { ...counters }, step, index: counters[seat] });
    }
    decisions.push(Object.freeze({ seat, index: counters[seat] }));
    commands.push(cfCommandKey(command));
    counters[seat] += 1;
    const result = transition(state, command);
    if (!result.ok) {
      throw new Error(`Guard replay played an illegal command: ${result.error.code}`);
    }
    state = result.state;
  }
  throw new Error("Guard replay did not reach a terminal position.");
}

// ---------------------------------------------------------------------------
// §0 — the supplied-proposal seam preserves v1's semantics
// ---------------------------------------------------------------------------

describe("policy iteration: the supplied-proposal seam", () => {
  it("agrees with the shipped selector command for command, over a model battery", () => {
    // `cfSelectFarmerAction` delegates its scoring loop to `cfScoreAlternatives`.
    // The two must agree on every model, including the ones sitting exactly on
    // the threshold and the ones that tie every candidate.
    const { context, raw, proposal, rawIndex } = fixture();
    const keys = keysOf(STUDIED, proposal);

    for (const model of [
      NEVER,
      ALWAYS,
      constantModel(CF_PI_THRESHOLD),
      constantModel(CF_PI_THRESHOLD + 1e-9),
    ]) {
      const viaSelector = cfSelectFarmerAction(context, raw, {
        model, threshold: CF_PI_THRESHOLD, seat: STUDIED,
      });
      const choice = cfScoreAlternatives(
        context.view, proposal, rawIndex, model, CF_PI_THRESHOLD);
      expect(cfCommandKey(viaSelector)).toBe(
        keys[choice.overrode ? choice.index : rawIndex]);
      if (!choice.overrode) {
        // A decline hands back the caller's own object, never a rebuild of it.
        expect(viaSelector).toBe(raw);
      }
    }
  });

  it("scores every candidate except the reference, and never the reference itself", () => {
    const { context, proposal, rawIndex } = fixture();
    const choice = cfScoreAlternatives(
      context.view, proposal, rawIndex, ALWAYS, CF_PI_THRESHOLD);
    expect(choice.scored).toBe(proposal.actions.length - 1);
    expect(choice.index).not.toBe(rawIndex);
    expect(choice.overrode).toBe(true);
  });

  it("keeps the frozen threshold strict: exactly 0.01 declines, 0.01 + 1e-9 overrides", () => {
    const { context, proposal, rawIndex } = fixture();
    expect(cfScoreAlternatives(
      context.view, proposal, rawIndex, constantModel(CF_PI_THRESHOLD), CF_PI_THRESHOLD)
      .overrode).toBe(false);
    expect(cfScoreAlternatives(
      context.view, proposal, rawIndex, constantModel(CF_PI_THRESHOLD + 1e-9), CF_PI_THRESHOLD)
      .overrode).toBe(true);
  });

  it("breaks a tie by the earliest production candidate, not the last (§7.5)", () => {
    // Every candidate scores the same, so the winner is decided entirely by the
    // scan order. The frozen rule is "first strictly-greatest in `C` order".
    const { context, proposal, rawIndex } = fixture();
    const choice = cfScoreAlternatives(
      context.view, proposal, rawIndex, ALWAYS, CF_PI_THRESHOLD);
    expect(choice.index).toBe(firstOther(proposal, [rawIndex]));
  });

  it("declines rather than guessing when the reference is not a candidate", () => {
    const { context, proposal } = fixture();
    const choice = cfScoreAlternatives(
      context.view, proposal, proposal.actions.length + 5, ALWAYS, CF_PI_THRESHOLD);
    expect(choice.index).toBe(-1);
    expect(choice.overrode).toBe(false);
    expect(choice.scored).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §2, §4, §18 — the frozen baseline and the unchanged candidate interface
// ---------------------------------------------------------------------------

describe("policy iteration: the frozen baseline is imported, not restated", () => {
  it("pins the artifact, the threshold and the schema hash the spec froze", () => {
    expect(CF_PI_MODEL_SHA256).toBe(CF_MODEL_SHA256);
    expect(CF_MODEL_SHA256).toBe(
      "010a8a4a00524f0694d5881bacdd885d99243acf4d71e2b2fdcae7ae82fc3359");
    expect(CF_PI_THRESHOLD).toBe(CF_SELECTOR_THRESHOLD);
    expect(CF_PI_THRESHOLD).toBe(0.01);
    // The schema hash is re-derived from the column names, so this one
    // assertion pins all 86 columns, their frozen order and the schema version.
    expect(cfSchemaHash()).toBe(
      "0ec9d20f4abde4b7c5d72751b488de2180723863d3a6248593404c8bee7d85f0");
    expect(CF_FEATURE_NAMES.length).toBe(86);
  });

  it("keeps v1's own dataset version, so a π2 corpus cannot be read as a v1 one", () => {
    expect(CF_DATASET_VERSION).toBe(2);
    expect(CF_PI_DATASET_VERSION).not.toBe(CF_DATASET_VERSION);
    expect(CF_PI_GROUP_SNAPSHOT_CAP).toBe(CF_GROUP_SNAPSHOT_CAP);
    expect(CF_PI_GROUP_SNAPSHOT_CAP).toBe(3);
    expect(CF_PI_SPLIT_COUNTS).toEqual(CF_SPLIT_COUNTS);
    expect(CF_PI_SPLIT_COUNTS).toEqual({ train: 12_000, calibration: 4_000, heldout: 4_000 });
    // A fresh round needs fresh salts; reusing v1's would re-sample the same
    // roots under a different universe and call it a new dataset.
    expect(CF_PI_SPLIT_SALT).not.toBe(CF_SPLIT_SALT);
    expect(CF_PI_SNAPSHOT_SALT).not.toBe(CF_SNAPSHOT_SALT);
    expect(cfSnapshotPriority(CF_PI_SNAPSHOT_SALT, "deal-1", "variant", 3))
      .not.toBe(cfSnapshotPriority(CF_SNAPSHOT_SALT, "deal-1", "variant", 3));
  });

  it("produces π2 rows v1's own reader consumes without a change (§7.18)", () => {
    const snapshot = group().snapshots[0];
    if (snapshot === undefined) {
      throw new Error("Guard setup captured no snapshot.");
    }
    const rows = cfRows(snapshot, "train");
    expect(rows.length).toBe(snapshot.candidates.length - 1);
    for (const row of rows) {
      // `cfRows` is v1's reader, unmodified. This is §7.18's whole claim: same
      // row shape, same column order, same width — not a parallel schema.
      expect(Object.keys(row).sort()).toEqual(
        ["expertGap", "groupId", "minRemaining", "seat", "snapshotId", "split", "x", "y"]);
      expect(row.x.length).toBe(86);
    }
  });
});

// ---------------------------------------------------------------------------
// §8, §7.16 — pools and split
// ---------------------------------------------------------------------------

describe("policy iteration: pools and split", () => {
  it("freezes the three fresh pools at exactly the preregistered sizes", () => {
    expect(CF_PI_UNIVERSE_START).toBe(100_001);
    expect(CF_PI_UNIVERSE_END).toBe(120_000);
    expect(CF_PI_STAGE1_START).toBe(120_001);
    expect(CF_PI_STAGE1_END - CF_PI_STAGE1_START + 1).toBe(200);
    expect(CF_PI_STAGE2_START).toBe(130_001);
    expect(CF_PI_STAGE2_END - CF_PI_STAGE2_START + 1).toBe(1_200);
    expect(CF_PI_UNIVERSE_END - CF_PI_UNIVERSE_START + 1).toBe(
      CF_PI_SPLIT_COUNTS.train + CF_PI_SPLIT_COUNTS.calibration + CF_PI_SPLIT_COUNTS.heldout);
  });

  it("keeps the three pools pairwise disjoint and off every unavailable range", () => {
    for (let left = 0; left < CF_PI_POOLS.length; left += 1) {
      const a = CF_PI_POOLS[left];
      if (a === undefined) {
        throw new Error("Guard setup lost a pool.");
      }
      expect(a.end).toBeGreaterThanOrEqual(a.start);
      for (let right = left + 1; right < CF_PI_POOLS.length; right += 1) {
        const b = CF_PI_POOLS[right];
        if (b === undefined) {
          throw new Error("Guard setup lost a pool.");
        }
        expect(a.end < b.start || b.end < a.start).toBe(true);
      }
      for (const range of CF_PI_UNAVAILABLE_RANGES) {
        expect(a.end < range.start || range.end < a.start).toBe(true);
      }
    }
  });

  it("lists every range the spec calls unavailable, including the gaps between its own pools", () => {
    const covered = (index: number): boolean =>
      CF_PI_UNAVAILABLE_RANGES.some((range) => index >= range.start && index <= range.end);
    for (const index of [
      301, 700, 5_001, 5_400, 10_001, 10_400, 20_001, 20_400, 30_001, 30_400,
      40_001, 41_200, 50_001, 70_000, 70_001, 78_000, 120_201, 130_000, 131_201,
    ]) {
      expect(covered(index)).toBe(true);
    }
    // The boundaries just outside them are allocated.
    for (const index of [300, 701, 5_000, 10_401, 78_001, 120_200, 131_200]) {
      expect(covered(index)).toBe(false);
    }
  });

  it("assigns the whole universe to the frozen split counts, with nothing left over", () => {
    const counts = { train: 0, calibration: 0, heldout: 0 };
    for (let index = CF_PI_UNIVERSE_START; index <= CF_PI_UNIVERSE_END; index += 1) {
      const split = cfPiSplitOf(index);
      if (split === undefined) {
        throw new Error(`Deal ${index} is inside the π1 universe but has no split.`);
      }
      counts[split] += 1;
    }
    expect(counts).toEqual(CF_PI_SPLIT_COUNTS);
  });

  it("gives no stage pool, gap or retired range a training split", () => {
    for (const index of [
      CF_PI_UNIVERSE_START - 1, CF_PI_UNIVERSE_END + 1,
      CF_PI_STAGE1_START, CF_PI_STAGE1_END, CF_PI_STAGE2_START, CF_PI_STAGE2_END,
      120_201, 130_000, 131_201, 301, 5_001, 10_001, 40_001, 50_001, 70_001,
    ]) {
      expect(cfPiSplitOf(index)).toBeUndefined();
    }
  });

  it("names the pool a deal belongs to, and refuses to build a group outside the dataset one", () => {
    expect(cfPiPoolOf(CF_PI_UNIVERSE_START)).toBe("dataset");
    expect(cfPiPoolOf(CF_PI_STAGE1_START)).toBe("stage1");
    expect(cfPiPoolOf(CF_PI_STAGE2_START)).toBe("stage2");
    expect(cfPiPoolOf(120_201)).toBeNull();
    expect(cfPiPoolOf(301)).toBeNull();

    // Building a spec is arithmetic: no deck is dealt and no game is played, so
    // this touches no seed in the fresh universe.
    for (const index of [301, 10_001, 40_001, 50_001, 70_000, 100_000,
      CF_PI_STAGE1_START, CF_PI_STAGE2_END, 120_201, 131_201]) {
      expect(() => cfPiGroupSpecFor(index, "guard")).toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// §7.10 — seed mapping
// ---------------------------------------------------------------------------

describe("policy iteration: seed mapping", () => {
  it("derives the game seed from the tournament's own function, at seedBase zero", () => {
    expect(CF_PI_SEED_BASE).toBe(0);
    expect(() => assertPiSeedBase(CF_PI_SEED_BASE)).not.toThrow();
    for (const wrong of [1, 301, CF_PI_UNIVERSE_START]) {
      expect(() => assertPiSeedBase(wrong)).toThrow(/seedBase/);
    }

    // A spec object only. Nothing here deals the fresh deck or plays it.
    const spec = cfPiGroupSpecFor(CF_PI_UNIVERSE_START, "guard");
    expect(spec.dealSeed).toBe(spec.dealIndex);
    expect(spec.snapshotCap).toBe(CF_PI_GROUP_SNAPSHOT_CAP);
    expect(spec.variants.length).toBeGreaterThan(0);
    for (const variant of spec.variants) {
      // Farmers only: a landlord root has no override to make.
      expect(variant.studiedSeat).not.toBe(variant.landlord);
      expect(variant.tiers[variant.studiedSeat]).toBe("master");
      // The corpus calls `dealGameSeed(dealSeed, ...)`; the tournament calls
      // `dealGameSeed(seedBase + dealIndex, ...)`. With one source of truth and
      // a preregistered zero base, those are the same number by construction.
      expect(variant.gameSeed).toBe(
        dealGameSeed(spec.dealSeed, variant.studiedSeat, variant.landlord));
      expect(variant.gameSeed).toBe(
        dealGameSeed(CF_PI_SEED_BASE + spec.dealIndex, variant.studiedSeat, variant.landlord));
    }
  });

  it("picks the same deck from the corpus seed and from the tournament seed", () => {
    // Checked on retired deals: the identity is algebraic, and proving it must
    // not cost the fresh universe a single deck.
    for (const dealIndex of [50_011, 50_021, 50_031]) {
      expect(dealDeck(CF_PI_SEED_BASE + dealIndex)).toEqual(dealDeck(dealIndex));
    }
    expect(dealDeck(CF_PI_SEED_BASE + 50_011)).not.toEqual(dealDeck(50_012));
  });
});

// ---------------------------------------------------------------------------
// §5, §5.1, §10, §7.4, §7.5, §7.9, §7.13, §7.17 — the runtime composition
// ---------------------------------------------------------------------------

describe("policy iteration: two-layer composition", () => {
  const options = (
    extra: Partial<Parameters<typeof cfSelectTwoLayerFarmerAction>[2]> = {},
  ) => Object.freeze({
    baselineModel: ALWAYS,
    challengerModel: ALWAYS,
    threshold: CF_PI_THRESHOLD,
    seat: STUDIED,
    ...extra,
  });

  it("keeps the landlord arm identical and does no work to do it (§5.1, §7.13)", () => {
    const { state } = fixture();
    const landlordContext = cfPlayContext(state, LANDLORD);
    const production: GameCommand = Object.freeze({ type: "pass", seat: LANDLORD });
    const counter = countingProposal();
    const counted = countingModel(1);
    counted.arm();

    const outcome = cfSelectTwoLayerFarmerAction(landlordContext, production, options({
      seat: LANDLORD, proposalOf: counter.proposalOf,
      baselineModel: counted.model, challengerModel: counted.model,
    }));
    expect(outcome.command).toBe(production);
    expect(outcome.proposals).toBe(0);
    expect(counter.calls()).toBe(0);
    expect(counted.traversals()).toBe(0);
  });

  it("never fires for a seat it was not bound to (§7.9)", () => {
    const { context, raw } = fixture();
    const counter = countingProposal();
    const outcome = cfSelectTwoLayerFarmerAction(
      context, raw, options({ seat: OTHER, proposalOf: counter.proposalOf }));
    expect(outcome.command).toBe(raw);
    expect(outcome.proposals).toBe(0);
    expect(counter.calls()).toBe(0);
    expect(outcome.baselineRows).toBe(0);
    expect(outcome.challengerRows).toBe(0);
  });

  it("does no work at all when it is disabled", () => {
    const { context, raw } = fixture();
    const counter = countingProposal();
    const counted = countingModel(1);
    counted.arm();
    const outcome = cfSelectTwoLayerFarmerAction(context, raw, options({
      enabled: false, proposalOf: counter.proposalOf,
      baselineModel: counted.model, challengerModel: counted.model,
    }));
    expect(outcome.command).toBe(raw);
    expect(outcome.proposals).toBe(0);
    expect(counter.calls()).toBe(0);
    expect(counted.traversals()).toBe(0);
  });

  it("shares one proposal and traverses each model once per alternative (§7.17, §10)", () => {
    const { context, raw, proposal } = fixture();
    const counter = countingProposal();
    const baseline = countingModel(1);
    const challenger = countingModel(1);
    baseline.arm();
    challenger.arm();
    const outcome = cfSelectTwoLayerFarmerAction(context, raw, options({
      proposalOf: counter.proposalOf,
      baselineModel: baseline.model,
      challengerModel: challenger.model,
    }));
    const alternatives = proposal.actions.length - 1;
    // One `cfProposal` call for both layers — the claim the structural cost
    // gate rests on, counted at the call site rather than self-reported.
    expect(counter.calls()).toBe(1);
    expect(outcome.proposals).toBe(1);
    // One traversal per alternative per layer, measured on the models
    // themselves. The same fixture is the positive control for the zero-work
    // assertions above: when a layer *does* run, this counter moves.
    expect(baseline.traversals()).toBe(alternatives);
    expect(challenger.traversals()).toBe(alternatives);
    expect(outcome.baselineRows).toBe(alternatives);
    expect(outcome.challengerRows).toBe(alternatives);
  });

  it("calls the raw production strategy exactly once per decision (§7.17)", () => {
    const { context, raw, proposal } = fixture();
    let calls = 0;
    const strategy = createTwoLayerStrategy(Object.freeze({
      chooseCommand: () => {
        calls += 1;
        return raw;
      },
    }) as AiStrategy, options({}));

    // One call into the strategy, and the production strategy underneath it
    // must have run exactly once: layer 2 scores the proposal both layers
    // share rather than going back for a second production action.
    const command = strategy.chooseCommand(context);
    expect(calls).toBe(1);
    // …and the strategy really did run the composition, so "one call" is not
    // the count of a passthrough that never reached layer 1.
    const outcome = cfSelectTwoLayerFarmerAction(context, raw, options({}));
    expect(cfCommandKey(command)).toBe(cfCommandKey(outcome.command));
    expect(outcome.baselineRows).toBeGreaterThan(0);
    expect(cfCommandKey(command)).toBe(keyAt(proposal, STUDIED, outcome.challengerIndex));
  });

  it("falls back to b1, never to b0, when π2 declines (§5)", () => {
    const { context, raw, proposal, rawIndex } = fixture();
    const outcome = cfSelectTwoLayerFarmerAction(
      context, raw, options({ baselineModel: ALWAYS, challengerModel: NEVER }));
    expect(outcome.baselineOverrode).toBe(true);
    expect(outcome.overrode).toBe(false);
    expect(outcome.rawIndex).toBe(rawIndex);
    expect(outcome.baselineIndex).not.toBe(rawIndex);
    // A declining π2 leaves π1's own action standing, and that is not `b0`.
    expect(cfCommandKey(outcome.command)).toBe(keyAt(proposal, STUDIED, outcome.baselineIndex));
    expect(cfCommandKey(outcome.command)).not.toBe(cfCommandKey(raw));
  });

  it("gives layer 2 the candidate set C minus b1, with b0 still in it (§3, §7.1, §7.3)", () => {
    const { context, raw, proposal, rawIndex } = fixture();
    // Both layers scan `C` from the front and skip one index each: π1 skips
    // `b0` at 0 and takes 1, π2 skips `b1` at 1 and lands back on 0.
    const outcome = cfSelectTwoLayerFarmerAction(context, raw, options({}));
    expect(outcome.baselineOverrode).toBe(true);
    expect(rawIndex).toBe(0);
    expect(outcome.baselineIndex).toBe(1);
    // π2 returned `b0`. That is only reachable if `b0` was among the
    // alternatives layer 2 was offered, so this *demonstrates* §7.1 rather than
    // asserting it — a composition that scored π2 against `C \ {b0}` could not
    // produce this command.
    expect(outcome.challengerIndex).toBe(rawIndex);
    expect(cfCommandKey(outcome.command)).toBe(cfCommandKey(raw));
    // And layer 2 was offered exactly one fewer candidate than `C`, so the
    // index it skipped was `b1` rather than anything else.
    expect(outcome.challengerRows).toBe(proposal.actions.length - 1);
  });

  it("requires the score to be strictly above the threshold in both layers (§7.4)", () => {
    const { context, raw } = fixture();
    const exactly = cfSelectTwoLayerFarmerAction(context, raw, options({
      baselineModel: constantModel(CF_PI_THRESHOLD),
      challengerModel: constantModel(CF_PI_THRESHOLD),
    }));
    expect(exactly.baselineOverrode).toBe(false);
    expect(exactly.overrode).toBe(false);
    // Nothing overrode, so layer 1's `b1` is the caller's own object and the
    // composition must hand that back rather than a rebuild of it.
    expect(exactly.command).toBe(raw);

    const above = cfSelectTwoLayerFarmerAction(context, raw, options({
      baselineModel: constantModel(CF_PI_THRESHOLD + 1e-9),
      challengerModel: constantModel(CF_PI_THRESHOLD + 1e-9),
    }));
    expect(above.baselineOverrode).toBe(true);
    expect(above.overrode).toBe(true);
    expect(above.command).not.toBe(raw);
  });

  it("breaks ties by the original C order in both layers (§7.5)", () => {
    const { context, raw, proposal } = fixture();
    const outcome = cfSelectTwoLayerFarmerAction(context, raw, options({}));
    // Every candidate scores the same, so each layer takes the first index it
    // scanned: layer 1 the earliest that is not b0's, layer 2 the earliest that
    // is not b1's — both over `C`'s own order.
    expect(outcome.baselineIndex).toBe(firstOther(proposal, [outcome.rawIndex]));
    expect(outcome.challengerIndex).toBe(firstOther(proposal, [outcome.baselineIndex]));
    expect(cfCommandKey(outcome.command))
      .toBe(keyAt(proposal, STUDIED, outcome.challengerIndex));
  });

  it("declines the whole composition when production's action is not a candidate (§5)", () => {
    // A *leading* root has no pass among its candidates — a pass is illegal
    // there — so a pass command structurally cannot be the reference and
    // neither layer may guess.
    //
    // The first farmer root of a deal is never a leading one: the landlord
    // opens. The root is therefore found by walking a whole game and looking at
    // every studied-seat decision, not by assuming the first one will do.
    let leading: { state: GameState; context: ReturnType<typeof cfPlayContext> } | null = null;
    for (let dealIndex = 50_001; dealIndex < 50_030 && leading === null; dealIndex += 1) {
      const walk = replayVariant(
        dealIndex, LANDLORD, STUDIED, LIGHT_TIERS, baselineOf(NEVER));
      const root = walk.roots.find((entry) => entry.context.view.currentPlay === null);
      if (root !== undefined) {
        leading = { state: root.state, context: root.context };
      }
    }
    if (leading === null) {
      throw new Error("Guard setup found no leading farmer root in the fixture range.");
    }
    const stray: GameCommand = Object.freeze({ type: "pass", seat: STUDIED });
    // The stray command is not merely missing from the shortlist — it is not a
    // legal action at this root at all. That is what makes `rawIndex < 0` here
    // a structural fact rather than a coincidence of this deal.
    expect(transition(leading.state, stray).ok).toBe(false);
    const counter = countingProposal();
    const outcome = cfSelectTwoLayerFarmerAction(leading.context, stray, options({
      proposalOf: counter.proposalOf,
    }));
    expect(outcome.rawIndex).toBe(-1);
    expect(outcome.command).toBe(stray);
    // One proposal is unavoidable — you cannot know `b0 ∉ C` without computing
    // `C` — but no model is traversed on the way to declining.
    expect(counter.calls()).toBe(1);
    expect(outcome.baselineRows).toBe(0);
    expect(outcome.challengerRows).toBe(0);
  });

  it("answers with a command the engine itself accepts (§7.14)", () => {
    const { state, context, raw, proposal } = fixture();
    expect(transition(state, cfSelectTwoLayerFarmerAction(context, raw, options({})).command).ok)
      .toBe(true);
    // Every candidate, `b0` and `b1` are legal under the engine's own command
    // validation — not a parallel legality notion invented here.
    expect(transition(state, raw).ok).toBe(true);
    for (let index = 0; index < proposal.actions.length; index += 1) {
      expect(transition(state, cfActionCommand(STUDIED, actionAt(proposal, index))).ok).toBe(true);
    }
    const declined = cfSelectTwoLayerFarmerAction(context, raw, options({
      baselineModel: NEVER, challengerModel: NEVER }));
    expect(declined.command).toBe(raw);
    expect(transition(state, declined.command).ok).toBe(true);
  });

  it("is deterministic and blind to the hidden hands (§7.11, §7.12)", () => {
    const { gameSeed, state, context, raw, proposal, rawIndex, counters } = fixture();
    const frozen = options({ baselineModel: ALWAYS, challengerModel: NEVER });
    const first = cfSelectTwoLayerFarmerAction(context, raw, frozen);
    const second = cfSelectTwoLayerFarmerAction(context, raw, frozen);
    // Key equality, not object identity: an override rebuilds its command, so
    // two runs agreeing means agreeing on the cards rather than aliasing one
    // object. (A decline is the case where identity *is* the contract, and it
    // is asserted separately.)
    expect(cfCommandKey(second.command)).toBe(cfCommandKey(first.command));
    expect(second.challengerIndex).toBe(first.challengerIndex);
    expect(second.baselineIndex).toBe(first.baselineIndex);

    const referenceRow = cfRow(
      context.view,
      actionAt(proposal, rawIndex),
      actionAt(proposal, first.baselineIndex),
    );
    const playing = state as PlayingState;
    const baselineOutcome = cfPlayToTerminal(playing, LIGHT_TIERS, gameSeed, { ...counters }).winner;
    let outcomesMoved = 0;
    for (const seed of [1, 2, 3, 4, 5]) {
      const world = redealHidden(playing, STUDIED, seed);
      // The redaction boundary itself: if this drifts, the comparisons below
      // are measuring nothing.
      expect(createPlayerView(world, STUDIED)).toEqual(context.view);
      const worldContext = cfPlayContext(world, STUDIED);
      const outcome = cfSelectTwoLayerFarmerAction(worldContext, raw, frozen);
      expect(cfCommandKey(outcome.command)).toBe(cfCommandKey(first.command));
      expect(outcome.baselineIndex).toBe(first.baselineIndex);
      expect(outcome.challengerIndex).toBe(first.challengerIndex);
      expect(outcome.baselineRows).toBe(first.baselineRows);
      // The features are invariant too. Asserting they *move* would guard the
      // wrong property: `cfRow` takes a redacted view and nothing else, so a
      // world the studied seat cannot see must not change a single column.
      expect(cfRow(
        worldContext.view,
        actionAt(proposal, rawIndex),
        actionAt(proposal, first.baselineIndex),
      )).toEqual(referenceRow);
      // Non-vacuity, the way the v1 leakage guard does it: the re-dealt world
      // is a genuinely different game, and the *terminal outcome* is where that
      // shows up.
      if (cfPlayToTerminal(world, LIGHT_TIERS, gameSeed, { ...counters }).winner
          !== baselineOutcome) {
        outcomesMoved += 1;
      }
    }
    expect(outcomesMoved).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// §7.7 — continuation identity is not winner equality
// ---------------------------------------------------------------------------

/**
 * A single-variant π1 fixture where π1 *demonstrably* fires: the π1 walk and
 * the π0 walk of the same deal diverge, and the capture yields a snapshot.
 *
 * Found by searching, because whether a given farmer root has a two-wide
 * shortlist is a property of the deal and not of anything this file controls.
 * A hard-coded deal would make "the fork resumed π1" pass or fail on which deck
 * someone happened to type.
 */
let piReplayCache: Readonly<{
  spec: CfGroupSpec;
  replay: ReturnType<typeof replayVariant>;
  captured: CfGroupResult;
}> | null = null;

function piReplayFixture(): NonNullable<typeof piReplayCache> {
  if (piReplayCache === null) {
    for (let dealIndex = 50_001; dealIndex < 50_060; dealIndex += 1) {
      const spec = singleVariantPiSpec(dealIndex);
      const variant = spec.variants[0];
      if (variant === undefined) {
        continue;
      }
      const baseline = baselineOf(ALWAYS);
      const replay = replayVariant(
        dealIndex, variant.landlord, variant.studiedSeat, variant.tiers, baseline);
      const underPi0 = cfPlayToTerminal(
        startWithLandlord(dealDeck(spec.dealSeed), variant.landlord),
        variant.tiers, variant.gameSeed, { ...TALLY });
      if (cfTraceDivergence(replay.trace, underPi0) === null) {
        continue;
      }
      const captured = cfPiCaptureGroup(dealDeck(spec.dealSeed), spec, baseline);
      if (captured.snapshots.length === 0) {
        continue;
      }
      piReplayCache = Object.freeze({ spec, replay, captured });
      break;
    }
    if (piReplayCache === null) {
      throw new Error("Guard setup found no deal where π1 both fires and yields a snapshot.");
    }
  }
  return piReplayCache;
}

describe("policy iteration: trace divergence is not winner equality", () => {
  const step = (seat: Seat, index: number) => Object.freeze({ seat, index });
  const trace = (
    winner: Seat,
    commands: readonly string[],
    decisions: readonly Readonly<{ seat: Seat; index: number }>[],
  ): CfForkResult => Object.freeze({ winner, commands, decisions });

  it("accepts a trace that matches element for element", () => {
    const a = trace("human", ["a", "b", "c"],
      [step("ai-one", 3), step("human", 4), step("ai-two", 5)]);
    expect(cfTraceDivergence(a, a)).toBeNull();
  });

  it("rejects a trace whose winner moved", () => {
    expect(cfTraceDivergence(
      trace("human", ["a"], [step("ai-one", 3)]),
      trace("ai-two", ["a"], [step("ai-one", 3)]),
    )).toMatch(/winner/);
  });

  it("rejects the same winner reached by different commands", () => {
    // The whole point: equal win totals can hide different play, and a fork
    // that resumed under the wrong policy looks correct by winner alone.
    expect(cfTraceDivergence(
      trace("human", ["a", "b", "c"], [step("ai-one", 3), step("human", 4), step("ai-two", 5)]),
      trace("human", ["a", "x", "c"], [step("ai-one", 3), step("human", 4), step("ai-two", 5)]),
    )).toMatch(/commands\[1\]/);
  });

  it("rejects a trace whose per-seat decision indices moved", () => {
    expect(cfTraceDivergence(
      trace("human", ["a", "b"], [step("ai-one", 3), step("human", 4)]),
      trace("human", ["a", "b"], [step("ai-one", 4), step("human", 4)]),
    )).toMatch(/decisions\[0\]/);
  });

  it("rejects a trace of the wrong length in either direction", () => {
    const long = trace("human", ["a", "b"], [step("ai-one", 3), step("human", 4)]);
    const short = trace("human", ["a"], [step("ai-one", 3)]);
    expect(cfTraceDivergence(long, short)).toMatch(/commands length/);
    expect(cfTraceDivergence(short, long)).toMatch(/commands length/);
    // Agreeing on every command but not on how many decisions were consumed is
    // still a divergence.
    expect(cfTraceDivergence(
      trace("human", ["a"], [step("ai-one", 3), step("human", 4)]),
      trace("human", ["a"], [step("ai-one", 3)]),
    )).toMatch(/decisions length/);
  });

  it("moves the continuation when π1 replaces π0, so a π0 fork could not pass", () => {
    const { spec, replay } = piReplayFixture();
    const variant = spec.variants[0];
    if (variant === undefined) {
      throw new Error("Guard setup built a spec with no variants.");
    }
    // Same tiers, same seed, same counters — π0 is the only difference. π1
    // really is a different policy on this fixture, so "the fork reproduced the
    // game" is a claim about π1 rather than something any continuation would
    // satisfy.
    const underPi0 = cfPlayToTerminal(
      startWithLandlord(dealDeck(spec.dealSeed), variant.landlord),
      variant.tiers, variant.gameSeed, { ...TALLY });
    expect(cfTraceDivergence(replay.trace, underPi0)).not.toBeNull();
  });

  it("reproduces the variant's own continuation, rebuilt here rather than self-reported (§7.7)", () => {
    const { spec, replay, captured } = piReplayFixture();
    const variant = spec.variants[0];
    if (variant === undefined) {
      throw new Error("Guard setup built a spec with no variants.");
    }
    const baseline = baselineOf(ALWAYS);
    const capturedCheap = captured;
    expect(capturedCheap.snapshots.length).toBeGreaterThan(0);

    for (const snapshot of capturedCheap.snapshots) {
      const root = replay.roots.find((entry) => entry.index === snapshot.meta.seatDecisionIndex);
      if (root === undefined) {
        throw new Error("Guard replay never reached the captured root.");
      }
      const proposal = cfProposal(root.context);
      expect(keysOf(snapshot.meta.seat, proposal)).toEqual(snapshot.candidates.map(
        (candidate) => cfCommandKey(
          cfActionCommand(snapshot.meta.seat, actionAtIn(snapshot, candidate.actionIndex)))));

      const { forks } = cfForkLabels(
        root.state,
        variant.studiedSeat,
        variant.landlord,
        (index) => cfActionCommand(variant.studiedSeat, actionAt(proposal, index)),
        proposal.actions.length,
        snapshot.productionIndex,
        root.counters,
        variant.tiers,
        variant.gameSeed,
        cfPiPolicy(baseline, variant.studiedSeat),
      );
      const referenceFork = forks[snapshot.productionIndex];
      if (referenceFork === undefined) {
        throw new Error("Guard setup forked no reference branch.");
      }
      // Command for command and decision index for decision index, against the
      // continuation this test built — not against what the capture reports
      // about itself.
      expect(cfTraceDivergence(referenceFork, {
        winner: replay.trace.winner,
        commands: Object.freeze(replay.trace.commands.slice(root.step + 1)),
        decisions: Object.freeze(replay.trace.decisions.slice(root.step + 1)),
      })).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// §4, §6, §7.2, §7.6, §7.8 — the π1 policy and capture
// ---------------------------------------------------------------------------

describe("policy iteration: the π1 policy is π0 plus one seat's selector", () => {
  it("leaves other seats and the landlord on plain production, object for object (§7.9)", () => {
    const { state, gameSeed, counters } = fixture();
    const policy = cfPiPolicy(baselineOf(ALWAYS), STUDIED);
    for (const seat of [OTHER, LANDLORD] as const) {
      const context = cfPlayContext(state, seat);
      const raw = cfPolicyCommand(LIGHT_TIERS, gameSeed, seat, context, counters[seat]);
      expect(policy(context, raw)).toBe(raw);
    }
  });

  it("executes exactly what the shipped selector returns at its own seat (§7.15)", () => {
    const { context, raw, proposal, rawIndex } = fixture();
    const baseline = baselineOf(ALWAYS);
    const decision = cfPiDecision(context, raw, STUDIED, baseline);
    expect(decision.overrode).toBe(true);
    expect(decision.executed).not.toBe(raw);
    expect(decision.executedIndex).not.toBe(rawIndex);
    // Independent re-derivation: π1's action is whatever the frozen selector
    // returns for the same context and the same production command.
    expect(cfCommandKey(decision.executed)).toBe(cfCommandKey(
      cfSelectFarmerAction(context, raw, {
        model: baseline.model, threshold: baseline.threshold, seat: STUDIED,
      })));
    expect(cfCommandKey(decision.executed))
      .toBe(keyAt(proposal, STUDIED, decision.executedIndex));
    expect(cfCommandKey(cfPiPolicy(baseline, STUDIED)(context, raw)))
      .toBe(cfCommandKey(decision.executed));
  });

  it("declines — object for object — when π1 has nothing to override", () => {
    const { context, raw } = fixture();
    const decision = cfPiDecision(context, raw, STUDIED, baselineOf(NEVER));
    expect(decision.overrode).toBe(false);
    expect(decision.executed).toBe(raw);
    expect(decision.executedIndex).toBe(-1);
  });

  it("has nowhere to put a π2 model, so the continuation cannot be π2 (§7.8)", () => {
    // The literal claim — "the seam's argument list has no challenger slot" —
    // is a type-level one, and the compiler already enforces it on every call
    // site. There is no runtime assertion that could state it and still be able
    // to fail: `expect(Object.keys(baselineOf(ALWAYS)))` reads this file's own
    // object literal, so it holds for every possible implementation and is
    // evidence about nothing. What *can* fail is the property a π2-shaped leak
    // would actually break — that the continuation has no degree of freedom
    // beyond the frozen record. A challenger reaching the continuation would
    // have to arrive through a second model or a second threshold; the record
    // is the only thing it is given, so every field of that record must be
    // load-bearing.
    const { context, raw } = fixture();
    const atStudied = cfPiPolicy(baselineOf(ALWAYS), STUDIED);
    // Same record, same answer: the policy is a function of (record, context).
    expect(cfCommandKey(atStudied(context, raw)))
      .toBe(cfCommandKey(cfPiPolicy(baselineOf(ALWAYS), STUDIED)(context, raw)));
    // The model is read: this one is above the frozen threshold, so the
    // continuation moves off the production command.
    expect(cfCommandKey(atStudied(context, raw))).not.toBe(cfCommandKey(raw));
    // The threshold is read too, and *this* record's threshold is the one that
    // decides: raising it past `ALWAYS`'s score sends the continuation back to
    // the production command. A seam that scored with the frozen model but
    // compared against a hard-coded `0.01` — a second source of truth for the
    // one number §2 pins — would override here and fail this line.
    const aboveScore = cfPiPolicy(
      Object.freeze({ model: ALWAYS, threshold: CF_PI_THRESHOLD + 1 }), STUDIED);
    expect(cfCommandKey(aboveScore(context, raw))).toBe(cfCommandKey(raw));
    // The behavioural half of the same claim — that the capture's continuation
    // *is* this seam and not something else — is the §7.7 replay above, which
    // rebuilds the continuation through `cfPiPolicy` and matches the capture's
    // forks command for command and decision index for decision index.
  });
});

describe("policy iteration: π1 capture takes b1 as the reference", () => {
  it("keeps the reference's label at zero and records b0 beside it (§7.2)", () => {
    const result = group();
    expect(result.snapshots.length).toBeGreaterThan(0);
    for (const snapshot of result.snapshots) {
      // `productionIndex` keeps its v1 meaning — the action the labels and rows
      // are built against. Under π1 that is `b1`, so its label is zero by
      // construction and the raw production index is a separate field.
      expect(snapshot.labels[snapshot.productionIndex]).toBe(0);
      const rawIndex = snapshot.meta.rawProductionIndex;
      expect(rawIndex).toBeDefined();
      expect(rawIndex).toBeGreaterThanOrEqual(0);
      expect(snapshot.meta.datasetVersion).toBe(CF_PI_DATASET_VERSION);
      // The reference branch reproduced its own game; the capture throws
      // otherwise, so a completed capture is that check having run.
      expect(snapshot.winners[snapshot.productionIndex])
        .toBe(result.variantWinners[snapshot.meta.variantId]);
    }
  });

  it("really overrides somewhere, and keeps the candidate set at C minus b1 (§7.1, §7.3)", () => {
    const result = group();
    let overridden = 0;
    for (const snapshot of result.snapshots) {
      const seat = snapshot.meta.seat;
      const keys = snapshot.candidates.map(
        (candidate) => cfCommandKey(cfActionCommand(seat, actionAtIn(snapshot, candidate.actionIndex))));
      const rawIndex = snapshot.meta.rawProductionIndex;
      if (rawIndex === undefined) {
        throw new Error("Guard setup lost the raw production index.");
      }
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys.length).toBeGreaterThanOrEqual(2);
      const rows = cfRows(snapshot, "train");
      expect(rows.length).toBe(snapshot.candidates.length - 1);
      if (rawIndex === snapshot.productionIndex) {
        continue;
      }
      overridden += 1;
      // `b0` differs from the reference `b1`, so `b0` is a candidate that is
      // *not* the reference — which is exactly the alternative layer 2 must be
      // able to choose. Its presence is what makes the override visible in the
      // data rather than only in the trace.
      expect(keys[rawIndex]).not.toBe(keys[snapshot.productionIndex]);
      const b0Row = rows.find((row) => row.snapshotId === snapshot.meta.snapshotId);
      expect(b0Row).toBeDefined();
      expect(b0Row?.x.length).toBe(86);
    }
    // Non-vacuity: on this fixture the override really happens.
    expect(overridden).toBeGreaterThan(0);
  });

  it("builds every row against b1, and would differ if it were built against b0 (§7.2)", () => {
    const snapshot = group().snapshots.find(
      (candidate) => candidate.meta.rawProductionIndex !== candidate.productionIndex);
    if (snapshot === undefined) {
      throw new Error("Guard setup needs a snapshot whose b1 differs from b0.");
    }
    const rows = cfRows(snapshot, "train");
    const alternatives = snapshot.candidates
      .map((_candidate, index) => index)
      .filter((index) => index !== snapshot.productionIndex);
    const againstB1 = alternatives.map((index) => cfRow(
      snapshot.view,
      candidateActionAt(snapshot, index),
      candidateActionAt(snapshot, snapshot.productionIndex),
    ));
    expect(rows.map((row) => [...row.x])).toEqual(againstB1.map((row) => [...row]));
    // Non-vacuity: the schema's anchor half moves with the reference, so rows
    // built against `b0` cannot be equal to these. This is what makes "the
    // reference is b1" mean something rather than "the reference is whatever
    // was passed in".
    const rawIndex = snapshot.meta.rawProductionIndex ?? 0;
    const againstB0 = alternatives.map((index) => cfRow(
      snapshot.view,
      candidateActionAt(snapshot, index),
      candidateActionAt(snapshot, rawIndex),
    ));
    expect(rows.map((row) => [...row.x])).not.toEqual(againstB0.map((row) => [...row]));
  });

  it("forces one hand per fork and consumes exactly one studied decision per root (§7.6)", () => {
    const result = group();
    // "Force once" is an identity about the forks: every kept snapshot runs one
    // fork per candidate, and no snapshot forces a second hand. A pipeline that
    // forced a candidate and then kept playing under a different policy would
    // show up as a mismatch here.
    const forks = result.snapshots.reduce((sum, snapshot) => sum + snapshot.candidates.length, 0);
    expect(result.forkGames).toBe(forks);

    // "Exactly one decision index consumed" is checked against a replay built
    // in this file rather than against the snapshot's own arithmetic: the
    // metadata's `continuationCounters[seat] === seatDecisionIndex + 1` is true
    // by construction (the capture assigns both from the same counter), so it
    // could never fail. The replay can.
    const spec = singleVariantPiSpec(50_051);
    const variant = spec.variants[0];
    if (variant === undefined) {
      throw new Error("Guard setup built a spec with no variants.");
    }
    const baseline = baselineOf(ALWAYS);
    const replay = replayVariant(
      spec.dealIndex, variant.landlord, variant.studiedSeat, variant.tiers, baseline);
    const capturedSingle = cfPiCaptureGroup(dealDeck(spec.dealSeed), spec, baseline);
    expect(capturedSingle.snapshots.length).toBeGreaterThan(0);
    for (const snapshot of capturedSingle.snapshots) {
      const seat = snapshot.meta.seat;
      const root = replay.roots.find((entry) => entry.index === snapshot.meta.seatDecisionIndex);
      if (root === undefined) {
        throw new Error("Guard replay never consumed this root's decision index.");
      }
      // The index the replay actually spent at this root, and the index the
      // continuation resumes from, as counted by a walk that never saw the
      // snapshot.
      expect(root.counters[seat]).toBe(snapshot.meta.seatDecisionIndex);
      expect(snapshot.meta.continuationCounters[seat]).toBe(root.counters[seat] + 1);
    }
  });

  it("replays a whole π1 capture byte for byte (§7.12)", () => {
    const spec = singleVariantPiSpec(50_031);
    const first = cfPiCaptureGroup(dealDeck(spec.dealSeed), spec, baselineOf(ALWAYS));
    const second = cfPiCaptureGroup(dealDeck(spec.dealSeed), spec, baselineOf(ALWAYS));
    expect(first.snapshots.length).toBeGreaterThan(0);
    expect(JSON.stringify(second.snapshots)).toBe(JSON.stringify(first.snapshots));
    expect(second.variantWinners).toEqual(first.variantWinners);
    expect(second.usefulFarmerRoots).toBe(first.usefulFarmerRoots);
  });

  it("records b0 as the reference when π1 declines everywhere", () => {
    const spec = singleVariantPiSpec(50_032);
    const result = cfPiCaptureGroup(dealDeck(spec.dealSeed), spec, baselineOf(NEVER));
    expect(result.snapshots.length).toBeGreaterThan(0);
    for (const snapshot of result.snapshots) {
      // π1 declined, so `b1` is `b0` and the two indices coincide. A capture
      // that always reported an override would show up here.
      expect(snapshot.meta.rawProductionIndex).toBe(snapshot.productionIndex);
    }
  });

  it("is exactly `cfCaptureGroup` with this round's four frozen options", () => {
    // Spelled out rather than implied: the π1 capture differs from v1's in the
    // policy, the salt, the dataset version and the raw-production recording —
    // and in nothing else. A fifth difference would show up as byte inequality.
    //
    // The deal is searched for, because the *salt* only becomes observable once
    // the group cap binds: a group with three or fewer eligible roots keeps the
    // same snapshots under any salt, and a salt mutation would pass unnoticed.
    let spec: CfGroupSpec | null = null;
    let viaPi: CfGroupResult | null = null;
    const baseline = baselineOf(ALWAYS);
    for (let dealIndex = 50_033; dealIndex < 50_060 && spec === null; dealIndex += 1) {
      const candidate = singleVariantPiSpec(dealIndex);
      const captured = cfPiCaptureGroup(dealDeck(candidate.dealSeed), candidate, baseline);
      if (captured.snapshots.length > 0 && captured.usefulFarmerRoots > captured.snapshots.length) {
        spec = candidate;
        viaPi = captured;
      }
    }
    if (spec === null || viaPi === null) {
      throw new Error("Guard setup found no single-variant deal where the group cap binds.");
    }
    // The cap really binds, so the keyed priority — and therefore the salt —
    // decided which roots were kept.
    expect(viaPi.usefulFarmerRoots).toBeGreaterThan(viaPi.snapshots.length);
    const viaOptions = cfCaptureGroup(dealDeck(spec.dealSeed), spec, {
      policyFor: (variant) => cfPiPolicy(baseline, variant.studiedSeat),
      snapshotSalt: CF_PI_SNAPSHOT_SALT,
      datasetVersion: CF_PI_DATASET_VERSION,
      recordRawProduction: true,
    });
    expect(JSON.stringify(viaPi)).toBe(JSON.stringify(viaOptions));
    // …and the same capture under v1's salt really does keep different roots,
    // so the byte equality above is a statement about the salt and not about a
    // cap that never had to choose.
    const underV1Salt = cfCaptureGroup(dealDeck(spec.dealSeed), spec, {
      policyFor: (variant) => cfPiPolicy(baseline, variant.studiedSeat),
      snapshotSalt: CF_SNAPSHOT_SALT,
      datasetVersion: CF_PI_DATASET_VERSION,
      recordRawProduction: true,
    });
    expect(JSON.stringify(underV1Salt)).not.toBe(JSON.stringify(viaPi));
  });
});

// ---------------------------------------------------------------------------
// §7.15 — the baseline arm is frozen π1, re-derived independently
// ---------------------------------------------------------------------------

describe("policy iteration: baseline identity", () => {
  it("plays the landlord arm identically for both arms, on the real game loop (§5.1)", () => {
    const dealIndex = 50_041;
    const strongSeat: Seat = LANDLORD;
    const profiles = scheduleFor("default", "casual", strongSeat);
    const play = (decorate: (strategy: AiStrategy) => AiStrategy): readonly string[] => {
      const recorder = createRecorder({ logCommands: true });
      playGame(dealDeck(CF_PI_SEED_BASE + dealIndex), strongSeat, profiles, recorder, {
        unboundedEvery: 10,
        seed: dealGameSeed(CF_PI_SEED_BASE + dealIndex, strongSeat, strongSeat),
        designed: true,
        decorate: (seat, strategy) => (seat === strongSeat ? decorate(strategy) : strategy),
      });
      return recorder.commands ?? [];
    };
    const baseline = play((strategy) => createChallengerStrategy(strategy, {
      model: ALWAYS, threshold: CF_PI_THRESHOLD, seat: strongSeat,
    }));
    const challenger = play((strategy) => createTwoLayerStrategy(strategy, {
      baselineModel: ALWAYS, challengerModel: ALWAYS, threshold: CF_PI_THRESHOLD, seat: strongSeat,
    }));
    expect(baseline.length).toBeGreaterThan(0);
    expect(challenger).toEqual(baseline);
  });

  it("re-derives b1 with the frozen selector and matches the baseline arm's own commands (§7.15)", () => {
    // The baseline arm is `createChallengerStrategy` — the same wrapper Gate B
    // measured — and the re-derivation is a separate call to the shipped
    // selector. Every studied-seat decision of a real game must agree, which is
    // the whole of "the baseline arm is frozen π1".
    const studied: Seat = "ai-one";
    // The corpus schedule: `master` at the studied seat, `default` elsewhere.
    // A `default` studied seat would decline at every root and the non-vacuity
    // check at the end of this test would have nothing to find.
    const profiles = scheduleFor("master", "default", studied);

    /** One game of the baseline arm, with every studied decision recorded. */
    const playBaselineArm = (
      dealIndex: number,
    ): readonly Readonly<{ raw: string; played: string; derived: string }>[] => {
      const seen: Array<Readonly<{ raw: string; played: string; derived: string }>> = [];
      const recorder = createRecorder({ logCommands: true });
      playGame(dealDeck(dealIndex), LANDLORD, profiles, recorder, {
        unboundedEvery: 10,
        seed: dealGameSeed(dealIndex, studied, LANDLORD),
        designed: true,
        decorate: (seat, strategy) => {
          if (seat !== studied) {
            return strategy;
          }
          // The wrapped strategy runs exactly once per decision — the arm calls
          // `production.chooseCommand` once — so `captured.raw` is this
          // decision's production command and not a leftover.
          const captured: { raw: GameCommand | null } = { raw: null };
          const arm = createChallengerStrategy(Object.freeze({
            chooseCommand: (context: AiDecisionContext) => {
              const command = strategy.chooseCommand(context);
              captured.raw = command;
              return command;
            },
          }), { model: ALWAYS, threshold: CF_PI_THRESHOLD, seat: studied });
          return Object.freeze({
            chooseCommand: (context: AiDecisionContext) => {
              captured.raw = null;
              const played = arm.chooseCommand(context);
              const raw = captured.raw;
              if (raw === null) {
                throw new Error("Guard setup lost the raw production command.");
              }
              // The independent path: the shipped selector, called here, on the
              // same context and the same production command.
              const derived = cfSelectFarmerAction(context, raw, {
                model: ALWAYS, threshold: CF_PI_THRESHOLD, seat: studied,
              });
              seen.push(Object.freeze({
                raw: cfCommandKey(raw),
                played: cfCommandKey(played),
                derived: cfCommandKey(derived),
              }));
              return played;
            },
          });
        },
      });
      return Object.freeze(seen);
    };

    // Whether a given farmer gets a two-wide shortlist is a property of the
    // deal, so the fixture is searched for rather than typed: a hard-coded
    // index would leave this test's non-vacuity claim resting on a deck nobody
    // re-checks.
    let seen = playBaselineArm(50_042);
    for (let dealIndex = 50_043; dealIndex < 50_080; dealIndex += 1) {
      if (seen.some((decision) => decision.played !== decision.raw)) {
        break;
      }
      seen = playBaselineArm(dealIndex);
    }

    expect(seen.length).toBeGreaterThan(0);
    for (const decision of seen) {
      expect(decision.played).toBe(decision.derived);
    }
    // Non-vacuity: π1 actually changed something in this game, so the equality
    // above is not the trivial case of a selector that never fires.
    expect(seen.some((decision) => decision.played !== decision.raw)).toBe(true);
  });
});
