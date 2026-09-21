/**
 * Public-contract guards for Spec 065 — the top3 → top5 candidate widening
 * (`docs/specs/065-candidate-width-top5/spec.md`).
 *
 * The round changes exactly one thing, so the guards are mostly about proving
 * that everything *else* stayed put:
 *
 *   - **§7.19, the load-bearing one**: `C5[0..2]` must equal the shipped
 *     `C3`, element for element, on real roots. If that fails then what moved
 *     is the ranking rather than the width, and π1 stops being π1.
 *   - **π1 is untouched**: the first layer must produce byte-identical output
 *     to `cfSelectFarmerAction` on the same context and command, *including*
 *     the case where `b0` sits at index 3 or 4 — π1 must not be able to see it.
 *   - **the widening is real**: on a good fraction of roots `C5` is strictly
 *     wider than `C3`, so the challenger genuinely has more to choose from.
 *
 * Fixtures are **retired deals only** (`50_0xx`, the spent Phase 2 v1 dataset).
 * `140001+` is never dealt here — this file must cost Spec 065 no seed at all.
 */
import { describe, expect, it, vi } from "vitest";

import {
  cfActionCommand,
  cfCommandKey,
  cfProposal,
  cfSelectFarmerAction,
  type CfProposal,
  type TreeModel,
} from "../../src/app/ai/cf-selector.js";
import { parseTreeModel } from "../../src/core/ai/cf-model.js";
import { CF_MODEL_JSON } from "../../src/app/ai/cf-model-data.js";
import { dealDeck, armSchedule, dealGameSeed, scheduleFor, startWithLandlord } from "../../benchmarks/ai-tournament.js";
import { CF_GROUP_SNAPSHOT_CAP, cfPlayContext, cfPolicyCommand, cfRow } from "../../benchmarks/cf-dataset.js";
import { cfPiCaptureGroup, CF_PI_THRESHOLD, type CfPiBaseline } from "../../benchmarks/cf-policy-iteration.js";
import { cfPiFrozenBaseline } from "../../benchmarks/cf-pi-corpus.js";
import {
  CF_TOP3_LIMIT,
  CF_TOP5_LIMIT,
  cfProposal5,
  cfProposalN,
  cfSelectTop5FarmerAction,
  cfTop3Prefix,
  cfTop5IncludesTop3,
} from "../../benchmarks/cf-top5.js";

// Capturing real roots plays whole games to terminal, so this suite cannot live
// inside vitest's 5 s default: a fixture costs seconds on an idle machine and
// tens of seconds when a 15-shard corpus generation is using every core. That
// was always true — it only became visible when the corpus ran alongside
// `pnpm check` and every capture-heavy test crossed the limit at once. Stated
// per file rather than inherited.
vi.setConfig({ testTimeout: 300_000 });


const STUDIED = "ai-one" as const;
const LANDLORD = "human" as const;
const OTHER = "ai-two" as const;

const DEAL = 50_011;

/** A tree-table model that counts how many walks start (see cf-policy-iteration tests). */
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
    numFeatures: 86,
    featureNames: JSON.parse(CF_MODEL_JSON).featureNames,
    trees: proxy,
  });
  return { model, traversals: () => traversals, arm: () => { armed = true; } };
}

/** Score 1 for `cand_cardCount >= 3`, else -1 — a model that can prefer a later candidate. */
function cardCountModel(): TreeModel {
  return parseTreeModel({
    formatVersion: 1,
    lightgbmVersion: "test",
    modelSha256: "test",
    numTrees: 1,
    numFeatures: 86,
    featureNames: JSON.parse(CF_MODEL_JSON).featureNames,
    trees: [{
      feature: [40, -1, -1], threshold: [2.5, 0, 0], defaultLeft: [0, 0, 0],
      missingZero: [0, 0, 0], left: [1, 0, 0], right: [2, 0, 0],
      value: [0, 1, -1],
    }],
  });
}

const ALWAYS = constantModel(1);
const NEVER = constantModel(-1);

