/**
 * Phase 2 / Gate A v1 counterfactual farmer dataset — machinery.
 *
 * Frozen by docs/specs/062-counterfactual-policy-improvement/spec.md. Every
 * constant here that the spec pins is exported and asserted by a guard, so the
 * preregistration and the code cannot drift apart silently.
 *
 * The one idea this file is built around: a training row must be a pure
 * function of what a player could legally see. `cfRow` takes a
 * `PlayingPlayerView` — the same redaction boundary the shipped AI already
 * obeys — plus the candidate action and the production action. It has no access
 * to a `GameState`, so hidden hands are unreachable rather than merely
 * unwelcome, and `tests/core/cf-dataset-guards.test.ts` proves it by re-dealing
 * the hidden seats and demanding byte-identical rows.
 *
 * The full `GameState` is needed to *fork*. It is passed into `cfCaptureGroup`,
 * spent there, and never stored on a snapshot.
 *
 * Nothing in `src/` imports from here, and nothing here imports `node:*`: the
 * module stays clock-free and IO-free so the guards can run inside `pnpm check`.
 */
import type { CardId } from "../src/core/cards/index.js";
import {
  transition,
  type GameCommand,
  type GameState,
  type Seat,
} from "../src/core/game/index.js";
import {
  generateLegalActions,
  type ValidatedPlayAction,
} from "../src/core/rules/index.js";
import {
  DEFAULT_AI_STRATEGY,
  createPlayerView,
  type AiDecisionContext,
  type PlayingPlayerView,
} from "../src/core/ai/index.js";
import { isSameSide } from "../src/core/ai/state-evaluator.js";
import { CfInvalidError, cfRow, seatIndex } from "../src/core/ai/cf-features.js";
import {
  cfActionCommand,
  cfCommandKey,
  cfProposal,
  type CfProposal,
} from "../src/app/ai/cf-selector.js";
import {
  ENHANCED_AI_SEARCH,
  decideEnhancedAi,
} from "../src/app/ai/decision-handler.js";
import type { AiType } from "../src/app/settings/ai-settings.js";
import { startWithLandlord } from "./ai-tournament.js";

type PlayContext = Extract<AiDecisionContext, { readonly kind: "play" }>;

// ---------------------------------------------------------------------------
// Frozen constants (spec 062)
// ---------------------------------------------------------------------------

export const CF_DATASET_VERSION = 2;
export const CF_FEATURE_SCHEMA_VERSION = 2;
/** 斗地主 rules are fixed by docs/research/classic-rules-compatibility.md. */
export const CF_RULES_VERSION = "classic-1";

/** The Gate A universe: 20,000 initial deal groups, permanently Phase 2 v1. */
export const CF_UNIVERSE_START = 50_001;
export const CF_UNIVERSE_END = 70_000;
/** Test-only reserve, preregistered and never generated unless held-out is INCONCLUSIVE. */
export const CF_RESERVE_START = 70_001;
export const CF_RESERVE_END = 78_000;

export const CF_SPLIT_SALT = "phase2-cf-v1-split";
export const CF_SNAPSHOT_SALT = "phase2-cf-v1-snapshot";
export const CF_SPLIT_COUNTS = Object.freeze({
  train: 12_000,
  calibration: 4_000,
  heldout: 4_000,
});

/** At most this many useful snapshots per initial deal group — not per game. */
export const CF_GROUP_SNAPSHOT_CAP = 3;

/** The shipped root analyzer budget, read from the shipped constant. */
export const CF_PROPOSAL_ANALYZER_NODES = ENHANCED_AI_SEARCH.rootAnalyzerNodes;

/**
 * A clock that cannot interrupt anything. The formal dataset is defined at the
 * designed configuration — full work, no deadline — because that is the only
 * configuration whose decision is reproducible. Shipped 120 ms numbers must
 * never be taken from here.
 */
const CF_FROZEN_RUNTIME = Object.freeze({
  deadline: Number.POSITIVE_INFINITY,
  now: () => 0,
});

export type CfLabel = -1 | 0 | 1;
export type CfSplit = "train" | "calibration" | "heldout";
export type CfTier = AiType;
export type CfSeatTiers = Readonly<Record<Seat, CfTier>>;

/**
 * The counterfactual label for one farmer action, relative to the production
 * action, in **camp** terms: either farmer emptying a hand wins for both.
 */
export function cfLabel(
  seat: Seat,
  landlord: Seat,
  referenceWinner: Seat,
  candidateWinner: Seat,
): CfLabel {
  const referenceWins = isSameSide(seat, referenceWinner, landlord);
  const candidateWins = isSameSide(seat, candidateWinner, landlord);
  return candidateWins === referenceWins ? 0 : candidateWins ? 1 : -1;
}

// ---------------------------------------------------------------------------
// Frozen production policy π0
// ---------------------------------------------------------------------------

