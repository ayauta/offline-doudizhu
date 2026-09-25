/**
 * The three-role collector.
 *
 * One initial deal group, three scenarios, exactly **one learning seat** per
 * episode. The learning seat plays the batch's current bundle with
 * epsilon-exploration on; the other two seats play a bundle frozen before the
 * batch started, with exploration off. Only the learning seat's decisions become
 * training rows.
 *
 * That restriction is the whole reason this file exists rather than a loop over
 * `playGame`. In a game where every seat learns at once, each terminal reward
 * would be attached to rows recorded under three different continuations, and
 * `Q(h, a)` for one role would silently be the average of three different
 * targets. Making one seat the learner per episode keeps the continuation
 * distribution of a batch's rows a single, statable thing.
 *
 * Everything here is deterministic: the deck, the opponent draw, the exploration
 * coin and every policy decision are pure functions of `(config, dealSeed,
 * scenario)`. Nothing reads a clock, and nothing reads the outcome except the
 * reward that is attached at the end.
 */
import { SEAT_ORDER, transition, type GameCommand, type GameState, type Seat } from "../src/core/game/index.js";
import { generateLegalActions, type ValidatedPlayAction } from "../src/core/rules/index.js";
import { createPlayerView, type PlayingPlayerView } from "../src/core/ai/index.js";
import { cfActionCommand, cfCommandKey, cfProposal, CF_CANDIDATE_LIMIT } from "../src/app/ai/cf-selector.js";
import { cfProposal5 } from "./cf-top5.js";
import { dealDeck, startWithLandlord } from "./ai-tournament.js";
import { actionIdentity } from "./selfplay-actions.js";
import { stateFeaturesOf, selfplayRowFromState } from "./selfplay-features.js";
import {
  drawOpponents,
  roleOfSeat,
  scenarioGameSeed,
  scenarioSpec,
  type BundleId,
  type DecisionInput,
  type MixtureSpec,
  type PolicyBundle,
  type SelfPlayRole,
} from "./selfplay-policy.js";

export const COLLECTOR_VERSION = "fas-collector-v1";

/** The frozen exploration rate for the first version. */
export const SELFPLAY_EPSILON = 0.1;

/**
 * What a seat did, kept for audit. The learning seat's decisions also become
 * rows; the other two seats' trajectories are recorded so a reviewer can read
 * the game back, and are never mixed into the Q targets.
 */
export interface TrajectoryStep {
  readonly ply: number;
  readonly seat: Seat;
  readonly role: SelfPlayRole;
  readonly bundleId: BundleId;
  readonly actionIdentity: string;
  readonly legalActionCount: number;
}

export interface LearningRecord {
  readonly dealIndex: number;
  readonly dealSeed: number;
  readonly gameSeed: number;
  readonly episodeId: string;
  readonly scenario: ScenarioSpecName;
  readonly role: SelfPlayRole;
  readonly learningSeat: Seat;
  readonly landlord: Seat;
  /** The learning seat's own decision counter, absolute within the episode. */
  readonly seatDecisionIndex: number;
  readonly ply: number;
  readonly legalActionCount: number;
  readonly executedActionIdentity: string;
  readonly executedIndex: number;
  readonly greedyActionIdentity: string;
  readonly greedyIndex: number;
  /** True when the epsilon branch fired — i.e. the uniform draw was taken. */
  readonly explored: boolean;
  /**
   * True when the action actually played differs from the behaviour policy's
   * greedy action. Weaker than `explored`: a uniform draw can land back on the
   * greedy action, and a reader auditing coverage wants the difference, not the
   * coin.
   */
  readonly actionChanged: boolean;
  readonly behaviorProbability: number;
  /** The training row: `selfplayRow(view, executedAction)`. */
  readonly features: readonly number[];
  /** The observation, kept so diagnostics can re-enumerate and re-score. */
  readonly view: PlayingPlayerView;
  readonly inOldC3: boolean;
  readonly inOldC5: boolean;
  readonly proposalAvailable: boolean;
  readonly learningBundleId: BundleId;
  /** The two non-learning seats' bundles and the mixture arm that produced them. */
  readonly opponents: readonly Readonly<{ seat: Seat; role: SelfPlayRole; bundleId: BundleId }>[];
  readonly mixtureArm: string;
  readonly mixtureVersion: string;
  /** Every seat's policy identity, for provenance. Never a feature. */
  readonly policyBundleIdentities: readonly string[];
  /** 1 when the learning seat's team won, 0 otherwise. Filled once, at the end. */
  readonly terminalReward: number;
}

