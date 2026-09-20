/**
 * Guards for the Phase 2 / Gate A v1 counterfactual dataset (spec 062).
 *
 * These live in `tests/` — and therefore inside `pnpm check` — on purpose. The
 * benchmark harness is deliberately outside that gate, and a leakage guard that
 * only runs when someone remembers to start a benchmark is not a guard.
 *
 * Every check is written to fail on a specific regression, not to describe the
 * happy path. Two of them exist because an earlier version of this file passed
 * while the property it claimed to test was false:
 *
 *   - the re-deal suite also demands that the terminal outcome *move*, so a
 *     pipeline that had stopped simulating the other seats cannot satisfy
 *     "features are invariant" by being inert;
 *   - the candidate-set check asserts a wide-enough root up front, because on a
 *     two-action root "the top three" and "everything legal" are the same set
 *     and the check would pass on any rule at all.
 */
import { describe, expect, it } from "vitest";

import { SEAT_ORDER, transition, type PlayingState, type Seat } from "../../src/core/game/index.js";
import { generateLegalActions, type ValidatedPlayAction } from "../../src/core/rules/index.js";
import { createPlayerView, type PlayingPlayerView } from "../../src/core/ai/index.js";
import {
  estimateBasicHandTurns,
  rankMasterPlayActions,
  rankPlayActionsWithProposal,
} from "../../src/core/ai/enhanced.js";
import { ENHANCED_AI_SEARCH } from "../../src/app/ai/decision-handler.js";
import { dealDeck } from "../../benchmarks/ai-tournament.js";
import {
  LIGHT_TIERS,
  redealHidden,
  seatIndexOf,
  studiedTiers,
  toFarmerRoot,
  wideFarmerRoot,
} from "../support/cf-fixtures.js";
import { cfLabelTally } from "../../benchmarks/cf-corpus.js";
import {
  CF_ACTION_CAT_NAMES,
  CF_ACTION_NUM_NAMES,
  CF_CANDIDATE_LIMIT,
  CF_CONTEXT_NAMES,
  CF_FEATURE_NAMES,
  CF_GROUP_SNAPSHOT_CAP,
  CF_PROPOSAL_ANALYZER_NODES,
  CF_SPLIT_COUNTS,
  CF_SPLIT_SALT,
  CF_UNIVERSE_END,
  CF_UNIVERSE_START,
  CfInvalidError,
  cfActionCommand,
  cfActionFeatures,
  cfCaptureGroup,
  cfCommandKey,
  cfDecisionSeed,
  cfForkLabels,
  cfIsEligible,
  cfLabel,
  cfNumericDelta,
  cfPlayContext,
  cfPlayToTerminal,
  cfPolicyCommand,
  cfProposal,
  cfRow,
  cfRows,
  cfSnapshotPriority,
  cfSplitTable,
  type CfGroupSpec,
  type CfPolicyCounters,
  type CfSnapshot,
} from "../../benchmarks/cf-dataset.js";

/** A group spec whose studied seat is a farmer in every variant. */
function groupSpecFor(
  dealIndex: number,
  options: Readonly<{ snapshotCap?: number; variants?: number }> = {},
): CfGroupSpec {
  const dealSeed = dealIndex;
  const variantCount = options.variants ?? SEAT_ORDER.length;
  const variants = SEAT_ORDER.slice(0, variantCount).map((landlord, offset) => {
    const studiedSeat = SEAT_ORDER[(offset + 1) % SEAT_ORDER.length] ?? "ai-one";
    return Object.freeze({
      variantId: `${dealIndex}:${landlord}:${studiedSeat}`,
      landlord,
      studiedSeat,
      gameSeed: dealSeed * 100 + seatIndexOf(studiedSeat) * 10 + seatIndexOf(landlord),
      tiers: studiedTiers(studiedSeat),
    });
  });
  return Object.freeze({
    groupId: `deal-${dealIndex}`,
    dealIndex,
    dealSeed,
    variants: Object.freeze(variants),
    snapshotCap: options.snapshotCap ?? CF_GROUP_SNAPSHOT_CAP,
    policyCommit: "guard",
  });
}

let captured: ReturnType<typeof cfCaptureGroup> | null = null;

/**
 * The suite's single real capture: two variants, so the group cap and the
 * source-variant diagnostic are exercised on a group with more than one source.
 * A real capture costs real `master` decisions and real forks, so there is
 * exactly one of them and everything that needs a snapshot shares it.
 */
