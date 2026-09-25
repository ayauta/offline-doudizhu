/**
 * Policies, bundles and the opponent mixture for the full-action self-play line.
 *
 * The unit of play here is an `ActionPolicy`: it is handed a legal observation
 * and the full legal-action list and returns one of those actions. Nothing in
 * this module may look at the true `GameState` — a policy that could see the
 * hidden hands would make every downstream number meaningless — so the input
 * type carries a redacted `PlayingPlayerView` and nothing else.
 *
 * Three kinds of policy exist, and they are deliberately not unified:
 *
 *   - **tier policies** wrap the old self-developed rule policies, so the
 *     historical bundles in the pool are the real ones rather than a
 *     re-implementation of them;
 *   - **the π1 policy** is production plus the frozen counterfactual overlay on
 *     the farmer seats, exactly the champion `final-validation.md` measured;
 *   - **Q policies** are the new thing: enumerate every legal action, build the
 *     full-action row for each, take the argmax.
 *
 * `P0` and `PI1` exist so the pool can contain the self-developed history the
 * research question names. A Q policy is never composed with an override chain:
 * it sees the whole action set or it is not a full-action policy.
 */
import { SEAT_ORDER, type GameCommand, type Seat } from "../src/core/game/index.js";
import {
  generateLegalActions,
  type ValidatedPlayAction,
} from "../src/core/rules/index.js";
import { scoreTrees, type TreeModel } from "../src/core/ai/cf-model.js";
import type { AiDecisionContext, PlayingPlayerView } from "../src/core/ai/index.js";
import { cfActionCommand, cfCommandKey } from "../src/app/ai/cf-selector.js";
import { cfPolicyCommand, type CfTier } from "./cf-dataset.js";
import { cfSelectChainFarmerAction } from "./farmer-pi-chain.js";
import { frozenPi1Chain } from "./farmer-pi-champions.js";
import { selfplayRowFromState, stateFeaturesOf } from "./selfplay-features.js";

export type SelfPlayRole = "landlord" | "farmer-next" | "farmer-previous";

export const SELFPLAY_ROLES: readonly SelfPlayRole[] = Object.freeze([
  "landlord",
  "farmer-next",
  "farmer-previous",
]);

/**
 * `farmer-next` is the farmer who plays immediately after the landlord
 * (下家); `farmer-previous` plays immediately before him (上家). Seat distance
 * from the landlord decides which is which, which is why this cannot be read off
 * the seat alone.
 */
export function roleOfSeat(seat: Seat, landlord: Seat): SelfPlayRole {
  const distance =
    (SEAT_ORDER.indexOf(seat) - SEAT_ORDER.indexOf(landlord) + SEAT_ORDER.length) % SEAT_ORDER.length;
  return distance === 0 ? "landlord" : distance === 1 ? "farmer-next" : "farmer-previous";
}

export function seatForRole(landlord: Seat, role: SelfPlayRole): Seat {
  if (role === "landlord") {
    return landlord;
  }
  const offset = role === "farmer-next" ? 1 : 2;
  return SEAT_ORDER[(SEAT_ORDER.indexOf(landlord) + offset) % SEAT_ORDER.length]!;
}

/**
 * One scenario of an initial deal group: the same deck, a different landlord
 * assignment, exactly one learning seat.
 *
 * The learning seat is `SEAT_ORDER[dealIndex % 3]` in all three scenarios, so a
 * group exercises all three roles from one seat and no seat is systematically
 * the learner. The landlord rotation is what makes the three roles appear:
 *
 *     L          landlord = i        -> seat i is the landlord
 *     F-next     landlord = i + 2    -> seat i is the landlord's next farmer
 *     F-prev     landlord = i + 1    -> seat i is the landlord's previous farmer
 */
export interface ScenarioSpec {
  readonly scenario: "L" | "F-next" | "F-prev";
  readonly role: SelfPlayRole;
  readonly landlord: Seat;
  readonly learningSeat: Seat;
}

export const SELFPLAY_SCENARIOS: readonly ScenarioSpec["scenario"][] = Object.freeze([
  "L",
  "F-next",
  "F-prev",
]);

export function scenarioSpec(dealIndex: number, scenario: ScenarioSpec["scenario"]): ScenarioSpec {
  const base = ((dealIndex % SEAT_ORDER.length) + SEAT_ORDER.length) % SEAT_ORDER.length;
  const learningSeat = SEAT_ORDER[base]!;
  const landlordOffset = scenario === "L" ? 0 : scenario === "F-next" ? 2 : 1;
  const landlord = SEAT_ORDER[(base + landlordOffset) % SEAT_ORDER.length]!;
  return Object.freeze({
    scenario,
    role: roleOfSeat(learningSeat, landlord),
    landlord,
    learningSeat,
  });
}

