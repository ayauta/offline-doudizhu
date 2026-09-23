/**
 * Factory v1 chain guards — the §35 once-only contract and the §36 π1 identity
 * gate.
 *
 * §36 is a stop condition, not a nicety: if a depth-one chain does not
 * reproduce the frozen `ai-v1` command for command, the Factory must not start
 * the π2 corpus, because every later generation is defined as "the champion,
 * plus one layer" and a chain that cannot reproduce its own base has no base.
 * The strong form of the claim is the corpus-level test at the bottom of this
 * file: the whole capture — visit, fork, continuation, labels, sampled roots —
 * byte-identical to what the frozen selector produces under the same options.
 *
 * Not one fresh seed is dealt here. Every deal index used is retired.
 */
import { describe, expect, it } from "vitest";

import type { GameCommand, Seat } from "../../src/core/game/index.js";
import type { AiDecisionContext } from "../../src/core/ai/index.js";
import {
  cfProposal,
  cfSelectFarmerAction,
  type CfProposal,
  type TreeModel,
} from "../../src/app/ai/cf-selector.js";
import { parseTreeModel } from "../../src/core/ai/cf-model.js";
import { CF_FEATURE_NAMES } from "../../src/core/ai/cf-features.js";
import {
  CF_GROUP_SNAPSHOT_CAP,
  cfCaptureGroup,
  cfPlayContext,
  cfPolicyCommand,
  type CfPolicy,
} from "../../benchmarks/cf-dataset.js";
import { cfPiFrozenBaseline } from "../../benchmarks/cf-pi-corpus.js";
import { cfPiPolicy, cfSelectTwoLayerFarmerAction } from "../../benchmarks/cf-policy-iteration.js";
import { dealDeck } from "../../benchmarks/ai-tournament.js";
import {
  assertChainShape,
  cfChainPolicy,
  cfSelectChainFarmerAction,
  chainDepth,
  cumulativeModelBytes,
  type ChainLayer,
  type ChampionChain,
} from "../../benchmarks/farmer-pi-chain.js";
import {
  FACTORY_DATASET_VERSION,
  FACTORY_SNAPSHOT_SALT,
  factoryCaptureGroup,
  factoryGroupSpecFor,
  type FactoryPoolRef,
} from "../../benchmarks/farmer-pi-corpus.js";
import { frozenPi1Chain, parseChampionArchive, researchChampionId } from "../../benchmarks/farmer-pi-champions.js";
import { LIGHT_TIERS, studiedTiers, toFarmerRoot } from "../support/cf-fixtures.js";

/** The play variant of a decision context — the only kind a chain ever sees. */
type PlayContext = Extract<AiDecisionContext, { readonly kind: "play" }>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A model that scores every row the same number. The override is then decided
 * entirely by the threshold, which is how the two boundary branches get
 * exercised on real roots without hunting for a deal where the real model
 * happens to cross 0.01.
 */
function constantModel(value: number, sha = `guard-constant-${value}`): TreeModel {
  return parseTreeModel({
    formatVersion: 1,
    lightgbmVersion: "guard",
    modelSha256: sha,
    numTrees: 1,
    numFeatures: CF_FEATURE_NAMES.length,
    featureNames: [...CF_FEATURE_NAMES],
    trees: [{
      feature: [-1],
      threshold: [0],
      defaultLeft: [0],
      missingZero: [0],
      left: [0],
      right: [0],
      value: [value],
    }],
  } as Parameters<typeof parseTreeModel>[0]);
}

function layerOf(model: TreeModel, threshold: number): ChainLayer {
  return Object.freeze({
    modelSha256: model.modelSha256,
    model,
    threshold,
    modelBytes: 1_024,
  });
}

function chainOf(championId: string, layers: readonly ChainLayer[]): ChampionChain {
  return Object.freeze({
    championId,
    parentChampionId: championId === "ai-v1" ? null : "ai-v1",
    layers: Object.freeze([...layers]),
    baseMasterVersion: "master-v1",
    top3Version: "expert-top3-anchored-v1",
    schemaHash: "guard",
  });
}

const ALWAYS = constantModel(10);
const NEVER = constantModel(-10);

/** Retired deal indices. Discovery V1 (301–700) and the Phase 2 v1 dataset. */
const RETIRED_DEALS: readonly number[] = Object.freeze([
  301, 302, 303, 304, 305, 306, 307, 308,
  50_011, 50_012, 50_013, 50_014,
]);