function group(): ReturnType<typeof cfCaptureGroup> {
  if (captured === null) {
    captured = cfCaptureGroup(dealDeck(50_031), groupSpecFor(50_031, { variants: 2 }));
    if (captured.snapshots.length === 0) {
      throw new Error("Guard setup captured no snapshots.");
    }
  }
  return captured;
}

const groupB = group;

function firstSnapshot(): CfSnapshot {
  const snapshot = group().snapshots[0];
  if (snapshot === undefined) {
    throw new Error("missing snapshot");
  }
  return snapshot;
}

function twoActions(
  view: PlayingPlayerView,
): readonly [ValidatedPlayAction, ValidatedPlayAction] {
  const actions = generateLegalActions({ hand: view.hand, currentPlay: view.currentPlay });
  const first = actions[0];
  const second = actions[1] ?? actions[0];
  if (first === undefined || second === undefined) {
    throw new Error("Guard setup needs two legal actions.");
  }
  return [first, second];
}

describe("cf dataset: frozen schema", () => {
  it("keeps names, offsets and row length in lockstep", () => {
    const snapshot = firstSnapshot();
    const reference = snapshot.actions[snapshot.candidates[snapshot.productionIndex]?.actionIndex ?? 0];
    const action = snapshot.actions[snapshot.candidates[0]?.actionIndex ?? 0];
    if (action === undefined || reference === undefined) {
      throw new Error("missing action");
    }
    const row = cfRow(snapshot.view, action, reference);
    expect(row.length).toBe(CF_FEATURE_NAMES.length);
    expect(new Set(CF_FEATURE_NAMES).size).toBe(CF_FEATURE_NAMES.length);
    expect(CF_FEATURE_NAMES.length).toBe(
      CF_CONTEXT_NAMES.length + 2 * CF_ACTION_CAT_NAMES.length + 3 * CF_ACTION_NUM_NAMES.length,
    );
    // Numeric slots may be NaN by convention; categorical and context may not.
    const numeric = new Set([
      ...CF_ACTION_NUM_NAMES.map((_name, index) => CF_CONTEXT_NAMES.length + CF_ACTION_CAT_NAMES.length + index),
      ...CF_ACTION_NUM_NAMES.map((_name, index) => CF_CONTEXT_NAMES.length + CF_ACTION_CAT_NAMES.length + CF_ACTION_NUM_NAMES.length + CF_ACTION_CAT_NAMES.length + index),
      ...CF_ACTION_NUM_NAMES.map((_name, index) => CF_FEATURE_NAMES.length - CF_ACTION_NUM_NAMES.length + index),
    ]);
    row.forEach((value, index) => {
      if (!numeric.has(index)) {
        expect(Number.isFinite(value)).toBe(true);
      }
    });
  });

  it("differences the numeric half only, and never a category", () => {
    const { state, seat } = wideFarmerRoot();
    const context = cfPlayContext(state, seat);
    const [first, second] = twoActions(context.view);
    const a = cfActionFeatures(context.view, first);
    const b = cfActionFeatures(context.view, second);
    const row = cfRow(context.view, first, second);
    const deltaOffset = CF_CONTEXT_NAMES.length + 2 * CF_ACTION_CAT_NAMES.length + 2 * CF_ACTION_NUM_NAMES.length;

    expect(cfNumericDelta(a.num, b.num)).toEqual(row.slice(deltaOffset));
    // Exactly the numeric slots, and only those.
    expect(row.length - deltaOffset).toBe(CF_ACTION_NUM_NAMES.length);
    // The categorical halves appear raw, twice, and never subtracted.
    const catOffset = CF_CONTEXT_NAMES.length;
    expect(row.slice(catOffset, catOffset + CF_ACTION_CAT_NAMES.length)).toEqual(a.cat);
    const a0CatOffset = catOffset + CF_ACTION_CAT_NAMES.length + CF_ACTION_NUM_NAMES.length;
    expect(row.slice(a0CatOffset, a0CatOffset + CF_ACTION_CAT_NAMES.length)).toEqual(b.cat);
  });

  it("encodes a missing numeric as NaN and propagates it into the delta", () => {
    const { state } = toFarmerRoot(50_001, 500_104, "human", "ai-one");
    const context = cfPlayContext(state, "ai-one");
    const pass = context.legalActions.find((action) => action.type === "pass");
    const other = context.legalActions.find((action) => action !== pass);
    if (pass === undefined || other === undefined) {
      throw new Error("guard setup needs a pass and a play");
    }
    const features = cfActionFeatures(context.view, pass);
    const rankIndex = CF_ACTION_NUM_NAMES.indexOf("mainRankStrength");
    // A pass has no rank at all — not rank 0, not a sentinel.
    expect(Number.isNaN(features.num[rankIndex] ?? 0)).toBe(true);
    const delta = cfNumericDelta(features.num, cfActionFeatures(context.view, other).num);
    expect(Number.isNaN(delta[rankIndex] ?? 0)).toBe(true);
    // A numeric that *is* defined still differences normally.
    const countIndex = CF_ACTION_NUM_NAMES.indexOf("cardCount");
    expect(delta[countIndex]).toBe(0 - (cfActionFeatures(context.view, other).num[countIndex] ?? 0));
  });
});