/**
 * The game seed for one scenario, derived exactly as `dealGameSeed` derives it
 * for a benchmark schedule. Reusing the derivation is what lets a corpus and a
 * strength run agree about which game they are talking about.
 */
export function scenarioGameSeed(dealSeed: number, spec: ScenarioSpec): number {
  return dealSeed * 100 + SEAT_ORDER.indexOf(spec.learningSeat) * 10 + SEAT_ORDER.indexOf(spec.landlord);
}

/**
 * A full-action policy only ever decides a play. This research line does not
 * study bidding, so narrowing here means a policy cannot be handed a bid view
 * and quietly answer with a card.
 */
export type PlayDecisionContext = Extract<AiDecisionContext, { kind: "play" }>;

/** Everything a policy may know that is not in the observation. */
export interface DecisionInput {
  readonly context: PlayDecisionContext;
  readonly seat: Seat;
  readonly role: SelfPlayRole;
  readonly dealSeed: number;
  readonly gameSeed: number;
  readonly decisionIndex: number;
}

/**
 * A policy returns one of `context.legalActions`. Returning anything else is a
 * bug the collector refuses rather than a legal surprise: a policy that invented
 * an action would make the whole action set a lie.
 */
export type ActionPolicy = (input: DecisionInput) => ValidatedPlayAction;

export interface PolicyBundle {
  readonly bundleId: string;
  /** Stable identity of the underlying policies, for provenance records. */
  readonly identity: string;
  readonly roles: Readonly<Record<SelfPlayRole, ActionPolicy>>;
}

// ---------------------------------------------------------------------------
// The canonical tie-break
// ---------------------------------------------------------------------------

/**
 * The action with the largest score, ties broken by **position in the legal
 * action list**. That list is `generateLegalActions`'s own order: structural
 * pattern kind, then card count, then main-rank strength, then card id. It is a
 * rules-level order with no card-value heuristic in it and no dependence on the
 * old expert ranking, and it is a total order on distinct actions, so this
 * tie-break is deterministic and stable across processes.
 *
 * The property this buys is worth naming: a tie resolves towards the *smallest*
 * single / lowest rank, because that is where the order starts, and `pass` sorts
 * last, so a tie never resolves to a pass. `tests/core/selfplay-policy.test.ts`
 * pins both halves of that.
 */
export function argmaxAction(scores: readonly number[]): number {
  let best = 0;
  for (let index = 1; index < scores.length; index += 1) {
    const candidate = scores[index] ?? Number.NEGATIVE_INFINITY;
    const incumbent = scores[best] ?? Number.NEGATIVE_INFINITY;
    if (candidate > incumbent) {
      best = index;
    }
  }
  return best;
}

/** Every legal action's Q score, plus which one the policy would take. */
export interface ScoredActionSet {
  readonly actions: readonly ValidatedPlayAction[];
  readonly scores: readonly number[];
  readonly chosenIndex: number;
}

/**
 * Score the whole legal action set with one role model. This is the only place
 * a Q policy touches the enumerator, and there is no `slice`, no candidate cap
 * and no filter anywhere on the path.
 */
export function scoreLegalActions(
  view: PlayingPlayerView,
  model: TreeModel,
  actions?: readonly ValidatedPlayAction[],
): ScoredActionSet {
  const legal =
    actions ?? generateLegalActions({ hand: view.hand, currentPlay: view.currentPlay });
  const state = stateFeaturesOf(view);
  const scores = legal.map((action) => {
    const row = selfplayRowFromState(view, state, action);
    /*
     * `scoreTrees` walks whatever numbers it is handed; it does not know how
     * wide a row should be. A model built on a different schema would therefore
     * not fail — it would read the wrong columns and return a confident number.
     * This is the one place a full-action policy can catch that, so it does:
     * a width mismatch is a hard error, never a fallback to the incumbent.
     */
    if (row.length !== model.numFeatures) {
      throw new Error(
        `Row width ${row.length} does not match the model's ${model.numFeatures} features; ` +
          "the model was not built on this schema.",
      );
    }
    return scoreTrees(model, row);
  });
  return Object.freeze({
    actions: legal,
    scores: Object.freeze(scores),
    chosenIndex: argmaxAction(scores),
  });
}