type RootCase = Readonly<{
  dealIndex: number;
  seat: Seat;
  context: PlayContext;
  /** The production action at this root, computed once. Deterministic, so
   *  caching it changes nothing except how long the guards take. */
  production: GameCommand;
  counters: Readonly<Record<Seat, number>>;
}>;

/**
 * Real arm-B roots from retired deals: the studied seat is a farmer, and its
 * own tier is `master` so the production action is the one a real capture would
 * have started from.
 */
function realRoots(): readonly RootCase[] {
  const cases: RootCase[] = [];
  for (const dealIndex of RETIRED_DEALS) {
    for (const landlord of ["human", "ai-one", "ai-two"] as const) {
      const studied = (["human", "ai-one", "ai-two"] as const).find(
        (seat) => seat !== landlord,
      );
      if (studied === undefined) {
        continue;
      }
      const gameSeed = dealIndex * 100 + 10;
      const tiers = studiedTiers(studied);
      const { state, counters } = toFarmerRoot(dealIndex, gameSeed, landlord, studied, tiers);
      const context = cfPlayContext(state, studied);
      cases.push(Object.freeze({
        dealIndex,
        seat: studied,
        context,
        production: cfPolicyCommand(tiers, gameSeed, studied, context, counters[studied]),
        counters: Object.freeze({ ...counters }),
      }));
    }
  }
  return Object.freeze(cases);
}

const ROOTS = realRoots();

function productionOf(caseRoot: RootCase): GameCommand {
  return caseRoot.production;
}

/**
 * An outcome with its wall-clock fields removed. `layerInferenceMs` is real
 * time and can never be part of an equality assertion; everything else the
 * chain returns is a deterministic function of the context.
 */
function stable(outcome: ReturnType<typeof cfSelectChainFarmerAction>): string {
  const { layerInferenceMs, ...rest } = outcome;
  void layerInferenceMs;
  return JSON.stringify(rest);
}

function countingProposal(): Readonly<{
  proposalOf: (context: PlayContext) => CfProposal;
  calls: () => number;
}> {
  let calls = 0;
  return Object.freeze({
    proposalOf: (context: PlayContext) => {
      calls += 1;
      return cfProposal(context);
    },
    calls: () => calls,
  });
}

// ---------------------------------------------------------------------------
// §36 — the π1 identity gate
// ---------------------------------------------------------------------------