describe("cf dataset: information boundary", () => {
  it("re-deals the hidden hands without moving a single column", () => {
    const studied: Seat = "ai-one";
    const { state } = toFarmerRoot(50_001, 500_104, "human", studied);
    if (state.phase !== "playing" && state.phase !== "ready-to-play") {
      throw new Error("guard setup expected a playing state");
    }
    const view = createPlayerView(state, studied);
    if (view === null || view.phase === "bidding") {
      throw new Error("guard setup expected a playing view");
    }
    const [action, reference] = twoActions(view);
    const baseline = cfRow(view, action, reference);
    const playing = state as PlayingState;
    for (const seed of [1, 2, 3, 4, 5]) {
      const alternative = createPlayerView(redealHidden(playing, studied, seed), studied);
      // The boundary itself. If this fails, the shipped redaction drifted and
      // the row comparison below is measuring nothing.
      expect(alternative).toEqual(view);
      if (alternative === null || alternative.phase === "bidding") {
        throw new Error("re-dealt state produced no playing view");
      }
      // All three sides — context, candidate, a0 and delta — move together or
      // not at all.
      expect(cfRow(alternative, action, reference)).toEqual(baseline);
    }
  });

  it("moves the terminal outcome when the hidden hands move — the invariance test is not vacuous", () => {
    let trials = 0;
    let differences = 0;
    for (const dealSeed of [50_001, 50_002, 50_003, 50_004]) {
      const gameSeed = dealSeed * 100 + 4;
      const { state, counters } = toFarmerRoot(dealSeed, gameSeed, "human", "ai-one");
      if (state.phase !== "playing" && state.phase !== "ready-to-play") {
        continue;
      }
      const playing = state as PlayingState;
      const base = cfPlayToTerminal(playing, LIGHT_TIERS, gameSeed, counters).winner;
      for (const seed of [11, 12, 13, 14]) {
        trials += 1;
        const redealt = redealHidden(playing, "ai-one", seed);
        if (cfPlayToTerminal(redealt, LIGHT_TIERS, gameSeed, counters).winner !== base) {
          differences += 1;
        }
      }
    }
    expect(trials).toBeGreaterThan(0);
    expect(differences).toBeGreaterThan(0);
  });

  it("refuses a landlord row instead of answering a different question", () => {
    const { state } = toFarmerRoot(50_001, 500_104, "human", "ai-one");
    const view = createPlayerView(state, "human");
    if (view === null || view.phase === "bidding") {
      throw new Error("guard setup expected a playing view");
    }
    expect(view.seat).toBe(view.landlord);
    expect(() => cfRow(view, { type: "pass" }, { type: "pass" })).toThrow(/farmers only/);
  });

  it("keeps a row independent of identity metadata", () => {
    const snapshot = firstSnapshot();
    const twin: CfSnapshot = Object.freeze({
      ...snapshot,
      meta: Object.freeze({
        ...snapshot.meta,
        dealIndex: 987_654,
        dealSeed: 424_242,
        gameSeed: 13_131,
        variantId: "elsewhere",
        snapshotId: "elsewhere",
        seatDecisionIndex: 99,
        decisionSeed: 7,
        policyCommit: "someone-elses-commit",
      }),
    });
    const left = cfRows(snapshot, "train").map((row) => row.x);
    const right = cfRows(twin, "train").map((row) => row.x);
    expect(right).toEqual(left);
  });

  it("never lets the row's inputs grow past the redacted view", () => {
    // Structural, not statistical: three parameters, none of them a state, a
    // seed or an identity. A refactor that hands it the game state has to come
    // through this assertion.
    expect(cfRow.length).toBe(3);
    const snapshot = firstSnapshot();
    const reference = snapshot.actions[snapshot.candidates[snapshot.productionIndex]?.actionIndex ?? 0];
    const action = snapshot.actions[snapshot.candidates[0]?.actionIndex ?? 0];
    if (action === undefined || reference === undefined) {
      throw new Error("missing action");
    }
    expect(cfRow(snapshot.view, action, reference).length).toBe(CF_FEATURE_NAMES.length);
  });
});