/**
 * The decision seed, derived exactly as the benchmark derives it: a per-seat
 * base offset off the game seed, plus a fixed stride per decision that seat has
 * made. The counter is per-seat and absolute within the game, which is what
 * lets a fork resume the *same* policy the full game would have kept playing.
 * Restarting it at zero would sample different rollout worlds and break the a0
 * replay identity.
 */
export function cfDecisionSeed(gameSeed: number, seat: Seat, decisionIndex: number): number {
  return (gameSeed + 1 + seatIndex(seat) + decisionIndex * 7919) >>> 0;
}

function tierCommand(
  tier: CfTier,
  gameSeed: number,
  seat: Seat,
  context: AiDecisionContext,
  decisionIndex: number,
): GameCommand {
  if (tier === "default") {
    return DEFAULT_AI_STRATEGY.chooseCommand(context);
  }
  const outcome = decideEnhancedAi(
    Object.freeze({
      requestId: decisionIndex + 1,
      aiType: tier,
      context,
      seed: cfDecisionSeed(gameSeed, seat, decisionIndex),
    }),
    CF_FROZEN_RUNTIME,
  );
  if (!outcome.ok) {
    throw new CfInvalidError(`Frozen ${tier} decision failed for ${seat}.`);
  }
  return outcome.command;
}

/**
 * The frozen π0. Production draws a fresh `crypto` seed per decision, so "the
 * production action" is only a well-defined object once the seed is pinned;
 * every label in the corpus is therefore conditional on the realized rollout
 * seed, and this same function is what both fork branches continue with.
 */
export function cfPolicyCommand(
  tiers: CfSeatTiers,
  gameSeed: number,
  seat: Seat,
  context: AiDecisionContext,
  decisionIndex: number,
): GameCommand {
  return tierCommand(tiers[seat], gameSeed, seat, context, decisionIndex);
}

/**
 * What a policy does with the command production just produced.
 *
 * The counterfactual forks have always continued under π0, so this seam had no
 * reason to exist. Policy iteration needs it: the π1 capture visits, forks and
 * continues under a policy that is still production *plus* the frozen selector
 * at one seat. Keeping it a transformation of the production command — rather
 * than a second decision function — is what makes "π1 is π0 plus one override"
 * checkable, and it keeps the decision counter and the seed derivation in one
 * place for both policies.
 */
export type CfPolicy = (
  context: AiDecisionContext,
  productionCommand: GameCommand,
) => GameCommand;

/** π0: the production command is played unchanged, object for object. */
export const CF_PRODUCTION_POLICY: CfPolicy = (_context, productionCommand) => productionCommand;

/**
 * Compares two forks element for element: the winner, every command, and every
 * (seat, decision index) pair consumed on the way.
 *
 * Winner equality is deliberately not enough. Two continuations can end in the
 * same winner having played different cards, and a fork that resumed under the
 * wrong policy would still look correct by that measure — which is exactly the
 * failure this exists to catch.
 */