describe("the depth-one chain is the frozen selector", () => {
  it("agrees with cfSelectFarmerAction on every retired root, for both override branches", () => {
    expect(ROOTS.length).toBeGreaterThan(20);
    const pi1 = frozenPi1Chain();
    let overrides = 0;
    for (const caseRoot of ROOTS) {
      const production = productionOf(caseRoot);
      const chainOutcome = cfSelectChainFarmerAction(caseRoot.context, production, {
        chain: pi1,
        seat: caseRoot.seat,
      });
      const selector = cfSelectFarmerAction(caseRoot.context, production, {
        model: pi1.layers[0]!.model,
        threshold: pi1.layers[0]!.threshold,
        seat: caseRoot.seat,
      });
      expect(JSON.stringify(chainOutcome.command)).toBe(JSON.stringify(selector));
      if (JSON.stringify(selector) !== JSON.stringify(production)) {
        overrides += 1;
      }
    }
    expect(overrides).toBeGreaterThan(0);
  }, 300000);

  it("agrees on a constant model that always overrides, and one that never does", () => {
    for (const model of [ALWAYS, NEVER]) {
      const chain = chainOf("ai-v1", [layerOf(model, 0.01)]);
      for (const caseRoot of ROOTS) {
        const production = productionOf(caseRoot);
        const chainOutcome = cfSelectChainFarmerAction(caseRoot.context, production, {
          chain,
          seat: caseRoot.seat,
        });
        const selector = cfSelectFarmerAction(caseRoot.context, production, {
          model,
          threshold: 0.01,
          seat: caseRoot.seat,
        });
        expect(JSON.stringify(chainOutcome.command)).toBe(JSON.stringify(selector));
      }
    }
  }, 300000);

  it("keeps the frozen threshold exactly — 0.01 is not a re-typed literal", () => {
    const pi1 = frozenPi1Chain();
    expect(pi1.layers[0]!.threshold).toBe(0.01);
    // Strictly above, both at the boundary and one ulp over it.
    const atBoundary = constantModel(0.01);
    const justOver = constantModel(0.01 + 1e-9);
    for (const [model, expected] of [[atBoundary, false], [justOver, true]] as const) {
      const chain = chainOf("ai-v1", [layerOf(model, pi1.layers[0]!.threshold)]);
      const caseRoot = ROOTS[0]!;
      const production = productionOf(caseRoot);
      const outcome = cfSelectChainFarmerAction(caseRoot.context, production, {
        chain,
        seat: caseRoot.seat,
      });
      const changed = JSON.stringify(outcome.command) !== JSON.stringify(production);
      if (changed !== expected) {
        // The root may simply have no alternative that clears the bar, in which
        // case an override is impossible for either model. Only assert when the
        // root *can* override.
        const selector = cfSelectFarmerAction(caseRoot.context, production, {
          model: justOver,
          threshold: pi1.layers[0]!.threshold,
          seat: caseRoot.seat,
        });
        expect(JSON.stringify(selector) === JSON.stringify(production)).toBe(true);
      }
    }
  }, 300000);

  it("reproduces the frozen π1 capture byte for byte, forks and labels included", () => {
    const pool: FactoryPoolRef = Object.freeze({
      poolId: "rehearsal:discovery-v1",
      purpose: "train",
      range: Object.freeze({ start: 301, end: 700 }),
    });
    const baseline = cfPiFrozenBaseline();
    const pi1 = frozenPi1Chain();
    let captured = 0;
    let overridden = 0;
    for (const dealIndex of [301, 302, 303]) {
      const spec = factoryGroupSpecFor(dealIndex, pool, "chain-guard");
      const shared = {
        snapshotSalt: FACTORY_SNAPSHOT_SALT,
        datasetVersion: FACTORY_DATASET_VERSION,
        recordRawProduction: true,
      } as const;
      const viaSelector = cfCaptureGroup(dealDeck(dealIndex), spec, {
        ...shared,
        policyFor: (variant) => cfPiPolicy(baseline, variant.studiedSeat),
      });
      const viaChain = factoryCaptureGroup(dealDeck(dealIndex), spec, pi1);
      expect(JSON.stringify(viaChain)).toBe(JSON.stringify(viaSelector));
      captured += viaChain.snapshots.length;
      for (const snapshot of viaChain.snapshots) {
        if (snapshot.meta.rawProductionIndex !== snapshot.productionIndex) {
          overridden += 1;
        }
      }
    }
    expect(captured).toBeGreaterThan(0);
    // Non-vacuity: the identity above is only interesting if the reference and
    // the raw production action actually came apart somewhere in the sample.
    expect(overridden).toBeGreaterThan(0);
  }, 300000);
});

// ---------------------------------------------------------------------------
// §35 — the once-only contract
// ---------------------------------------------------------------------------