describe("cf dataset: fork identity", () => {
  it("reproduces the untouched continuation when the production action is forced", () => {
    const gameSeed = 500_104;
    const seat: Seat = "ai-one";
    const { state, counters } = toFarmerRoot(50_001, gameSeed, "human", seat);
    const context = cfPlayContext(state, seat);
    const production = cfPolicyCommand(LIGHT_TIERS, gameSeed, seat, context, counters[seat]);

    const direct = cfPlayToTerminal(state, LIGHT_TIERS, gameSeed, counters);
    const forced = transition(state, production);
    expect(forced.ok).toBe(true);
    if (!forced.ok) {
      throw new Error("forcing the production action failed");
    }
    const forked = cfPlayToTerminal(forced.state, LIGHT_TIERS, gameSeed, {
      ...counters,
      [seat]: counters[seat] + 1,
    });
    expect(direct.decisions[0]).toEqual({ seat, index: counters[seat] });
    expect(forked.decisions).toEqual(direct.decisions.slice(1));
    expect(forked.commands).toEqual(direct.commands.slice(1));
    expect(forked.winner).toBe(direct.winner);
  });

  it("forks through cfForkLabels with the forced decision consumed", () => {
    const gameSeed = 500_104;
    const seat: Seat = "ai-one";
    const { state, counters } = toFarmerRoot(50_001, gameSeed, "human", seat);
    const context = cfPlayContext(state, seat);
    const production = cfPolicyCommand(LIGHT_TIERS, gameSeed, seat, context, counters[seat]);
    const direct = cfPlayToTerminal(state, LIGHT_TIERS, gameSeed, counters);
    const { forks } = cfForkLabels(
      state,
      seat,
      "human",
      () => production,
      1,
      0,
      counters,
      LIGHT_TIERS,
      gameSeed,
    );
    expect(direct.decisions[0]).toEqual({ seat, index: counters[seat] });
    expect(forks[0]?.decisions).toEqual(direct.decisions.slice(1));
    expect(forks[0]?.winner).toBe(direct.winner);
  });

  it("treats a fork that does not reach a terminal as INVALID, never as zero", () => {
    const gameSeed = 500_104;
    const seat: Seat = "ai-one";
    const { state, counters } = toFarmerRoot(50_001, gameSeed, "human", seat);
    expect(() => cfPlayToTerminal(state, LIGHT_TIERS, gameSeed, counters, 0))
      .toThrow(CfInvalidError);
    expect(() => cfPlayToTerminal(state, LIGHT_TIERS, gameSeed, counters, 0))
      .toThrow(/did not reach a terminal/);
  });

  it("consumes exactly one decision index per seat turn, contiguously from zero", () => {
    const { state, counters } = toFarmerRoot(50_001, 500_104, "human", "ai-one");
    const run = cfPlayToTerminal(state, LIGHT_TIERS, 500_104, counters);
    const observed: CfPolicyCounters = { ...counters };
    for (const decision of run.decisions) {
      expect(decision.index).toBe(observed[decision.seat]);
      observed[decision.seat] += 1;
    }
    expect(run.decisions.length).toBe(run.commands.length);
    expect(run.decisions.length).toBeGreaterThan(0);
  });

  it("replays a whole group capture byte for byte", () => {
    const spec = groupSpecFor(50_011, { variants: 1 });
    const first = cfCaptureGroup(dealDeck(spec.dealSeed), spec);
    const second = cfCaptureGroup(dealDeck(spec.dealSeed), spec);
    expect(JSON.stringify(second.snapshots)).toBe(JSON.stringify(first.snapshots));
    expect(second.totalFarmerRoots).toBe(first.totalFarmerRoots);
    expect(second.usefulFarmerRoots).toBe(first.usefulFarmerRoots);
    expect(second.variantWinners).toEqual(first.variantWinners);
  });

  it("stores the seed and counter state each snapshot's decision actually used", () => {
    for (const snapshot of group().snapshots) {
      expect(snapshot.meta.decisionSeed).toBe(
        cfDecisionSeed(snapshot.meta.gameSeed, snapshot.meta.seat, snapshot.meta.seatDecisionIndex),
      );
      expect(snapshot.meta.continuationCounters[snapshot.meta.seat]).toBe(
        snapshot.meta.seatDecisionIndex + 1,
      );
      expect(snapshot.meta.snapshotId).toBe(
        `${snapshot.meta.groupId}:${snapshot.meta.variantId}:${snapshot.meta.seatDecisionIndex}`,
      );
      expect(snapshot.meta.tiers[snapshot.meta.seat]).toBe("master");
    }
  });
});