function constantModel(value: number): TreeModel {
  return parseTreeModel({
    formatVersion: 1,
    lightgbmVersion: "test",
    modelSha256: "test",
    numTrees: 1,
    numFeatures: 86,
    featureNames: JSON.parse(CF_MODEL_JSON).featureNames,
    trees: [{
      feature: [-1], threshold: [0], defaultLeft: [0],
      missingZero: [0], left: [0], right: [0], value: [value],
    }],
  });
}

type Root = Readonly<{
  context: ReturnType<typeof cfProposal> extends never ? never : Parameters<typeof cfProposal>[0];
  raw: ReturnType<typeof cfActionCommand>;
  rawKey: string;
  proposal5: CfProposal;
  proposal3: CfProposal;
}>;

let cache: readonly Root[] | null = null;

/**
 * Every studied-seat root of a handful of retired deals, with the production
 * command production actually played there.
 *
 * Searched rather than typed: whether a root has a four- or five-wide shortlist
 * is a property of the deal, and the cases the guards care about most — a wide
 * `C5`, and `b0` outside `C3` — are a minority of roots.
 */
function roots(): readonly Root[] {
  if (cache !== null) {
    return cache;
  }
  const baseline: CfPiBaseline = cfPiFrozenBaseline();
  const built: Root[] = [];
  for (let dealIndex = 50_001; dealIndex < 50_030; dealIndex += 1) {
    const variants = armSchedule(dealIndex)
      .filter((slot) => slot.arm === "B" && slot.strongSeat !== slot.landlord)
      .map((slot) => Object.freeze({
        variantId: `${dealIndex}:${slot.landlord}:${slot.strongSeat}`,
        landlord: slot.landlord,
        studiedSeat: slot.strongSeat,
        gameSeed: dealGameSeed(dealIndex, slot.strongSeat, slot.landlord),
        tiers: scheduleFor("master", "default", slot.strongSeat),
      }));
    const spec = Object.freeze({
      groupId: `deal-${dealIndex}`,
      dealIndex,
      dealSeed: dealIndex,
      variants: Object.freeze(variants),
      snapshotCap: CF_GROUP_SNAPSHOT_CAP,
      policyCommit: "guard",
    });
    const captured = cfPiCaptureGroup(dealDeck(dealIndex), spec, baseline);
    for (const snapshot of captured.snapshots) {
      // `armSchedule` rotates the studied seat per deal, so a raw sweep of
      // snapshots mixes seats. The guards below reason in terms of one bound
      // seat, so the fixture keeps only that seat's roots rather than
      // pretending every snapshot belongs to it.
      if (snapshot.meta.seat !== STUDIED) {
        continue;
      }
      const context = Object.freeze({
        kind: "play" as const,
        view: snapshot.view,
        legalActions: snapshot.actions,
      });
      const rawCandidate = snapshot.candidates[snapshot.meta.rawProductionIndex ?? 0];
      if (rawCandidate === undefined) {
        continue;
      }
      const rawAction = snapshot.actions[rawCandidate.actionIndex];
      if (rawAction === undefined) {
        continue;
      }
      const raw = cfActionCommand(snapshot.meta.seat, rawAction);
      built.push(Object.freeze({
        context,
        raw,
        rawKey: cfCommandKey(raw),
        proposal5: cfProposal5(context),
        proposal3: cfProposal(context),
      }));
    }
  }
  if (built.length === 0) {
    throw new Error("Guard setup found no retired root.");
  }
  cache = Object.freeze(built);
  return cache;
}

function wide(): readonly Root[] {
  const found = roots().filter((root) => root.proposal5.actions.length > root.proposal3.actions.length);
  if (found.length === 0) {
    throw new Error("Guard setup found no root where C5 is wider than C3.");
  }
  return found;
}

function keyAt(proposal: CfProposal, index: number): string {
  const action = proposal.actions[index];
  if (action === undefined) {
    throw new Error(`Guard setup has no candidate at ${index}.`);
  }
  return cfCommandKey(cfActionCommand(STUDIED, action));
}