export type ScenarioSpecName = "L" | "F-next" | "F-prev";

export interface EpisodeAudit {
  readonly plies: number;
  readonly learningDecisions: number;
  readonly exploredDecisions: number;
  /** Learning decisions where the executed action left the old top-5. */
  readonly outsideC5: number;
  readonly outsideC3: number;
  readonly patternKindCounts: Readonly<Record<string, number>>;
  readonly attachmentKindCounts: Readonly<Record<string, number>>;
  /** Learning decisions at which the greedy action was not in the old top-3. */
  readonly greedyOutsideC3: number;
}

export interface EpisodeResult {
  readonly dealIndex: number;
  readonly dealSeed: number;
  readonly gameSeed: number;
  readonly episodeId: string;
  readonly scenario: ScenarioSpecName;
  readonly role: SelfPlayRole;
  readonly learningSeat: Seat;
  readonly landlord: Seat;
  readonly winner: Seat;
  readonly learningTeamWon: boolean;
  readonly records: readonly LearningRecord[];
  readonly trajectory: readonly TrajectoryStep[];
  readonly audit: EpisodeAudit;
}

export interface CollectorConfig {
  readonly bundles: ReadonlyMap<BundleId, PolicyBundle>;
  readonly learningBundleId: BundleId;
  readonly mixture: MixtureSpec;
  readonly epsilon: number;
  readonly explorationSalt: number;
  readonly mixtureSalt: number;
  /**
   * Whether to compute the old proposal at every learning decision, for the
   * C3/C5 coverage audit. It costs one expert ranking per decision, so the
   * feasibility run measures it with the flag on and reports the price.
   */
  readonly auditProposal: boolean;
}

/**
 * The exploration coin for one learning decision. Keyed on
 * `(salt, dealSeed, scenarioIndex, seatDecisionIndex)` and on nothing else, so
 * the exploration sequence cannot depend on the winner, on a score, or on how
 * many decisions came before it in some other episode.
 */