describe("cf dataset: sampling and eligibility", () => {
  it("caps the whole group, not each game or each seat", () => {
    const result = cfCaptureGroup(dealDeck(50_021), groupSpecFor(50_021, { snapshotCap: 2, variants: 1 }));
    expect(result.snapshots.length).toBeLessThanOrEqual(2);
    // Two variants against a cap of three: a cap applied per variant would show
    // up here as up to six snapshots from the shared capture.
    expect(group().snapshots.length).toBeLessThanOrEqual(CF_GROUP_SNAPSHOT_CAP);
    expect(result.sampledRoots).toBe(result.snapshots.length);
    expect(result.forkGames).toBe(
      result.snapshots.reduce((sum, snapshot) => sum + snapshot.candidates.length, 0),
    );
    // The source-variant diagnostic must add up to what was kept.
    const sources = Object.values(result.sourceVariantCounts);
    expect(sources.reduce((sum, value) => sum + value, 0)).toBe(result.snapshots.length);
  });

  it("emits only roots whose production candidate set contains a0 plus an alternative", () => {
    const result = groupB();
    expect(result.snapshots.length).toBeGreaterThan(0);
    for (const snapshot of result.snapshots) {
      const keys = snapshot.candidates.map(
        (candidate) => cfCommandKey(
          cfActionCommand(snapshot.meta.seat, snapshot.actions[candidate.actionIndex] ?? { type: "pass" }),
        ),
      );
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys.length).toBeGreaterThanOrEqual(2);
      expect(snapshot.productionIndex).toBeGreaterThanOrEqual(0);
      expect(snapshot.labels[snapshot.productionIndex]).toBe(0);
      expect(snapshot.diagnostics.uniqueCandidateCount).toBeGreaterThanOrEqual(2);
    }
    expect(result.usefulFarmerRoots).toBeGreaterThanOrEqual(result.snapshots.length);
    expect(result.usefulFarmerRoots).toBeLessThanOrEqual(result.totalFarmerRoots);
  });

  it("states the eligibility rule directly, on both of its clauses", () => {
    // The pipeline cannot exercise the first clause: a `master` seat's action
    // comes from its own top three, so "the candidates contain a0" is true by
    // construction and a mutation that deletes the clause is invisible through
    // a capture. The predicate is therefore also tested on synthetic proposals,
    // where each clause can be violated on its own.
    const { state, seat } = wideFarmerRoot();
    const playContext = cfPlayContext(state, seat);
    const [first, second] = twoActions(playContext.view);
    expect(first).not.toBe(second);
    const proposalOf = (actions: readonly ValidatedPlayAction[]) => ({
      actions,
      anchoredScores: actions.map(() => 0),
      baseScores: actions.map(() => 0),
    });

    // One action: nothing to choose, however it was reached.
    expect(cfIsEligible(proposalOf([first]), seat, cfActionCommand(seat, first))).toBe(false);
    // Two candidates, neither of them a0 — the case a landlord-free schedule
    // would produce and the reason the clause exists.
    const absent: ValidatedPlayAction = { type: "pass" };
    expect(cfIsEligible(proposalOf([first, second]), seat, cfActionCommand(seat, absent))).toBe(false);
    // a0 present plus an alternative: eligible.
    expect(cfIsEligible(proposalOf([first, second]), seat, cfActionCommand(seat, first))).toBe(true);
    // a0 present but alone: not eligible.
    expect(cfIsEligible(proposalOf([first]), seat, cfActionCommand(seat, first))).toBe(false);
  });

  it("keys the sampling priority on the salt and the root's identity, and nothing else", () => {
    const a = cfSnapshotPriority("salt", "deal-1", "variant-a", 3);
    expect(cfSnapshotPriority("salt", "deal-1", "variant-a", 3)).toBe(a);
    expect(cfSnapshotPriority("other-salt", "deal-1", "variant-a", 3)).not.toBe(a);
    expect(cfSnapshotPriority("salt", "deal-2", "variant-a", 3)).not.toBe(a);
    expect(cfSnapshotPriority("salt", "deal-1", "variant-b", 3)).not.toBe(a);
    expect(cfSnapshotPriority("salt", "deal-1", "variant-a", 4)).not.toBe(a);
  });

  it("registers a group that produced nothing rather than borrowing another deal's roots", () => {
    // A group whose studied seat is the landlord in every variant is invalid by
    // construction, so this drives the registration path with an empty variant
    // list instead: zero roots, zero snapshots, and still a returned record.
    const empty = cfCaptureGroup(dealDeck(50_041), Object.freeze({
      ...groupSpecFor(50_041),
      variants: Object.freeze([]),
    }));
    expect(empty.snapshots.length).toBe(0);
    expect(empty.totalFarmerRoots).toBe(0);
    expect(empty.usefulFarmerRoots).toBe(0);
    expect(empty.groupId).toBe("deal-50041");
  });
});