export function cfTraceDivergence(reference: CfForkResult, original: CfForkResult): string | null {
  if (reference.winner !== original.winner) {
    return `winner: ${reference.winner} != ${original.winner}`;
  }
  if (reference.commands.length !== original.commands.length) {
    return `commands length: ${reference.commands.length} != ${original.commands.length}`;
  }
  for (let index = 0; index < reference.commands.length; index += 1) {
    const left = reference.commands[index];
    const right = original.commands[index];
    if (left !== right) {
      return `commands[${index}]: ${left} != ${right}`;
    }
  }
  if (reference.decisions.length !== original.decisions.length) {
    return `decisions length: ${reference.decisions.length} != ${original.decisions.length}`;
  }
  for (let index = 0; index < reference.decisions.length; index += 1) {
    const left = reference.decisions[index];
    const right = original.decisions[index];
    if (left?.seat !== right?.seat || left?.index !== right?.index) {
      return `decisions[${index}]: ${left?.seat}#${left?.index} != ${right?.seat}#${right?.index}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared command/action helpers// ---------------------------------------------------------------------------
// `cfCommandKey`, `cfActionCommand` and `cfProposal` live in
// `src/app/ai/cf-selector.ts` with the rest of the frozen selector, and are
// re-exported here. Two copies of the candidate rule is how a corpus and a
// product start disagreeing about what a candidate is.
// ---------------------------------------------------------------------------

export {
  CF_CANDIDATE_LIMIT,
  cfActionCommand,
  cfCommandKey,
  cfProposal,
  type CfProposal,
} from "../src/app/ai/cf-selector.js";

/**
 * The root decision context for a seat, built from the true state. Used by the
 * corpus generator and the guards; the product builds the same shape from the
 * redacted view it is handed.
 */
export function cfPlayContext(state: GameState, seat: Seat): PlayContext {
  const view = createPlayerView(state, seat);
  if (view === null || view.phase === "bidding") {
    throw new CfInvalidError(`Counterfactual capture needs a playing view for ${seat}.`);
  }
  return Object.freeze({
    kind: "play",
    view,
    legalActions: generateLegalActions({
      hand: view.hand,
      currentPlay: view.currentPlay,
    }),
  });
}


/**
 * The spec's eligibility rule, stated on the *production candidate set* rather
 * than on the legal-action count:
 *
 *   the deduplicated production candidates contain `a0`,
 *   and at least one candidate differs from `a0`.
 *
 * A root with one legal action fails the second clause however it was reached,
 * so this is strictly the rule the spec asks for and not a proxy for it.
 */
export function cfIsEligible(
  proposal: CfProposal,
  seat: Seat,
  production: GameCommand,
): boolean {
  const keys = [...new Set(
    proposal.actions.map((action) => cfCommandKey(cfActionCommand(seat, action))),
  )];
  const productionKey = cfCommandKey(production);
  return keys.includes(productionKey) && keys.some((key) => key !== productionKey);
}

// ---------------------------------------------------------------------------
// Forking
// ---------------------------------------------------------------------------

export type CfPolicyCounters = Record<Seat, number>;

export type CfForkResult = Readonly<{
  winner: Seat;
  commands: readonly string[];
  /**
   * The (seat, decision index) pair consumed at every step, in order. This is
   * the cheap way to state the fork's central promise without depending on
   * whether a seed change happens to move a particular action: the `default`
   * tier ignores its seed entirely, so a trace comparison alone cannot see a
   * counter that stopped advancing. This can.
   */
  decisions: readonly Readonly<{ seat: Seat; index: number }>[];
}>;

/**
 * Plays from `state` to a real terminal position under one policy. Both fork
 * branches call this same function with the same tiers and counters, which is
 * the "after the first hand, both branches restore the identical policy" half
 * of the counterfactual.
 *
 * The policy defaults to π0, so the v1 corpus and the Gate A/B benchmarks keep
 * the exact behaviour they were frozen with; policy iteration passes π1
 * instead, and every seat it is not bound to still gets π0.
 *
 * A position that does not reach a terminal within the command limit is
 * INVALID, never a draw and never a `0`.
 */
export function cfPlayToTerminal(
  state: GameState,
  tiers: CfSeatTiers,
  gameSeed: number,
  counters: CfPolicyCounters,
  commandLimit = 256,
  policy: CfPolicy = CF_PRODUCTION_POLICY,
): CfForkResult {
  let current = state;
  const active: CfPolicyCounters = { ...counters };
  const commands: string[] = [];
  const decisions: Array<Readonly<{ seat: Seat; index: number }>> = [];
  for (let step = 0; step < commandLimit; step += 1) {
    if (current.phase === "finished") {
      return Object.freeze({
        winner: current.winner,
        commands: Object.freeze(commands),
        decisions: Object.freeze(decisions),
      });
    }
    if (current.phase !== "playing" && current.phase !== "ready-to-play") {
      throw new CfInvalidError(`Counterfactual fork reached phase ${current.phase}.`);
    }
    const seat = current.currentSeat;
    const context = cfPlayContext(current, seat);
    const command = policy(
      context,
      cfPolicyCommand(tiers, gameSeed, seat, context, active[seat]),
    );
    decisions.push(Object.freeze({ seat, index: active[seat] }));
    active[seat] += 1;
    commands.push(cfCommandKey(command));
    const result = transition(current, command);
    if (!result.ok) {
      throw new CfInvalidError(`Illegal frozen command for ${seat}: ${result.error.code}`);
    }
    current = result.state;
  }
  throw new CfInvalidError("Counterfactual fork did not reach a terminal position.");
}

export type CfForkBundle = Readonly<{
  labels: readonly CfLabel[];
  winners: readonly Seat[];
  forks: readonly CfForkResult[];
}>;

/**
 * Forks the state once for the reference action and once per candidate, and
 * reduces each terminal winner to a farmer-camp label relative to it.
 *
 * Both branches consume the acting seat's decision index, because the decision
 * really was made in the full game — only its output is replaced. That is what
 * makes the reference branch byte-identical to the game the snapshot came from.
 *
 * `referenceIndex` is the candidate that was actually played at this root: `a0`
 * under π0, and `b1` — the action the frozen selector executed — under π1. It
 * is not necessarily the raw production action, which is why it is named for
 * its role rather than for where it came from.
 */
export function cfForkLabels(
  state: GameState,
  seat: Seat,
  landlord: Seat,
  commandForCandidate: (index: number) => GameCommand,
  candidateCount: number,
  referenceIndex: number,
  counters: CfPolicyCounters,
  tiers: CfSeatTiers,
  gameSeed: number,
  policy: CfPolicy = CF_PRODUCTION_POLICY,
): CfForkBundle {
  const after: CfPolicyCounters = { ...counters, [seat]: counters[seat] + 1 };
  const winners: Seat[] = [];
  const forks: CfForkResult[] = [];
  for (let index = 0; index < candidateCount; index += 1) {
    const forced = transition(state, commandForCandidate(index));
    if (!forced.ok) {
      throw new CfInvalidError(`Forced candidate ${index} is illegal for ${seat}.`);
    }
    const fork = cfPlayToTerminal(forced.state, tiers, gameSeed, after, 256, policy);
    forks.push(fork);
    winners.push(fork.winner);
  }
  const reference = winners[referenceIndex];
  if (reference === undefined) {
    throw new CfInvalidError("The reference action is not one of the candidates.");
  }
  const labels = winners.map((winner) => cfLabel(seat, landlord, reference, winner));
  return Object.freeze({
    labels: Object.freeze(labels),
    winners: Object.freeze(winners),
    forks: Object.freeze(forks),
  });
}

// ---------------------------------------------------------------------------
// The frozen Option-C feature schema lives in `src/core/ai/cf-features.ts`.
//
// It moved there verbatim when the shipped Worker started building these rows
// itself. Re-exported rather than duplicated: two implementations of a frozen
// schema is how a corpus and a runtime stop agreeing.
// ---------------------------------------------------------------------------

export {
  CF_ACTION_CAT_NAMES,
  CF_ACTION_CAT_OFFSET,
  CF_ACTION_NUM_NAMES,
  CF_ACTION_NUM_OFFSET,
  CF_A0_CAT_OFFSET,
  CF_A0_NUM_OFFSET,
  CF_CONTEXT_NAMES,
  CF_DELTA_OFFSET,
  CF_FEATURE_NAMES,
  CfInvalidError,
  cfActionFeatures,
  cfContextFeatures,
  cfNumericDelta,
  cfRow,
  seatIndex,
  type CfActionFeatures,
  type CfPatternFamily,
} from "../src/core/ai/cf-features.js";


// ---------------------------------------------------------------------------
// Snapshot capture — one group at a time
// ---------------------------------------------------------------------------

export type CfSnapshotMeta = Readonly<{
  datasetVersion: number;
  featureSchemaVersion: number;
  rulesVersion: string;
  policyCommit: string;
  groupId: string;
  dealIndex: number;
  dealSeed: number;
  variantId: string;
  snapshotId: string;
  gameSeed: number;
  landlord: Seat;
  seat: Seat;
  /** The seat's own decision index within the game — part of the seed derivation. */
  seatDecisionIndex: number;
  /** The seed that decision actually used; stored, never re-derived at train time. */
  decisionSeed: number;
  /** The frozen policy that produced `a0` and that continues both branches. */
  tiers: CfSeatTiers;
  /** Per-seat decision counters as the fork leaves them: the continuation state. */
  continuationCounters: CfPolicyCounters;
  /**
   * Policy iteration only: candidate index of the *raw production* action `b0`.
   * `productionIndex` keeps its v1 meaning — the reference the labels and rows
   * are built against — which under π1 is the action the frozen selector
   * actually executed (`b1`), not the action production proposed.
   *
   * Absent under π0, where the two are the same thing, so a v1 snapshot keeps
   * exactly the bytes it was frozen with.
   */
  rawProductionIndex?: number;
}>;

export type CfCandidate = Readonly<{
  /** Index into the snapshot view's own `generateLegalActions` output. */
  actionIndex: number;
  /** Expert anchored score — diagnostic storage only. Never enters `cfRow`. */
  anchoredScore: number;
  baseScore: number;
}>;

export type CfSnapshot = Readonly<{
  meta: CfSnapshotMeta;
  /** The redacted observation. The only thing a model may read. */
  view: PlayingPlayerView;
  /** The seat's legal actions, as generated from `view` alone. */
  actions: readonly ValidatedPlayAction[];
  candidates: readonly CfCandidate[];
  /** Index into `candidates` of the action production actually played. */
  productionIndex: number;
  winners: readonly Seat[];
  labels: readonly CfLabel[];
  /** Reporting buckets. Never features. */
  diagnostics: Readonly<{
    legalActionCount: number;
    uniqueCandidateCount: number;
    expertGap: readonly number[];
    minRemaining: number;
    totalRemaining: number;
  }>;
}>;

/**
 * One arm-B game of a group.
 *
 * `tiers` is per *variant*, not per group, because the studied seat rotates
 * with the landlord seat and therefore differs between the three arm-B games of
 * a single deal. A single group-level tier record silently ran two of the three
 * variants on the wrong policy — the guards caught it, which is the only reason
 * it is not in the corpus.
 */
export type CfVariantSpec = Readonly<{
  variantId: string;
  landlord: Seat;
  studiedSeat: Seat;
  gameSeed: number;
  tiers: CfSeatTiers;
}>;

export type CfGroupSpec = Readonly<{
  groupId: string;
  dealIndex: number;
  dealSeed: number;
  variants: readonly CfVariantSpec[];
  snapshotCap: number;
  policyCommit: string;
}>;

export type CfGroupResult = Readonly<{
  groupId: string;
  dealIndex: number;
  /** All farmer roots the studied seat faced across every variant. */
  totalFarmerRoots: number;
  /** Roots whose production candidate set contained a0 plus at least one other. */
  usefulFarmerRoots: number;
  sampledRoots: number;
  /** selected-root count per variant, for the source-variant diagnostic. */
  sourceVariantCounts: Readonly<Record<string, number>>;
  snapshots: readonly CfSnapshot[];
  forkGames: number;
  /** Termination status per variant, so a variant that never finished is visible. */
  variantWinners: Readonly<Record<string, Seat>>;
}>;

type PendingRoot = {
  state: GameState;
  seat: Seat;
  variantId: string;
  gameSeed: number;
  landlord: Seat;
  tiers: CfSeatTiers;
  seatDecisionIndex: number;
  counters: CfPolicyCounters;
  /** The command the frozen policy actually played here — the dataset's reference. */
  command: GameCommand;
  /** The action production proposed before the policy touched it — π1's `b0`. */
  rawCommand: GameCommand;
  /** Where this decision sits in the variant's own trace, for the replay check. */
  step: number;
  /** The very policy this variant was played under — the forks must resume it. */
  policy: CfPolicy;
  context: PlayContext;
};

/**
 * The sampling key. Depends on the group id, the variant, the decision index and
 * a fixed salt — and on nothing else. In particular it cannot see the label, a
 * fork outcome, the expert gap, a candidate score, or any future winner, which
 * is what makes "take the smallest priorities" an outcome-blind selection.
 */
export function cfSnapshotPriority(
  salt: string,
  groupId: string,
  variantId: string,
  seatDecisionIndex: number,
): number {
  return mix32(
    hashString(salt) ^
    hashString(groupId) ^
    Math.imul(hashString(variantId), 0x9e37_79b1) ^
    Math.imul(seatDecisionIndex + 1, 0x85eb_ca6b),
  );
}

function hashString(value: string): number {
  let hash = 0x81_1c_9d_c5;
  for (let index = 0; index < value.length; index += 1) {
    hash = (Math.imul(hash ^ value.charCodeAt(index), 0x01_00_01_93) >>> 0);
  }
  return hash >>> 0;
}

export function mix32(value: number): number {
  let state = value >>> 0;
  state = Math.imul(state ^ (state >>> 16), 0x7feb_352d) >>> 0;
  state = Math.imul(state ^ (state >>> 15), 0x846c_a68b) >>> 0;
  return (state ^ (state >>> 16)) >>> 0;
}

/**
 * Plays one variant to its terminal under one policy, collecting every farmer
 * root the studied seat faced plus the trace of the whole game. No forking
 * happens here — the group decides what to keep only after every variant has
 * been enumerated.
 */
function cfPlayVariant(
  deck: readonly CardId[],
  variant: CfVariantSpec,
  policy: CfPolicy,
): Readonly<{ winner: Seat; roots: readonly PendingRoot[]; trace: CfForkResult }> {
  if (variant.studiedSeat === variant.landlord) {
    throw new CfInvalidError("Gate A v1 studies farmer roots only.");
  }
  let state: GameState = startWithLandlord(deck, variant.landlord);
  const counters: CfPolicyCounters = { human: 0, "ai-one": 0, "ai-two": 0 };
  const roots: PendingRoot[] = [];
  const commands: string[] = [];
  const decisions: Array<Readonly<{ seat: Seat; index: number }>> = [];
  for (let step = 0; step < 256; step += 1) {
    if (state.phase === "finished") {
      return Object.freeze({
        winner: state.winner,
        roots: Object.freeze(roots),
        trace: Object.freeze({
          winner: state.winner,
          commands: Object.freeze(commands),
          decisions: Object.freeze(decisions),
        }),
      });
    }
    if (state.phase !== "playing" && state.phase !== "ready-to-play") {
      throw new CfInvalidError(`Counterfactual game reached phase ${state.phase}.`);
    }
    const seat = state.currentSeat;
    const context = cfPlayContext(state, seat);
    const rawCommand = cfPolicyCommand(variant.tiers, variant.gameSeed, seat, context, counters[seat]);
    const command = policy(context, rawCommand);
    if (seat === variant.studiedSeat) {
      roots.push({
        state,
        seat,
        variantId: variant.variantId,
        gameSeed: variant.gameSeed,
        landlord: variant.landlord,
        tiers: variant.tiers,
        seatDecisionIndex: counters[seat],
        counters: { ...counters },
        command,
        rawCommand,
        step,
        policy,
        context,
      });
    }
    decisions.push(Object.freeze({ seat, index: counters[seat] }));
    commands.push(cfCommandKey(command));
    counters[seat] += 1;
    const result = transition(state, command);
    if (!result.ok) {
      throw new CfInvalidError(`Illegal frozen command for ${seat}: ${result.error.code}`);
    }
    state = result.state;
  }
  throw new CfInvalidError("Counterfactual game did not finish within 256 commands.");
}

/**
 * How one group capture should treat the production command it starts from.
 *
 * Every field defaults to the v1 value, so `cfCaptureGroup(deck, spec)` is
 * still exactly the capture Gate A ran; policy iteration is the only caller
 * that passes anything.
 */
export type CfCaptureOptions = Readonly<{
  /**
   * The policy each variant visits, forks and continues under. Defaults to π0
   * for every variant, which is what the v1 corpus and Gate A/B were frozen
   * with.
   */
  policyFor?: (variant: CfVariantSpec) => CfPolicy;
  /**
   * The keyed-priority salt. Policy iteration gets its own frozen salt — the
   * spec pins a different value for this round — while the algorithm above it
   * stays v1's.
   */
  snapshotSalt?: string;
  /** Provenance only, so a π2 corpus cannot be mistaken for a v1 one. */
  datasetVersion?: number;
  /**
   * Policy-iteration mode. Records `rawProductionIndex` in each snapshot's meta,
   * so the raw production action can be told apart from the reference, and
   * verifies that the reference branch reproduces the variant's *own*
   * continuation command for command and decision index for decision index —
   * the winner is not enough evidence, and a fork that resumed under the wrong
   * policy would still match by winner.
   */
  recordRawProduction?: boolean;
}>;

/**
 * Enumerates one initial deal group: plays every variant, ranks every farmer
 * root by its keyed priority, and forks the highest-priority eligible roots up
 * to the group cap.
 *
 * Two properties this function exists to guarantee:
 *   - the cap is per *group*, not per game or per seat;
 *   - a group with no eligible root is still registered, with zero snapshots,
 *     and is never back-filled from another deal.
 */
export function cfCaptureGroup(
  deck: readonly CardId[],
  spec: CfGroupSpec,
  options: CfCaptureOptions = {},
): CfGroupResult {
  const policyFor = options.policyFor ?? (() => CF_PRODUCTION_POLICY);
  const snapshotSalt = options.snapshotSalt ?? CF_SNAPSHOT_SALT;
  const datasetVersion = options.datasetVersion ?? CF_DATASET_VERSION;
  const recordRawProduction = options.recordRawProduction === true;
  const allRoots: PendingRoot[] = [];
  const variantWinners: Record<string, Seat> = {};
  /** Each variant's own continuation, for the reference-branch replay check. */
  const variantTraces = new Map<string, CfForkResult>();
  for (const variant of spec.variants) {
    const played = cfPlayVariant(deck, variant, policyFor(variant));
    variantWinners[variant.variantId] = played.winner;
    variantTraces.set(variant.variantId, played.trace);
    allRoots.push(...played.roots);
  }

  const ordered = [...allRoots].sort((left, right) => {
    const leftPriority = cfSnapshotPriority(
      snapshotSalt,
      spec.groupId,
      left.variantId,
      left.seatDecisionIndex,
    );
    const rightPriority = cfSnapshotPriority(
      snapshotSalt,
      spec.groupId,
      right.variantId,
      right.seatDecisionIndex,
    );
    return leftPriority - rightPriority ||
      (left.variantId < right.variantId ? -1 : left.variantId > right.variantId ? 1 : 0) ||
      left.seatDecisionIndex - right.seatDecisionIndex;
  });

  const snapshots: CfSnapshot[] = [];
  const sourceVariantCounts: Record<string, number> = {};
  let usefulFarmerRoots = 0;
  let forkGames = 0;

  for (const root of ordered) {
    const proposal = cfProposal(root.context);
    if (!cfIsEligible(proposal, root.seat, root.command)) {
      continue;
    }
    usefulFarmerRoots += 1;
    if (snapshots.length >= spec.snapshotCap) {
      continue;
    }
    const actionIndexes = proposal.actions.map((action) => {
      const found = root.context.legalActions.findIndex((legal) => legal === action);
      if (found < 0) {
        throw new CfInvalidError("A candidate is not among the view's own legal actions.");
      }
      return found;
    });
    const productionKey = cfCommandKey(root.command);
    const productionIndex = proposal.actions.findIndex(
      (action) => cfCommandKey(cfActionCommand(root.seat, action)) === productionKey,
    );
    if (productionIndex < 0) {
      throw new CfInvalidError("The production action is not one of the candidates.");
    }
    // Under π1 the reference is `b1`, which is what the policy actually played
    // here; the raw production action is a different candidate whenever the
    // selector overrode. Both are located in `C`, never guessed.
    const rawProductionIndex = recordRawProduction
      ? proposal.actions.findIndex(
          (action) => cfCommandKey(cfActionCommand(root.seat, action)) === cfCommandKey(root.rawCommand),
        )
      : null;
    if (rawProductionIndex !== null && rawProductionIndex < 0) {
      throw new CfInvalidError("The raw production action is not one of the candidates.");
    }
    const { labels, winners, forks } = cfForkLabels(
      root.state,
      root.seat,
      root.landlord,
      (index) => {
        const action = proposal.actions[index];
        if (action === undefined) {
          throw new CfInvalidError("Fork requested a missing candidate.");
        }
        return cfActionCommand(root.seat, action);
      },
      proposal.actions.length,
      productionIndex,
      root.counters,
      root.tiers,
      root.gameSeed,
      root.policy,
    );
    forkGames += proposal.actions.length;
    // Self-check, every snapshot, on the real tier: forcing the reference
    // action must reproduce the game the snapshot was taken from. If this ever
    // fires, the per-seat decision counters did not survive the fork and every
    // label in the corpus is measured against the wrong reference.
    const variantWinner = variantWinners[root.variantId];
    if (variantWinner === undefined || winners[productionIndex] !== variantWinner) {
      throw new CfInvalidError("The forced production branch did not reproduce its own game.");
    }
    // The winner matching is the weak half of the claim. The strong half is
    // that the fork resumed the *same policy with the same per-seat counters*,
    // which shows up only in the command stream and the (seat, index) pairs:
    // two continuations can end in the same winner having played different
    // cards. Policy iteration is the mode where the reference is not the raw
    // production action, so it is the mode where this can silently go wrong.
    if (recordRawProduction) {
      const trace = variantTraces.get(root.variantId);
      const referenceFork = forks[productionIndex];
      if (trace === undefined || referenceFork === undefined) {
        throw new CfInvalidError("The variant's own continuation was not recorded.");
      }
      const divergence = cfTraceDivergence(referenceFork, {
        winner: variantWinner,
        commands: Object.freeze(trace.commands.slice(root.step + 1)),
        decisions: Object.freeze(trace.decisions.slice(root.step + 1)),
      });
      if (divergence !== null) {
        throw new CfInvalidError(`The reference branch did not replay its own game: ${divergence}`);
      }
    }
    const anchored = proposal.anchoredScores;
    const reference = anchored[productionIndex] ?? 0;
    sourceVariantCounts[root.variantId] = (sourceVariantCounts[root.variantId] ?? 0) + 1;
    snapshots.push(Object.freeze({
      meta: Object.freeze({
        datasetVersion,
        featureSchemaVersion: CF_FEATURE_SCHEMA_VERSION,
        rulesVersion: CF_RULES_VERSION,
        policyCommit: spec.policyCommit,
        groupId: spec.groupId,
        dealIndex: spec.dealIndex,
        dealSeed: spec.dealSeed,
        variantId: root.variantId,
        snapshotId: `${spec.groupId}:${root.variantId}:${root.seatDecisionIndex}`,
        gameSeed: root.gameSeed,
        landlord: root.landlord,
        seat: root.seat,
        seatDecisionIndex: root.seatDecisionIndex,
        decisionSeed: cfDecisionSeed(root.gameSeed, root.seat, root.seatDecisionIndex),
        tiers: root.tiers,
        continuationCounters: Object.freeze({
          ...root.counters,
          [root.seat]: root.counters[root.seat] + 1,
        }),
        // Absent under π0, where the raw production action and the reference
        // are the same thing, so a v1 snapshot keeps the bytes it was frozen
        // with rather than gaining a redundant field.
        ...(rawProductionIndex === null ? {} : { rawProductionIndex }),
      }),
      view: root.context.view,
      actions: root.context.legalActions,
      candidates: Object.freeze(proposal.actions.map((_, index) => Object.freeze({
        actionIndex: actionIndexes[index] ?? 0,
        anchoredScore: anchored[index] ?? 0,
        baseScore: proposal.baseScores[index] ?? 0,
      }))),
      productionIndex,
      winners,
      labels,
      diagnostics: Object.freeze({
        legalActionCount: root.context.legalActions.length,
        uniqueCandidateCount: new Set(
          proposal.actions.map((action) => cfCommandKey(cfActionCommand(root.seat, action))),
        ).size,
        expertGap: Object.freeze(anchored.map((score) => reference - score)),
        minRemaining: Math.min(
          root.context.view.remainingCardCounts.human,
          root.context.view.remainingCardCounts["ai-one"],
          root.context.view.remainingCardCounts["ai-two"],
        ),
        totalRemaining:
          root.context.view.remainingCardCounts.human +
          root.context.view.remainingCardCounts["ai-one"] +
          root.context.view.remainingCardCounts["ai-two"],
      }),
    }));
  }

  return Object.freeze({
    groupId: spec.groupId,
    dealIndex: spec.dealIndex,
    totalFarmerRoots: allRoots.length,
    usefulFarmerRoots,
    sampledRoots: snapshots.length,
    sourceVariantCounts: Object.freeze(sourceVariantCounts),
    snapshots: Object.freeze(snapshots),
    forkGames,
    variantWinners: Object.freeze(variantWinners),
  });
}

// ---------------------------------------------------------------------------
// Split assignment
// ---------------------------------------------------------------------------

/**
 * The split is a property of the *group*, and of nothing else. `cfSplitTable`
 * consumes the whole preregistered universe at once so the three counts come
 * out exactly as frozen — a per-group modulo would drift.
 */
export function cfSplitTable(
  start: number,
  end: number,
  counts: Readonly<Record<CfSplit, number>>,
  salt: string,
): ReadonlyMap<number, CfSplit> {
  const groups: number[] = [];
  for (let index = start; index <= end; index += 1) {
    groups.push(index);
  }
  const saltHash = hashString(salt);
  const ordered = [...groups].sort((left, right) => {
    const leftHash = mix32(left ^ saltHash);
    const rightHash = mix32(right ^ saltHash);
    return leftHash - rightHash || left - right;
  });
  const total = counts.train + counts.calibration + counts.heldout;
  if (ordered.length !== total) {
    throw new CfInvalidError(
      `Split counts ${total} do not cover the universe ${start}..${end} (${ordered.length}).`,
    );
  }
  const table = new Map<number, CfSplit>();
  ordered.forEach((dealIndex, position) => {
    const split: CfSplit = position < counts.train
      ? "train"
      : position < counts.train + counts.calibration
        ? "calibration"
        : "heldout";
    table.set(dealIndex, split);
  });
  return table;
}

/**
 * The training row: features plus the label, and the group it belongs to.
 * Built only from redacted data and candidate indices.
 */
export type CfRow = Readonly<{
  groupId: string;
  snapshotId: string;
  split: CfSplit;
  x: readonly number[];
  y: CfLabel;
  /** Reporting buckets, joined from the snapshot's diagnostics. Never features. */
  seat: Seat;
  expertGap: number;
  minRemaining: number;
}>;

/**
 * Every non-a0 candidate row of a snapshot. The a0 row is deliberately absent:
 * its label is zero by construction and training on it would teach the model
 * that abstaining is a candidate action.
 */
export function cfRows(snapshot: CfSnapshot, split: CfSplit): readonly CfRow[] {
  const rows: CfRow[] = [];
  const reference = snapshot.actions[snapshot.candidates[snapshot.productionIndex]?.actionIndex ?? 0];
  if (reference === undefined) {
    throw new CfInvalidError("Snapshot has no reference action.");
  }
  snapshot.candidates.forEach((candidate, index) => {
    if (index === snapshot.productionIndex) {
      return;
    }
    const action = snapshot.actions[candidate.actionIndex];
    const label = snapshot.labels[index];
    if (action === undefined || label === undefined) {
      throw new CfInvalidError("Snapshot candidate is missing its action or label.");
    }
    rows.push(Object.freeze({
      groupId: snapshot.meta.groupId,
      snapshotId: snapshot.meta.snapshotId,
      split,
      x: cfRow(snapshot.view, action, reference),
      y: label,
      seat: snapshot.meta.seat,
      expertGap: snapshot.diagnostics.expertGap[index] ?? 0,
      minRemaining: snapshot.diagnostics.minRemaining,
    }));
  });
  return Object.freeze(rows);
}

/**
 * Row weights: every useful root carries the same total weight, and that weight
 * is shared out among its alternatives; every group carries the same total
 * weight, shared out among its sampled roots. Without this, a group that
 * happened to offer three roots with three candidates each would outweigh a
 * group that offered one root with one alternative.
 */
export function cfRowWeights(
  rows: readonly CfRow[],
  rootsPerGroup: ReadonlyMap<string, number>,
): readonly number[] {
  const candidatesPerRoot = new Map<string, number>();
  for (const row of rows) {
    candidatesPerRoot.set(row.snapshotId, (candidatesPerRoot.get(row.snapshotId) ?? 0) + 1);
  }
  const raw = rows.map((row) => {
    const roots = Math.max(1, rootsPerGroup.get(row.groupId) ?? 1);
    const alternatives = Math.max(1, candidatesPerRoot.get(row.snapshotId) ?? 1);
    return 1 / (roots * alternatives);
  });
  const mean = raw.length === 0 ? 0 : raw.reduce((sum, value) => sum + value, 0) / raw.length;
  return Object.freeze(mean === 0 ? raw : raw.map((value) => value / mean));
}

export { dealDeck, startWithLandlord } from "./ai-tournament.js";