describe("one master decision, one top three, every layer", () => {
  it("proposes exactly once per decision, whatever the depth", () => {
    for (const depth of [1, 2, 3, 4]) {
      const layers = Array.from({ length: depth }, (_, index) => layerOf(ALWAYS, 0.01 + index));
      const chain = chainOf("ai-v2-research", layers);
      for (const caseRoot of ROOTS) {
        const counted = countingProposal();
        const production = productionOf(caseRoot);
        const outcome = cfSelectChainFarmerAction(caseRoot.context, production, {
          chain,
          seat: caseRoot.seat,
          proposalOf: counted.proposalOf,
        });
        expect(counted.calls()).toBe(outcome.proposals);
        expect(counted.calls()).toBeLessThanOrEqual(1);
      }
    }
  }, 300000);

  it("scores |C3| - 1 candidates per layer, all of them, always", () => {
    const chain = chainOf("ai-v2-research", [layerOf(NEVER, 0.01), layerOf(NEVER, 0.01)]);
    for (const caseRoot of ROOTS) {
      const proposal = cfProposal(caseRoot.context);
      const production = productionOf(caseRoot);
      const outcome = cfSelectChainFarmerAction(caseRoot.context, production, {
        chain,
        seat: caseRoot.seat,
      });
      for (const rows of outcome.layerRows) {
        expect(rows).toBe(proposal.actions.length - 1);
      }
      expect(outcome.totalRows).toBe(2 * (proposal.actions.length - 1));
    }
  }, 300000);

  it("hands every layer the identical proposal object", () => {
    // The wrapper hands out a frozen object per call; two calls would produce
    // two different objects and the count would be two.
    let calls = 0;
    const handed: CfProposal[] = [];
    const chain = chainOf("ai-v2-research", [layerOf(ALWAYS, 0.01), layerOf(ALWAYS, 0.01), layerOf(ALWAYS, 0.01)]);
    for (const caseRoot of ROOTS) {
      handed.length = 0;
      calls = 0;
      const production = productionOf(caseRoot);
      cfSelectChainFarmerAction(caseRoot.context, production, {
        chain,
        seat: caseRoot.seat,
        proposalOf: (context) => {
          calls += 1;
          const proposal = cfProposal(context);
          handed.push(proposal);
          return proposal;
        },
      });
      expect(calls).toBe(1);
      expect(handed).toHaveLength(1);
    }
  }, 300000);

  it("points layer two at layer one's action, not at production's", () => {
    // A flat model picks the *smallest* index other than its reference. So on a
    // three-candidate root whose production action is index 0, two flat layers
    // must walk 0 -> 1 -> 0. If layer two had been handed b0 instead of b1 it
    // would have walked 0 -> 1 -> 1, and the index trace says which happened
    // without depending on whether the two actions happen to be different
    // cards.
    const chain = chainOf("ai-v2-research", [layerOf(ALWAYS, 0.01), layerOf(ALWAYS, 0.01)]);
    let sawThreeCandidates = 0;
    for (const caseRoot of ROOTS) {
      const production = productionOf(caseRoot);
      const proposal = cfProposal(caseRoot.context);
      const outcome = cfSelectChainFarmerAction(caseRoot.context, production, {
        chain,
        seat: caseRoot.seat,
      });
      if (outcome.rawIndex !== 0 || proposal.actions.length !== 3) {
        continue;
      }
      sawThreeCandidates += 1;
      expect(outcome.layerIndexes).toEqual([1, 0]);
    }
    expect(sawThreeCandidates).toBeGreaterThan(0);
  }, 300000);

  it("matches cfSelectTwoLayerFarmerAction on every retired root", () => {
    const combinations: ReadonlyArray<readonly [TreeModel, TreeModel, number]> = Object.freeze([
      Object.freeze([ALWAYS, NEVER, 0.01] as const),
      Object.freeze([NEVER, ALWAYS, 0.01] as const),
      Object.freeze([ALWAYS, ALWAYS, 0.01] as const),
      Object.freeze([NEVER, NEVER, 0.01] as const),
      Object.freeze([constantModel(0.02), constantModel(0.005), 0.01] as const),
    ]);
    let overrides = 0;
    for (const [baseline, challenger, threshold] of combinations) {
      const chain = chainOf("ai-v2-research", [
        layerOf(baseline, threshold),
        layerOf(challenger, threshold),
      ]);
      for (const caseRoot of ROOTS) {
        const production = productionOf(caseRoot);
        const viaChain = cfSelectChainFarmerAction(caseRoot.context, production, {
          chain,
          seat: caseRoot.seat,
        });
        const viaTwoLayer = cfSelectTwoLayerFarmerAction(caseRoot.context, production, {
          baselineModel: baseline,
          challengerModel: challenger,
          threshold,
          seat: caseRoot.seat,
        });
        expect(JSON.stringify(viaChain.command)).toBe(JSON.stringify(viaTwoLayer.command));
        if (JSON.stringify(viaChain.command) !== JSON.stringify(production)) {
          overrides += 1;
        }
      }
    }
    expect(overrides).toBeGreaterThan(0);
  }, 300000);

  it("lets an inner decline leave the outer action standing", () => {
    const chain = chainOf("ai-v2-research", [layerOf(ALWAYS, 0.01), layerOf(NEVER, 0.01)]);
    let sawOuterOverride = 0;
    for (const caseRoot of ROOTS) {
      const production = productionOf(caseRoot);
      const layer1 = cfSelectChainFarmerAction(caseRoot.context, production, {
        chain: chainOf("ai-v1", [layerOf(ALWAYS, 0.01)]),
        seat: caseRoot.seat,
      });
      if (JSON.stringify(layer1.command) === JSON.stringify(production)) {
        continue;
      }
      sawOuterOverride += 1;
      const both = cfSelectChainFarmerAction(caseRoot.context, production, {
        chain,
        seat: caseRoot.seat,
      });
      // A declining layer 2 must leave layer 1's action, never production's.
      expect(JSON.stringify(both.command)).toBe(JSON.stringify(layer1.command));
      expect(JSON.stringify(both.command)).not.toBe(JSON.stringify(production));
      expect(both.layerOverrode).toEqual([true, false]);
      expect(both.layerIndexes[0]).toBe(both.layerIndexes[1]);
    }
    expect(sawOuterOverride).toBeGreaterThan(0);
  }, 300000);

  it("breaks ties to the earlier candidate of the shared top three", () => {
    // A model that returns the same score for every candidate: the winner must
    // be the smallest index other than the reference, which is the frozen rule.
    const flat = constantModel(5);
    const chain = chainOf("ai-v1", [layerOf(flat, 0.01)]);
    for (const caseRoot of ROOTS) {
      const production = productionOf(caseRoot);
      const outcome = cfSelectChainFarmerAction(caseRoot.context, production, {
        chain,
        seat: caseRoot.seat,
      });
      if (!outcome.overrode) {
        continue;
      }
      const proposal = cfProposal(caseRoot.context);
      const expected = proposal.actions.findIndex((_, index) => index !== outcome.rawIndex);
      expect(outcome.layerIndexes[0]).toBe(expected);
    }
  }, 300000);
});