/** A full-action Q policy for one role. */
export function createQModelPolicy(model: TreeModel, modelSha256: string): ActionPolicy {
  return (input: DecisionInput): ValidatedPlayAction => {
    const view = playingView(input.context);
    const scored = scoreLegalActions(view, model);
    const chosen = scored.actions[scored.chosenIndex];
    if (chosen === undefined) {
      throw new Error(
        `Q policy ${modelSha256} was handed an empty legal action set, which cannot happen ` +
          "at a real decision: leading always has a play and responding always has pass.",
      );
    }
    return chosen;
  };
}

export function playingView(context: AiDecisionContext): PlayingPlayerView {
  if (context.kind !== "play") {
    throw new Error("A full-action policy only decides play, not bids.");
  }
  return context.view;
}

/** Identity string for a Q bundle: the three model digests, role by role. */
export function qBundleIdentity(digests: Readonly<Record<SelfPlayRole, string>>): string {
  return SELFPLAY_ROLES.map((role) => `${role}=${digests[role]}`).join(";");
}

export function createQBundle(
  models: Readonly<Record<SelfPlayRole, { readonly model: TreeModel; readonly sha256: string }>>,
  bundleId: string,
): PolicyBundle {
  return Object.freeze({
    bundleId,
    identity: qBundleIdentity(
      Object.fromEntries(SELFPLAY_ROLES.map((role) => [role, models[role].sha256])) as Record<
        SelfPlayRole,
        string
      >,
    ),
    roles: Object.freeze(
      Object.fromEntries(
        SELFPLAY_ROLES.map((role) => [
          role,
          createQModelPolicy(models[role].model, models[role].sha256),
        ]),
      ) as Record<SelfPlayRole, ActionPolicy>,
    ),
  });
}

// ---------------------------------------------------------------------------
// Historical bundles
// ---------------------------------------------------------------------------

/**
 * Maps a legal action back onto the engine's own action->command encoding so a
 * rule policy's command can be located inside `context.legalActions` without a
 * second, drifting comparison.
 */
function actionForCommand(
  seat: Seat,
  command: GameCommand,
  actions: readonly ValidatedPlayAction[],
): ValidatedPlayAction {
  const wanted = cfCommandKey(command);
  const found = actions.find((action) => cfCommandKey(cfActionCommand(seat, action)) === wanted);
  if (found === undefined) {
    throw new Error(
      `Policy returned a command that is not in the legal action set: ${wanted}. ` +
        "A full-action policy must choose from the enumerated set.",
    );
  }
  return found;
}

/** The old self-developed rule policies, addressed by their shipped tier names. */
export function createTierPolicy(tier: CfTier): ActionPolicy {
  return (input: DecisionInput): ValidatedPlayAction => {
    const production = cfPolicyCommand(
      { human: tier, "ai-one": tier, "ai-two": tier },
      input.gameSeed,
      input.seat,
      input.context,
      input.decisionIndex,
    );
    return actionForCommand(input.seat, production, input.context.legalActions);
  };
}

/**
 * π1, the frozen production champion: master at the landlord, production master
 * plus the frozen single-layer counterfactual overlay on whichever seats are
 * farmers. The overlay is bound to one seat at a time, so the bundle applies it
 * to the two farmer roles and leaves the landlord untouched — which is exactly
 * what `final-validation.md` measured as "arm-A games 24, overlay decisions on
 * the landlord: 0".
 */
export function createPi1Bundle(tier: CfTier = "master"): PolicyBundle {
  const chain = frozenPi1Chain();
  const perSeat = new Map<Seat, ActionPolicy>();

  const policyFor = (seat: Seat): ActionPolicy => {
    const cached = perSeat.get(seat);
    if (cached !== undefined) {
      return cached;
    }
    const policy: ActionPolicy = (input: DecisionInput): ValidatedPlayAction => {
      const production = cfPolicyCommand(
        { human: tier, "ai-one": tier, "ai-two": tier },
        input.gameSeed,
        seat,
        input.context,
        input.decisionIndex,
      );
      const outcome =
        input.seat === input.context.view.landlord
          ? { command: production }
          : cfSelectChainFarmerAction(input.context, production, { chain, seat });
      return actionForCommand(seat, outcome.command, input.context.legalActions);
    };
    perSeat.set(seat, policy);
    return policy;
  };

  // The frozen overlay's identity is bound to a seat, not to a role, so the
  // bundle dispatches on `input.seat` and every role entry is the same
  // function. Which seat plays which role is the scenario's business, not the
  // policy's; making the policy re-derive it would be a second place for the two
  // to disagree.
  const dispatch: ActionPolicy = (input) => policyFor(input.seat)(input);
  return Object.freeze({
    bundleId: "PI1",
    identity: `pi1;chain=${chain.championId};tier=${tier};schema=${chain.schemaHash}`,
    roles: Object.freeze({
      landlord: dispatch,
      "farmer-next": dispatch,
      "farmer-previous": dispatch,
    }),
  });
}