export function keyedExplorationRandom(
  salt: number,
  dealSeed: number,
  scenarioIndex: number,
  seatDecisionIndex: number,
): () => number {
  let state =
    (Math.imul(salt, 0x27d4_eb2d) ^
      Math.imul(dealSeed, 0x1656_67b1) ^
      Math.imul(scenarioIndex + 1, 0x9e37_79b9) ^
      Math.imul(seatDecisionIndex + 1, 0x85eb_ca6b)) >>>
    0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const NO_PROPOSAL = Object.freeze({ c3: new Set<string>(), c5: new Set<string>(), available: false });

function proposalSets(context: Parameters<typeof cfProposal>[0]): {
  readonly c3: ReadonlySet<string>;
  readonly c5: ReadonlySet<string>;
  readonly available: boolean;
} {
  try {
    const proposal = cfProposal(context);
    const top5 = cfProposal5(context);
    return {
      c3: new Set(
        proposal.actions
          .slice(0, CF_CANDIDATE_LIMIT)
          .map((action) => actionIdentity(action)),
      ),
      c5: new Set(top5.actions.map((action) => actionIdentity(action))),
      available: true,
    };
  } catch {
    // A root with too few candidates is not an error for this research line:
    // the full-action policy has no candidate rule at all.
    return NO_PROPOSAL;
  }
}

function attachmentsOf(action: ValidatedPlayAction): string {
  if (action.type === "pass") {
    return "pass";
  }
  const pattern = action.play.pattern;
  if (
    pattern.kind === "triple-with-single" ||
    pattern.kind === "triple-with-pair" ||
    pattern.kind === "airplane-with-singles" ||
    pattern.kind === "airplane-with-pairs" ||
    pattern.kind === "four-with-two-cards" ||
    pattern.kind === "four-with-two-pairs"
  ) {
    return pattern.kind;
  }
  return "none";
}

/**
 * A one-step counterfactual fork used by the development diagnostic.
 *
 * The walk is the collector's own walk, not a second implementation of it. That
 * matters: a separate replayer could drift and then the diagnostic would fork a
 * state the corpus never visited, which is a way of measuring something other
 * than what the model was trained on.
 *
 * Exploration is off in a fork, and after the forced ply every seat continues
 * under one frozen bundle, so the only difference between two arms is the single
 * action that was forced.
 */
export interface ForkRequest {
  /**
   * Fork at the learning seat's `seatDecisionIndex`-th decision. A decision
   * index is stable across the runs being compared and needs no survey pass,
   * which is what keeps a two-arm comparison to two games per root instead of
   * three.
   */
  readonly seatDecisionIndex: number;
  /**
   * The forced action, chosen from the legal observation at that decision.
   *
   * Taking a callback rather than a precomputed index is not a convenience: it
   * is the type-level guarantee that an arm cannot be picked by looking at the
   * hidden hands or at how the game turns out. The callback sees a
   * `PlayingPlayerView` and the legal action list, and nothing else exists in
   * its scope.
   */
  readonly choose: (view: PlayingPlayerView, legalActions: readonly ValidatedPlayAction[]) => number;
  /** The frozen bundle every seat plays once the fork has been taken. */
  readonly continuationBundleId: BundleId | null;
  /**
   * What the learning seat does about exploration *after* the fork.
   * `"inherit"` keeps the episode's own epsilon; `"off"` plays greedily from the
   * fork onwards. A diagnostic that calls itself a deployment diagnostic must
   * say `"off"`; one that claims to approximate the training target says
   * `"inherit"`. The two are never the same measurement.
   */
  readonly explorationAfterFork: "inherit" | "off";
}

/**
 * Plays one episode: one initial deal, one scenario, exactly one learning seat.
 */
export function collectEpisode(
  config: CollectorConfig,
  dealIndex: number,
  scenarioName: ScenarioSpecName,
  fork: ForkRequest | null = null,
): EpisodeResult {
  const dealSeed = dealIndex;
  const scenarioIndex = scenarioName === "L" ? 0 : scenarioName === "F-next" ? 1 : 2;
  const spec = scenarioSpec(dealIndex, scenarioName);
  const gameSeed = scenarioGameSeed(dealSeed, spec);

  const draw = drawOpponents(config.mixture, config.mixtureSalt, dealSeed, scenarioIndex);
  const learningBundle = requireBundle(config, config.learningBundleId);

  // The two seats that are not learning take the two drawn bundles, assigned in
  // SEAT_ORDER order so the assignment is a function of the seat list rather
  // than of the roles the scenario happens to produce.
  const nonLearning = SEAT_ORDER.filter((seat) => seat !== spec.learningSeat);
  const bundleIdOfSeat = new Map<Seat, BundleId>([[spec.learningSeat, learningBundle.bundleId]]);
  bundleIdOfSeat.set(nonLearning[0]!, draw.bundleA);
  bundleIdOfSeat.set(nonLearning[1]!, draw.bundleB);

  const resolved = new Map<Seat, PolicyBundle>();
  for (const seat of SEAT_ORDER) {
    const id = bundleIdOfSeat.get(seat);
    if (id === undefined) {
      throw new Error(`No bundle was drawn for seat ${seat}.`);
    }
    resolved.set(seat, requireBundle(config, id));
  }

  const learningRole = roleOfSeat(spec.learningSeat, spec.landlord);
  const policyBundleIdentities = SEAT_ORDER.map((seat) => `seat${seat}:${resolved.get(seat)!.identity}`);

  const decisionCounters: Record<Seat, number> = { human: 0, "ai-one": 0, "ai-two": 0 };
  const trajectory: TrajectoryStep[] = [];
  const drafts: Omit<LearningRecord, "terminalReward">[] = [];
  const patternKindCounts: Record<string, number> = {};
  const attachmentKindCounts: Record<string, number> = {};
  let outsideC3 = 0;
  let outsideC5 = 0;
  let greedyOutsideC3 = 0;
  let exploredDecisions = 0;
  let plies = 0;

  let state: GameState = startWithLandlord(dealDeck(dealSeed), spec.landlord);
  const episodeId = `deal-${dealIndex}-${scenarioName}`;

  for (let ply = 0; ply < 512; ply += 1) {
    if (state.phase === "finished") {
      break;
    }
    if (state.phase !== "ready-to-play" && state.phase !== "playing") {
      throw new Error(`Episode ${episodeId} reached phase ${state.phase}.`);
    }
    const seat = state.currentSeat;
    const view = createPlayerView(state, seat);
    if (view === null || view.phase === "bidding") {
      throw new Error(`Episode ${episodeId} could not build a playing view for ${seat}.`);
    }
    if (
      fork !== null &&
      fork.continuationBundleId !== null &&
      decisionCounters[spec.learningSeat] > fork.seatDecisionIndex
    ) {
      for (const other of SEAT_ORDER) {
        resolved.set(other, requireBundle(config, fork.continuationBundleId));
      }
    }
    const legalActions = generateLegalActions({ hand: view.hand, currentPlay: view.currentPlay });
    if (legalActions.length === 0) {
      throw new Error(`Episode ${episodeId} found no legal action for ${seat}.`);
    }
    const role = roleOfSeat(seat, spec.landlord);
    const bundle = resolved.get(seat)!;
    const decisionIndex = decisionCounters[seat];
    const input: DecisionInput = Object.freeze({
      context: Object.freeze({ kind: "play", view, legalActions }),
      seat,
      role,
      dealSeed,
      gameSeed,
      decisionIndex,
    });

    const greedyIndex = indexOfAction(bundle.roles[role](input), legalActions, seat);
    const isLearning = seat === spec.learningSeat;

    let executedIndex = greedyIndex;
    let explored = false;
    let behaviorProbability = 1;

    const isForkPoint =
      fork !== null && isLearning && decisionIndex === fork.seatDecisionIndex;

    if (isForkPoint) {
      const chosen = fork.choose(view, legalActions);
      if (!Number.isInteger(chosen) || chosen < 0 || chosen >= legalActions.length) {
        throw new Error(
          `Fork chose action ${chosen} at the learning seat's decision ` +
            `${decisionIndex}, where only ${legalActions.length} are legal.`,
        );
      }
      executedIndex = chosen;
      behaviorProbability = Number.NaN;
      if (fork.continuationBundleId !== null) {
        resolved.set(spec.learningSeat, requireBundle(config, fork.continuationBundleId));
      }
    } else if (
      isLearning &&
      (fork === null ||
        // Before the fork point the episode must replay exactly as it was
        // recorded, exploration draws included. `explorationAfterFork` says what
        // happens *after* the forced action, not before it.
        decisionIndex < fork.seatDecisionIndex ||
        fork.explorationAfterFork === "inherit")
    ) {
      // Exploration stays on for every ply *before* a fork point. A fork has to
      // replay the exact trajectory the corpus recorded, and that trajectory
      // includes the exploration draws; turning exploration off earlier would
      // make the fork diverge from the state it claims to start from.
      const random = keyedExplorationRandom(
        config.explorationSalt,
        dealSeed,
        scenarioIndex,
        decisionIndex,
      );
      const roll = random();
      if (roll < config.epsilon) {
        executedIndex = Math.min(legalActions.length - 1, Math.floor(random() * legalActions.length));
        explored = true;
        behaviorProbability = config.epsilon / legalActions.length;
        exploredDecisions += 1;
      } else {
        behaviorProbability =
          1 - config.epsilon + config.epsilon / legalActions.length;
      }

      // A forked run exists to measure one terminal outcome, not to produce
      // rows, so nothing is recorded from it.
      if (fork === null) {
        const executed = legalActions[executedIndex]!;
        const proposal = config.auditProposal ? proposalSets(input.context) : NO_PROPOSAL;
        const executedIdentity = actionIdentity(executed);
        const greedyIdentity = actionIdentity(legalActions[greedyIndex]!);
        const stateFeatures = stateFeaturesOf(view);
        const kind = executed.type === "pass" ? "pass" : executed.play.pattern.kind;
        patternKindCounts[kind] = (patternKindCounts[kind] ?? 0) + 1;
        const attachment = attachmentsOf(executed);
        attachmentKindCounts[attachment] = (attachmentKindCounts[attachment] ?? 0) + 1;

        const inC3 = proposal.c3.has(executedIdentity);
        const inC5 = proposal.c5.has(executedIdentity);
        if (proposal.available && !inC3) {
          outsideC3 += 1;
        }
        if (proposal.available && !inC5) {
          outsideC5 += 1;
        }
        if (proposal.available && !proposal.c3.has(greedyIdentity)) {
          greedyOutsideC3 += 1;
        }

        drafts.push({
          dealIndex,
          dealSeed,
          gameSeed,
          episodeId,
          scenario: scenarioName,
          role: learningRole,
          learningSeat: spec.learningSeat,
          landlord: spec.landlord,
          seatDecisionIndex: decisionIndex,
          ply,
          legalActionCount: legalActions.length,
          executedActionIdentity: executedIdentity,
          executedIndex,
          greedyActionIdentity: greedyIdentity,
          greedyIndex,
          explored,
          actionChanged: executedIndex !== greedyIndex,
          behaviorProbability,
          features: selfplayRowFromState(view, stateFeatures, executed),
          view,
          inOldC3: inC3,
          inOldC5: inC5,
          proposalAvailable: proposal.available,
          learningBundleId: learningBundle.bundleId,
          opponents: Object.freeze(
            nonLearning.map((neighbour) =>
              Object.freeze({
                seat: neighbour,
                role: roleOfSeat(neighbour, spec.landlord),
                bundleId: resolved.get(neighbour)!.bundleId,
              }),
            ),
          ),
          mixtureArm: draw.arm,
          mixtureVersion: config.mixture.version,
          policyBundleIdentities,
        });
      }
    }

    const executedAction = legalActions[executedIndex]!;
    const command: GameCommand = cfActionCommand(seat, executedAction);
    trajectory.push({
      ply,
      seat,
      role,
      bundleId: bundle.bundleId,
      actionIdentity: actionIdentity(executedAction),
      legalActionCount: legalActions.length,
    });

    const result = transition(state, command);
    if (!result.ok) {
      throw new Error(
        `Episode ${episodeId} played an illegal command for ${seat}: ${result.error.code}.`,
      );
    }
    state = result.state;
    decisionCounters[seat] += 1;
    plies += 1;
  }

  if (state.phase !== "finished") {
    throw new Error(`Episode ${episodeId} did not finish within 512 plies.`);
  }

  const learningTeamWon =
    (state.winner === spec.landlord) === (spec.learningSeat === spec.landlord);
  const terminalReward = learningTeamWon ? 1 : 0;
  const records: LearningRecord[] = drafts.map((draft) =>
    Object.freeze({ ...draft, terminalReward }),
  );

  return Object.freeze({
    dealIndex,
    dealSeed,
    gameSeed,
    episodeId,
    scenario: scenarioName,
    role: learningRole,
    learningSeat: spec.learningSeat,
    landlord: spec.landlord,
    winner: state.winner,
    learningTeamWon,
    records: Object.freeze(records),
    trajectory: Object.freeze(trajectory),
    audit: Object.freeze({
      plies,
      learningDecisions: records.length,
      exploredDecisions,
      outsideC3,
      outsideC5,
      greedyOutsideC3,
      patternKindCounts: Object.freeze(patternKindCounts),
      attachmentKindCounts: Object.freeze(attachmentKindCounts),
    }),
  });
}

function requireBundle(config: CollectorConfig, id: BundleId): PolicyBundle {
  const bundle = config.bundles.get(id);
  if (bundle === undefined) {
    throw new Error(`No policy bundle is registered under "${id}".`);
  }
  return bundle;
}

/**
 * Locates a policy's chosen action inside the enumerated set by the engine's own
 * action->command encoding. A policy that returned an action outside the legal
 * set would be a bug, not a legal surprise, so this throws rather than falling
 * back to anything.
 */
function indexOfAction(
  chosen: ValidatedPlayAction,
  legalActions: readonly ValidatedPlayAction[],
  seat: Seat,
): number {
  const wanted = cfCommandKey(cfActionCommand(seat, chosen));
  const index = legalActions.findIndex(
    (action) => cfCommandKey(cfActionCommand(seat, action)) === wanted,
  );
  if (index < 0) {
    throw new Error(`Policy chose an action outside the legal set: ${wanted}.`);
  }
  return index;
}

/** The three scenarios of one initial deal group, in frozen order. */
export function groupScenarios(): readonly ScenarioSpecName[] {
  return Object.freeze(["L", "F-next", "F-prev"] as const);
}

export { scenarioSpec };