// ---------------------------------------------------------------------------
// Scope: the seats, the roles and the disabled path
// ---------------------------------------------------------------------------

describe("the chain touches exactly one farmer seat", () => {
  it("returns the production object itself on a landlord root", () => {
    const chain = chainOf("ai-v1", [layerOf(ALWAYS, 0.01)]);
    let landlordRoots = 0;
    for (const dealIndex of [301, 302, 303, 304]) {
      const gameSeed = dealIndex * 100 + 10;
      const landlord: Seat = "human";
      const { state, counters } = toFarmerRoot(dealIndex, gameSeed, landlord, landlord, LIGHT_TIERS);
      const context = cfPlayContext(state, landlord);
      const production = cfPolicyCommand(LIGHT_TIERS, gameSeed, landlord, context, counters[landlord]);
      const outcome = cfSelectChainFarmerAction(context, production, {
        chain,
        seat: landlord,
      });
      // Identity, not equality: the landlord path must not even rebuild it.
      expect(outcome.command).toBe(production);
      expect(outcome.proposals).toBe(0);
      landlordRoots += 1;
    }
    expect(landlordRoots).toBeGreaterThan(0);
  }, 300000);

  it("returns the production object itself on a seat it is not bound to", () => {
    const chain = chainOf("ai-v1", [layerOf(ALWAYS, 0.01)]);
    for (const caseRoot of ROOTS.slice(0, 6)) {
      const other = (["human", "ai-one", "ai-two"] as const).find(
        (seat) => seat !== caseRoot.seat,
      )!;
      const production = productionOf(caseRoot);
      const outcome = cfSelectChainFarmerAction(caseRoot.context, production, {
        chain,
        seat: other,
      });
      expect(outcome.command).toBe(production);
      expect(outcome.proposals).toBe(0);
    }
  }, 300000);

  it("does no work at all when disabled", () => {
    const chain = chainOf("ai-v1", [layerOf(ALWAYS, 0.01)]);
    for (const caseRoot of ROOTS.slice(0, 6)) {
      const counted = countingProposal();
      const production = productionOf(caseRoot);
      const outcome = cfSelectChainFarmerAction(caseRoot.context, production, {
        chain,
        seat: caseRoot.seat,
        enabled: false,
        proposalOf: counted.proposalOf,
      });
      expect(outcome.command).toBe(production);
      expect(counted.calls()).toBe(0);
    }
  }, 300000);

  it("is blind to the two hidden hands", () => {
    const chain = chainOf("ai-v2-research", [layerOf(ALWAYS, 0.01), layerOf(ALWAYS, 0.02)]);
    for (const caseRoot of ROOTS.slice(0, 8)) {
      const production = productionOf(caseRoot);
      const first = cfSelectChainFarmerAction(caseRoot.context, production, {
        chain,
        seat: caseRoot.seat,
      });
      expect(JSON.stringify(first.command)).toBe(JSON.stringify(productionOf(caseRoot)));
      // The chain reads only `view`, and `cfRow` refuses everything else; the
      // dataset-level re-deal guard is `cf-dataset-guards.test.ts`. What is
      // asserted here is the cheaper half: the chain consults the proposal
      // object and nothing else, so a second call is stable.
      const second = cfSelectChainFarmerAction(caseRoot.context, production, {
        chain,
        seat: caseRoot.seat,
      });
      expect(stable(second)).toBe(stable(first));
    }
  }, 300000);

  it("stops the whole chain when production's action is not in its own shortlist", () => {
    const chain = chainOf("ai-v1", [layerOf(ALWAYS, 0.01)]);
    for (const caseRoot of ROOTS.slice(0, 6)) {
      const bogus = Object.freeze({ type: "pass" as const, seat: caseRoot.seat });
      const real = cfProposal(caseRoot.context);
      const hasPass = real.actions.some((action) => action.type === "pass");
      const outcome = cfSelectChainFarmerAction(caseRoot.context, bogus, {
        chain,
        seat: caseRoot.seat,
        proposalOf: () => Object.freeze({
          actions: Object.freeze(real.actions.filter((action) => action.type !== "pass")),
          anchoredScores: Object.freeze([]),
          baseScores: Object.freeze([]),
        }),
      });
      if (hasPass && real.actions.filter((action) => action.type !== "pass").length >= 2) {
        continue;
      }
      expect(outcome.command).toBe(bogus);
      expect(outcome.overrode).toBe(false);
    }
  }, 300000);
});