export function createTierBundle(bundleId: string, tier: CfTier): PolicyBundle {
  const policy = createTierPolicy(tier);
  return Object.freeze({
    bundleId,
    identity: `tier=${tier}`,
    roles: Object.freeze({
      landlord: policy,
      "farmer-next": policy,
      "farmer-previous": policy,
    }),
  });
}

// ---------------------------------------------------------------------------
// The opponent mixture
// ---------------------------------------------------------------------------

export type BundleId = string;

export const MIXTURE_VERSION = "fas-mixture-v1";

/**
 * Frozen before a batch starts and never re-drawn inside it.
 *
 * `current` and `history` are separately weighted so the two seats are not
 * always drawn from the same place, and the two history arms mean different
 * things: a *shared* draw puts both opponents in one historical world, an
 * *independent* draw puts them in two. Duplicate identities are refused rather
 * than deduplicated silently, because a pool that lists the same strategy twice
 * would quietly double that strategy's effective probability.
 */
export interface MixtureSpec {
  readonly version: string;
  readonly current: BundleId;
  readonly history: readonly BundleId[];
  readonly weights: Readonly<{ current: number; sharedHistory: number; independentHistory: number }>;
}

export const DEFAULT_MIXTURE_WEIGHTS = Object.freeze({
  current: 0.5,
  sharedHistory: 0.25,
  independentHistory: 0.25,
});

export function assertMixtureWellFormed(spec: MixtureSpec): void {
  const total = spec.weights.current + spec.weights.sharedHistory + spec.weights.independentHistory;
  if (Math.abs(total - 1) > 1e-9) {
    throw new Error(`Mixture weights must sum to 1; they sum to ${total}.`);
  }
  if (spec.history.includes(spec.current)) {
    throw new Error(
      `Mixture history lists the current bundle "${spec.current}". A strategy that appears ` +
        "in both arms is sampled twice as often as the weights say.",
    );
  }
  if (new Set(spec.history).size !== spec.history.length) {
    throw new Error("Mixture history contains a duplicate bundle id.");
  }
  if (spec.history.length === 0 && spec.weights.sharedHistory + spec.weights.independentHistory > 0) {
    throw new Error("Mixture history is empty but the history arms carry weight.");
  }
}

function draw(random: () => number, count: number): number {
  return Math.min(count - 1, Math.floor(random() * count));
}

/**
 * A counter-style keyed generator: the stream is a pure function of the key, so
 * the same episode draws the same opponents no matter what ran before it. The
 * key is `(salt, dealSeed, scenarioIndex)` and holds nothing else — in
 * particular not the outcome, not the winner, and not any score.
 */
export function keyedOpponentRandom(
  salt: number,
  dealSeed: number,
  scenarioIndex: number,
): () => number {
  let state = (Math.imul(salt, 0x9e37_79b1) ^ Math.imul(dealSeed, 0x85eb_ca6b) ^ Math.imul(scenarioIndex + 1, 0xc2b2_ae35)) >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/**
 * The two bundles drawn for the two seats that are not learning, in `SEAT_ORDER`
 * order. The draw is about *which* bundles, not about which farmer role: the
 * seat's role picks a policy out of whichever bundle it was handed, which is
 * what "the other two seats use the corresponding roles" means.
 */
export interface OpponentDraw {
  readonly arm: "current" | "shared-history" | "independent-history";
  readonly bundleA: BundleId;
  readonly bundleB: BundleId;
}

/**
 * The two opponent bundles for one episode. The draw is keyed on
 * `(salt, dealSeed, scenarioIndex)` and reads nothing else, so it cannot depend
 * on how the episode turns out.
 */
export function drawOpponents(
  spec: MixtureSpec,
  salt: number,
  dealSeed: number,
  scenarioIndex: number,
): OpponentDraw {
  const random = keyedOpponentRandom(salt, dealSeed, scenarioIndex);
  const roll = random();
  if (roll < spec.weights.current) {
    return { arm: "current", bundleA: spec.current, bundleB: spec.current };
  }
  if (roll < spec.weights.current + spec.weights.sharedHistory) {
    const bundle = spec.history[draw(random, spec.history.length)] ?? spec.current;
    return { arm: "shared-history", bundleA: bundle, bundleB: bundle };
  }
  return {
    arm: "independent-history",
    bundleA: spec.history[draw(random, spec.history.length)] ?? spec.current,
    bundleB: spec.history[draw(random, spec.history.length)] ?? spec.current,
  };
}