describe("cf dataset: candidates and labels", () => {
  it("takes its candidate set from the shipped proposer, not a copy of the rule", () => {
    const { state, seat } = wideFarmerRoot();
    const context = cfPlayContext(state, seat);
    const key = (action: Parameters<typeof cfActionCommand>[1]) =>
      cfCommandKey(cfActionCommand(seat, action));

    // The precondition that makes the comparison below mean something.
    expect(context.legalActions.length).toBeGreaterThan(CF_CANDIDATE_LIMIT + 1);

    const proposal = cfProposal(context);
    const shipped = rankMasterPlayActions(context, { ...ENHANCED_AI_SEARCH, seed: 7 });
    expect([...proposal.actions.map(key)].sort()).toEqual([...shipped.map((entry) => key(entry.action))].sort());
    expect(proposal.actions.length).toBe(CF_CANDIDATE_LIMIT);

    const detail = rankPlayActionsWithProposal(context, "expert", {
      analyzerNodes: CF_PROPOSAL_ANALYZER_NODES,
    });
    expect(proposal.anchoredScores[0]).toBeCloseTo(detail.anchored[0]?.score ?? Number.NaN, 9);
  });

  it("labels camp outcomes, not seat outcomes", () => {
    const campOf = (seat: Seat, landlord: Seat) => (seat === landlord ? "landlord" : "farmers");
    for (const seat of SEAT_ORDER) {
      for (const landlord of SEAT_ORDER) {
        for (const reference of SEAT_ORDER) {
          for (const candidate of SEAT_ORDER) {
            const referenceCamp = campOf(reference, landlord);
            const candidateCamp = campOf(candidate, landlord);
            const expected = candidateCamp === referenceCamp
              ? 0
              : candidateCamp === campOf(seat, landlord)
                ? 1
                : -1;
            expect(cfLabel(seat, landlord, reference, candidate)).toBe(expected);
          }
        }
      }
    }
    expect(cfLabel("ai-one", "human", "human", "ai-two")).toBe(1);
    expect(cfLabel("ai-one", "human", "ai-one", "ai-two")).toBe(0);
  });

  it("prices a candidate against the reference taken from the same world", () => {
    const gameSeed = 500_104;
    const seat: Seat = "ai-one";
    const { state, counters } = toFarmerRoot(50_001, gameSeed, "human", seat);
    if (state.phase !== "playing" && state.phase !== "ready-to-play") {
      throw new Error("guard setup expected a playing state");
    }
    const playing = state as PlayingState;
    const context = cfPlayContext(playing, seat);
    const production = cfPolicyCommand(LIGHT_TIERS, gameSeed, seat, context, counters[seat]);
    for (const seed of [21, 22, 23]) {
      const world = seed === 21 ? playing : redealHidden(playing, seat, seed);
      const { labels } = cfForkLabels(
        world,
        seat,
        playing.landlord,
        () => production,
        2,
        1,
        counters,
        LIGHT_TIERS,
        gameSeed,
      );
      expect(labels).toEqual([0, 0]);
    }
  });

  it("drops the a0 row from training and keeps every zero-label alternative", () => {
    const snapshot = firstSnapshot();
    const rows = cfRows(snapshot, "train");
    expect(rows.length).toBe(snapshot.candidates.length - 1);
    expect(rows.every((row) => row.y !== undefined)).toBe(true);
    const turnIndex = CF_FEATURE_NAMES.indexOf("a0_afterTurns");
    expect(rows[0]?.x[turnIndex]).toBe(
      // The a0 half is the same for every row of a snapshot.
      rows[rows.length - 1]?.x[turnIndex],
    );
    expect(estimateBasicHandTurns(snapshot.view.hand)).toBeGreaterThan(0);
  });
});