// ---------------------------------------------------------------------------
// The chain as a CfPolicy, and the shape guard
// ---------------------------------------------------------------------------

describe("the chain as a corpus policy", () => {
  it("passes non-bound seats through object for object", () => {
    const pi1 = frozenPi1Chain();
    const policy: CfPolicy = cfChainPolicy(pi1, "ai-one");
    for (const caseRoot of ROOTS.slice(0, 6)) {
      const production = productionOf(caseRoot);
      if (caseRoot.seat === "ai-one") {
        continue;
      }
      expect(policy(caseRoot.context, production)).toBe(production);
    }
  }, 300000);

  it("is stable: the same context and command give the same command twice", () => {
    const pi1 = frozenPi1Chain();
    const policy = cfChainPolicy(pi1, "ai-one");
    const caseRoot = ROOTS.find((entry) => entry.seat === "ai-one");
    expect(caseRoot).toBeDefined();
    const production = productionOf(caseRoot!);
    const first = policy(caseRoot!.context, production);
    const second = policy(caseRoot!.context, production);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  }, 300000);
});

describe("the chain shape guard", () => {
  const pi1 = frozenPi1Chain();

  it("accepts the production chain", () => {
    expect(() => assertChainShape(pi1, CF_FEATURE_NAMES.length)).not.toThrow();
    expect(chainDepth(pi1)).toBe(1);
    expect(cumulativeModelBytes(pi1)).toBeGreaterThan(0);
  }, 300000);

  it("rejects an empty chain, a wrong width, a non-finite threshold and no recorded size", () => {
    expect(() => assertChainShape(chainOf("ai-v1", []), CF_FEATURE_NAMES.length)).toThrow(/no layers/);
    const wide = parseTreeModel({
      formatVersion: 1, lightgbmVersion: "guard", modelSha256: "x", numTrees: 1,
      numFeatures: 3, featureNames: ["a", "b", "c"],
      trees: [{
        feature: [-1], threshold: [0], defaultLeft: [0], missingZero: [0],
        left: [0], right: [0], value: [1],
      }],
    } as Parameters<typeof parseTreeModel>[0]);
    expect(() => assertChainShape(
      chainOf("ai-v1", [layerOf(wide, 0.01)]), CF_FEATURE_NAMES.length)).toThrow(/frozen schema/);
    expect(() => assertChainShape(
      chainOf("ai-v1", [layerOf(ALWAYS, Number.NaN)]), CF_FEATURE_NAMES.length)).toThrow(/non-finite/);
    expect(() => assertChainShape(
      chainOf("ai-v1", [Object.freeze({
        modelSha256: ALWAYS.modelSha256, model: ALWAYS, threshold: 0.01, modelBytes: 0,
      })]), CF_FEATURE_NAMES.length)).toThrow(/artifact size/);
  }, 300000);

  it("rejects a parentless chain of depth greater than one", () => {
    expect(() => assertChainShape(
      Object.freeze({
        championId: "ai-v2-research",
        parentChampionId: null,
        layers: Object.freeze([layerOf(ALWAYS, 0.01), layerOf(NEVER, 0.01)]),
        baseMasterVersion: "master-v1",
        top3Version: "t",
        schemaHash: "s",
      }),
      CF_FEATURE_NAMES.length,
    )).toThrow(/inconsistent parentage/);
  }, 300000);
});