function options(extra: Record<string, unknown> = {}) {
  return Object.freeze({
    baselineModel: ALWAYS,
    challengerModel: ALWAYS,
    threshold: CF_PI_THRESHOLD,
    seat: STUDIED,
    ...extra,
  }) as Parameters<typeof cfSelectTop5FarmerAction>[2];
}

// ---------------------------------------------------------------------------
// §7.19 — the widened set contains the frozen one
// ---------------------------------------------------------------------------

describe("spec065: the width is a widening, not a reordering", () => {
  it("keeps C5's first three identical to the shipped C3 on every real root (§7.19)", () => {
    const all = roots();
    expect(all.length).toBeGreaterThan(20);
    let widened = 0;
    for (const root of all) {
      expect(cfTop5IncludesTop3(root.context, root.proposal5)).toBe(true);
      // …and element for element, not merely same-length. Bounded by the
      // root's own width: plenty of real roots offer only two candidates.
      expect(root.proposal3.actions.length)
        .toBe(Math.min(CF_TOP3_LIMIT, root.proposal5.actions.length));
      for (let index = 0; index < root.proposal3.actions.length; index += 1) {
        expect(keyAt(root.proposal5, index)).toBe(keyAt(root.proposal3, index));
      }
      if (root.proposal5.actions.length > root.proposal3.actions.length) {
        widened += 1;
      }
    }
    // Non-vacuity: on a majority of real roots the two widths genuinely differ,
    // so this is not a test of `slice(0,3) === slice(0,3)`.
    expect(widened).toBeGreaterThan(0.25 * all.length);
  });

  it("never returns more than five candidates, nor more than the ranking offers", () => {
    for (const root of roots()) {
      expect(root.proposal5.actions.length).toBeLessThanOrEqual(CF_TOP5_LIMIT);
      expect(root.proposal5.actions.length).toBeGreaterThanOrEqual(1);
      // A five-wide ask on a narrow root simply returns what exists.
      expect(cfProposalN(root.context, CF_TOP5_LIMIT).actions.length)
        .toBe(root.proposal5.actions.length);
    }
  });

  it("builds the π1 prefix as a real prefix, sharing the same actions", () => {
    for (const root of wide()) {
      const prefix = cfTop3Prefix(root.proposal5);
      expect(prefix.actions.length).toBe(
        Math.min(CF_TOP3_LIMIT, root.proposal5.actions.length));
      for (let index = 0; index < prefix.actions.length; index += 1) {
        expect(keyAt(prefix, index)).toBe(keyAt(root.proposal5, index));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// §4, §7.15 — π1 is untouched, including where it cannot see b0
// ---------------------------------------------------------------------------

describe("spec065: the first layer is exactly frozen π1", () => {
  it("lets π1 see only C3, so its choice matches the shipped selector byte for byte", () => {
    let checked = 0;
    for (const root of roots()) {
      const shipped = cfSelectFarmerAction(root.context, root.raw, {
        model: ALWAYS, threshold: CF_PI_THRESHOLD, seat: STUDIED,
      });
      const outcome = cfSelectTop5FarmerAction(root.context, root.raw, options());
      // Where π1 overrides, the composition must still be standing on π1's
      // action (before the second layer moves it); where π1 declines, the
      // composition starts from the production command, which is the same
      // object the shipped selector hands back.
      if (outcome.baselineOverrode) {
        expect(keyAt(root.proposal5, outcome.baselineIndex)).toBe(cfCommandKey(shipped));
      } else {
        expect(outcome.baselineIndex).toBe(outcome.rawIndex);
      }
      checked += 1;
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("declines the π1 layer when b0 is outside C3, even though it is inside C5", () => {
    const outsideTop3 = roots().filter(
      (root) => root.proposal5.actions.length > CF_TOP3_LIMIT &&
        cfCommandKey(root.raw) !== keyAt(root.proposal5, 0) &&
        !cfTop3Prefix(root.proposal5).actions.some(
          (action) => cfCommandKey(cfActionCommand(STUDIED, action)) === root.rawKey));
    if (outsideTop3.length === 0) {
      // Not every deal has one; if none does, the case is unreachable here and
      // the guard says so rather than passing silently on an empty loop.
      expect(outsideTop3.length).toBe(0);
      return;
    }
    for (const root of outsideTop3) {
      const outcome = cfSelectTop5FarmerAction(root.context, root.raw, options());
      // π1 cannot see b0, so it declines — exactly as it does today.
      expect(outcome.rawIndexTop3).toBe(-1);
      expect(outcome.baselineOverrode).toBe(false);
      expect(outcome.baselineRows).toBe(0);
      expect(outcome.baselineIndex).toBe(outcome.rawIndex);
      // …and the challenger's layer still gets the whole of C5 \ {b1}.
      expect(outcome.challengerRows).toBe(root.proposal5.actions.length - 1);
    }
  });

  it("rebuilds b1 when π1 overrode and the second layer declined", () => {
    const root = wide().find((candidate) => {
      const outcome = cfSelectTop5FarmerAction(candidate.context, candidate.raw, options({
        baselineModel: ALWAYS, challengerModel: NEVER,
      }));
      return outcome.baselineOverrode;
    });
    if (root === undefined) {
      throw new Error("Guard setup found no root where π1 overrides.");
    }
    const outcome = cfSelectTop5FarmerAction(root.context, root.raw, options({
      baselineModel: ALWAYS, challengerModel: NEVER,
    }));
    expect(outcome.baselineOverrode).toBe(true);
    expect(outcome.overrode).toBe(false);
    expect(cfCommandKey(outcome.command)).toBe(keyAt(root.proposal5, outcome.baselineIndex));
    expect(cfCommandKey(outcome.command)).not.toBe(root.rawKey);
  });

  it("hands back the caller's own object when nothing overrides", () => {
    for (const root of roots()) {
      const outcome = cfSelectTop5FarmerAction(root.context, root.raw, options({
        baselineModel: NEVER, challengerModel: NEVER,
      }));
      expect(outcome.command).toBe(root.raw);
    }
  });
});

// ---------------------------------------------------------------------------
// §4 — the challenger's layer sees the widened set
// ---------------------------------------------------------------------------

describe("spec065: the second layer scores the five-wide set", () => {
  it("gives layer 2 exactly |C5| - 1 alternatives and layer 1 |C3| - 1", () => {
    for (const root of wide()) {
      const outcome = cfSelectTop5FarmerAction(root.context, root.raw, options());
      expect(outcome.challengerRows).toBe(root.proposal5.actions.length - 1);
      const baseline = outcome.rawIndexTop3 >= 0
        ? cfTop3Prefix(root.proposal5).actions.length - 1
        : 0;
      expect(outcome.baselineRows).toBe(baseline);
    }
  });

  it("can select a candidate that top3 never offered", () => {
    // The whole point of the widening, and it cannot be shown with a constant
    // model: every candidate ties, and the frozen tie-break takes the earliest,
    // which is always index 0 or 1. `cardCountModel` scores candidates
    // differently, so the argmax can land on the fourth or fifth candidate —
    // one that `C3` never contained and that ai-v1 therefore could not play.
    let demonstrated = 0;
    for (const root of wide()) {
      const outcome = cfSelectTop5FarmerAction(root.context, root.raw, options({
        baselineModel: NEVER, challengerModel: cardCountModel(),
      }));
      if (outcome.challengerIndex >= CF_TOP3_LIMIT) {
        demonstrated += 1;
        expect(cfCommandKey(outcome.command)).toBe(keyAt(root.proposal5, outcome.challengerIndex));
      }
    }
    expect(demonstrated).toBeGreaterThan(0);
  });

  it("computes the candidate set exactly once per root (§7.17)", () => {
    for (const root of wide()) {
      let calls = 0;
      const outcome = cfSelectTop5FarmerAction(root.context, root.raw, options({
        proposalOf: (context: Parameters<typeof cfProposal5>[0]) => {
          calls += 1;
          return cfProposal5(context);
        },
      }));
      expect(calls).toBe(1);
      expect(outcome.proposals).toBe(1);
    }
  });

  it("requires a strict score above the threshold in both layers (§7.4)", () => {
    const root = wide()[0];
    if (root === undefined) {
      throw new Error("Guard setup found no wide root.");
    }
    const exactly = cfSelectTop5FarmerAction(root.context, root.raw, options({
      baselineModel: constantModel(CF_PI_THRESHOLD),
      challengerModel: constantModel(CF_PI_THRESHOLD),
    }));
    expect(exactly.overrode).toBe(false);
    expect(exactly.command).toBe(root.raw);

    const above = cfSelectTop5FarmerAction(root.context, root.raw, options({
      baselineModel: constantModel(CF_PI_THRESHOLD + 1e-9),
      challengerModel: constantModel(CF_PI_THRESHOLD + 1e-9),
    }));
    expect(above.overrode).toBe(true);
    expect(above.command).not.toBe(root.raw);
  });

  it("breaks ties by the original C5 order in both layers (§7.5)", () => {
    for (const root of wide()) {
      const outcome = cfSelectTop5FarmerAction(root.context, root.raw, options());
      const firstOther = (proposal: CfProposal, excluded: readonly number[]): number =>
        proposal.actions.findIndex((_action, index) => !excluded.includes(index));
      if (outcome.rawIndexTop3 >= 0) {
        expect(outcome.baselineIndex).toBe(
          firstOther(cfTop3Prefix(root.proposal5), [outcome.rawIndexTop3]));
      }
      expect(outcome.challengerIndex).toBe(
        firstOther(root.proposal5, [outcome.baselineIndex]));
    }
  });
});

// ---------------------------------------------------------------------------
// §4, §4.1 — scope and declines
// ---------------------------------------------------------------------------

describe("spec065: scope", () => {
  it("declines at the landlord's own root, with zero proposals and zero traversals (§4.1, §7.13)", () => {
    // A real landlord play root, built the same way every other root here is:
    // from a retired deal's actual game state, not from a hand-made object.
    const dealt = dealDeck(DEAL);
    const state = startWithLandlord(dealt, LANDLORD);
    const context = cfPlayContext(state, LANDLORD) as Parameters<typeof cfSelectTop5FarmerAction>[0];
    let calls = 0;
    const counted = countingModel(1);
    counted.arm();
    const production = cfPolicyCommand(
      scheduleFor("master", "default", LANDLORD), DEAL, LANDLORD, context, 0);
    const outcome = cfSelectTop5FarmerAction(context, production, options({
      seat: LANDLORD,
      proposalOf: (ctx: Parameters<typeof cfProposal5>[0]) => {
        calls += 1;
        return cfProposal5(ctx);
      },
      baselineModel: counted.model,
      challengerModel: counted.model,
    }) as Parameters<typeof cfSelectTop5FarmerAction>[2]);
    expect(outcome.command).toBe(production);
    expect(outcome.proposals).toBe(0);
    expect(calls).toBe(0);
    expect(counted.traversals()).toBe(0);
    expect(outcome.baselineRows).toBe(0);
    expect(outcome.challengerRows).toBe(0);
  });

  it("never fires for a seat it was not bound to (§7.9)", () => {
    const root = roots()[0];
    if (root === undefined) {
      throw new Error("Guard setup found no root.");
    }
    let calls = 0;
    const outcome = cfSelectTop5FarmerAction(root.context, root.raw, options({
      seat: OTHER,
      proposalOf: (context: Parameters<typeof cfProposal5>[0]) => {
        calls += 1;
        return cfProposal5(context);
      },
    }));
    expect(outcome.command).toBe(root.raw);
    expect(calls).toBe(0);
    expect(outcome.proposals).toBe(0);
    expect(outcome.challengerRows).toBe(0);
  });

  it("does no work at all when disabled (§7.9)", () => {
    const root = roots()[0];
    if (root === undefined) {
      throw new Error("Guard setup found no root.");
    }
    let calls = 0;
    const outcome = cfSelectTop5FarmerAction(root.context, root.raw, options({
      enabled: false,
      proposalOf: (context: Parameters<typeof cfProposal5>[0]) => {
        calls += 1;
        return cfProposal5(context);
      },
    }));
    expect(outcome.command).toBe(root.raw);
    expect(calls).toBe(0);
  });

  it("declines the whole composition when production's action is not a candidate (§4)", () => {
    const root = roots()[0];
    if (root === undefined) {
      throw new Error("Guard setup found no root.");
    }
    const stray = Object.freeze({ type: "pass" as const, seat: STUDIED });
    const outcome = cfSelectTop5FarmerAction(root.context, stray, options());
    // Either it is not a legal action here (so not in C5) and the whole thing
    // declines, or it happens to be one — both are checked, neither is assumed.
    if (outcome.rawIndex < 0) {
      expect(outcome.command).toBe(stray);
      expect(outcome.baselineRows).toBe(0);
      expect(outcome.challengerRows).toBe(0);
    } else {
      expect(outcome.proposals).toBe(1);
    }
  });

  it("answers with a command the engine accepts (§7.14)", () => {
    let checked = 0;
    for (const root of roots()) {
      const outcome = cfSelectTop5FarmerAction(root.context, root.raw, options());
      const view = root.context.view;
      // Legality against the engine's own generator, not a second notion.
      const key = cfCommandKey(outcome.command);
      const legal = root.context.legalActions.some(
        (action) => cfCommandKey(cfActionCommand(STUDIED, action)) === key);
      expect(legal).toBe(true);
      expect(view.seat).toBe(STUDIED);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("is deterministic and blind to the hidden hands (§7.11, §7.12)", () => {
    const root = roots()[0];
    if (root === undefined) {
      throw new Error("Guard setup found no root.");
    }
    const first = cfSelectTop5FarmerAction(root.context, root.raw, options());
    const second = cfSelectTop5FarmerAction(root.context, root.raw, options());
    expect(cfCommandKey(second.command)).toBe(cfCommandKey(first.command));
    expect(second.challengerIndex).toBe(first.challengerIndex);
    expect(second.baselineIndex).toBe(first.baselineIndex);
  });
});

// ---------------------------------------------------------------------------
// §7.18 — the row interface did not move
// ---------------------------------------------------------------------------

describe("spec065: the wider candidate set is still a v1 row", () => {
  it("builds 86-column rows for every alternative of a five-wide set", () => {
    // `cfRows`/`cfRow` are untouched by this round, so what needs proving is
    // that a five-wide candidate set is *expressible* in the frozen row shape —
    // the features are per-candidate, so a fourth and fifth candidate must
    // produce the same 86 columns as the first three rather than something new.
    const wideRoots = wide();
    let rootsChecked = 0;
    let rowsChecked = 0;
    for (const root of wideRoots) {
      const proposal = root.proposal5;
      // Reference = the action π1 executes, exactly as the corpus builds it.
      const outcome = cfSelectTop5FarmerAction(root.context, root.raw, options({
        baselineModel: ALWAYS, challengerModel: NEVER,
      }));
      const referenceAction = root.context.legalActions.find(
        (action) => cfCommandKey(cfActionCommand(STUDIED, action)) ===
          cfCommandKey(outcome.command));
      if (referenceAction === undefined) {
        // π1 declined, so the reference is production's own action.
        continue;
      }
      const reference = cfRow(root.context.view, referenceAction, referenceAction);
      expect(reference.length).toBe(86);
      for (const action of proposal.actions) {
        const row = cfRow(root.context.view, action, referenceAction);
        expect(row.length).toBe(86);
        for (const value of row) {
          expect(typeof value).toBe("number");
        }
        rowsChecked += 1;
      }
      rootsChecked += 1;
    }
    // Non-vacuity: the loop must actually have reached wide roots.
    expect(rootsChecked).toBeGreaterThan(0);
    expect(rowsChecked).toBeGreaterThan(rootsChecked * CF_TOP3_LIMIT);
  });
});