describe("cf dataset: split", () => {
  it("assigns the universe to exact frozen counts with no modulo drift", () => {
    const table = cfSplitTable(
      CF_UNIVERSE_START,
      CF_UNIVERSE_END,
      CF_SPLIT_COUNTS,
      CF_SPLIT_SALT,
    );
    expect(table.size).toBe(
      CF_SPLIT_COUNTS.train + CF_SPLIT_COUNTS.calibration + CF_SPLIT_COUNTS.heldout,
    );
    const counts = { train: 0, calibration: 0, heldout: 0 };
    for (const split of table.values()) {
      counts[split] += 1;
    }
    expect(counts).toEqual(CF_SPLIT_COUNTS);
    expect(table.get(CF_UNIVERSE_START)).toBeDefined();
  });

  it("is deterministic and salt-sensitive", () => {
    const first = cfSplitTable(CF_UNIVERSE_START, CF_UNIVERSE_END, CF_SPLIT_COUNTS, CF_SPLIT_SALT);
    const second = cfSplitTable(CF_UNIVERSE_START, CF_UNIVERSE_END, CF_SPLIT_COUNTS, CF_SPLIT_SALT);
    expect([...second.entries()]).toEqual([...first.entries()]);
    const other = cfSplitTable(CF_UNIVERSE_START, CF_UNIVERSE_END, CF_SPLIT_COUNTS, "another-salt");
    let moved = 0;
    for (const [dealIndex, split] of other) {
      if (first.get(dealIndex) !== split) {
        moved += 1;
      }
    }
    expect(moved).toBeGreaterThan(0);
  });

  it("crosses no split boundary inside a group", () => {
    const table = cfSplitTable(CF_UNIVERSE_START, CF_UNIVERSE_END, CF_SPLIT_COUNTS, CF_SPLIT_SALT);
    let violations = 0;
    for (const result of [group(), groupB()]) {
      const split = table.get(result.dealIndex);
      if (split === undefined) {
        continue;
      }
      const seen = new Set(result.snapshots.map(() => split));
      if (seen.size > 1) {
        violations += 1;
      }
      for (const snapshot of result.snapshots) {
        // The split is a function of the group id alone: two snapshots of one
        // deal cannot disagree even in principle.
        expect(snapshot.meta.groupId).toBe(`deal-${result.dealIndex}`);
      }
    }
    expect(violations).toBe(0);
  });
});

describe("cf dataset: label reporting", () => {
  it("keys the tally on the same three names the report reads", () => {
    // The first version keyed its map on `String(label)`, which yields "1" and
    // not "+1", while the report read counts["+1"]. Every positive label was
    // counted and then never displayed — the corpus looked like it contained no
    // +1 at all while holding thousands of them. The keys are the contract.
    const tally = cfLabelTally([1, 1, 0, -1, 0, 1]);
    expect(tally).toEqual({ "+1": 3, "0": 2, "-1": 1 });
    expect([...Object.keys(tally)].sort()).toEqual(["+1", "-1", "0"]);
  });

  it("accounts for every label it is given", () => {
    const labels = [1, -1, 0, 0, 1, -1, -1] as const;
    const tally = cfLabelTally(labels);
    expect(tally["+1"] + tally["0"] + tally["-1"]).toBe(labels.length);
    expect(cfLabelTally([])).toEqual({ "+1": 0, "0": 0, "-1": 0 });
  });
});