describe("champion archive rules", () => {
  it("names research champions so they cannot be read as production", () => {
    expect(researchChampionId(2)).toBe("ai-v2-research");
    expect(researchChampionId(11)).toBe("ai-v11-research");
    expect(() => researchChampionId(1)).toThrow();
  }, 300000);

  it("refuses an archive that claims production without being ai-v1", () => {
    expect(() => parseChampionArchive(JSON.stringify({
      championId: "ai-v2", parentChampionId: "ai-v1", generation: 2, researchOnly: true,
      layers: [{ modelSha256: "a", threshold: 0.01, artifact: "x", modelBytes: 1 }],
      schemaVersion: 2, schemaHash: "s", baseMasterVersion: "m", top3Version: "t",
      pools: {}, attemptId: "attempt-001", formalN: 1200, alpha: 0.005,
      farmerDelta: 0.02, lowerBound99: 0.01, decision: "PROMOTE", runtimeCost: {},
      cumulativeModelBytes: 1, createdAt: "2026-09-23T00:00:00.000Z", immutableGitTag: null,
      sourceCommit: "x",
    }))).toThrow(/-research/);
  }, 300000);

  it("refuses an archive whose depth and generation disagree", () => {
    expect(() => parseChampionArchive(JSON.stringify({
      championId: "ai-v2-research", parentChampionId: "ai-v1", generation: 3, researchOnly: true,
      layers: [{ modelSha256: "a", threshold: 0.01, artifact: "x", modelBytes: 1 }],
      schemaVersion: 2, schemaHash: "s", baseMasterVersion: "m", top3Version: "t",
      pools: {}, attemptId: "attempt-001", formalN: 1200, alpha: 0.005,
      farmerDelta: 0.02, lowerBound99: 0.01, decision: "PROMOTE", runtimeCost: {},
      cumulativeModelBytes: 1, createdAt: "2026-09-23T00:00:00.000Z", immutableGitTag: null,
      sourceCommit: "x",
    }))).toThrow(/generation 3/);
  }, 300000);
});

describe("the corpus module's constants", () => {
  it("keeps the frozen group cap and refuses a foreign seed base", () => {
    expect(CF_GROUP_SNAPSHOT_CAP).toBe(3);
    expect(FACTORY_SNAPSHOT_SALT).not.toBe("phase2-pi1-snapshot");
    expect(FACTORY_DATASET_VERSION).toBe(5);
  }, 300000);

  it("refuses a deal outside the pool it was handed", () => {
    const pool: FactoryPoolRef = Object.freeze({
      poolId: "guard",
      purpose: "train",
      range: Object.freeze({ start: 301, end: 400 }),
    });
    expect(() => factoryGroupSpecFor(401, pool, "guard")).toThrow(/outside pool/);
    expect(() => factoryGroupSpecFor(300, pool, "guard")).toThrow(/outside pool/);
    expect(() => factoryGroupSpecFor(301, pool, "guard")).not.toThrow();
  }, 300000);

  it("keeps every variant of one deal in one split by construction", () => {
    const pool: FactoryPoolRef = Object.freeze({
      poolId: "guard",
      purpose: "train",
      range: Object.freeze({ start: 301, end: 400 }),
    });
    const spec = factoryGroupSpecFor(350, pool, "guard");
    const dealIndexes = new Set(spec.variants.map((variant) => variant.variantId.split(":")[0]));
    expect([...dealIndexes]).toEqual(["350"]);
    expect(spec.dealIndex).toBe(spec.dealSeed);
  }, 300000);
});
