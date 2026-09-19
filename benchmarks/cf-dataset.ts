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
import { getCard, type CardId } from "../src/core/cards/index.js";
import {
  SEAT_ORDER,
  transition,
  type GameCommand,
  type GameState,
  type PlayHistoryEntry,
  type Seat,
} from "../src/core/game/index.js";
import {
  RANK_ORDER,
  generateLegalActions,
  rankStrength,
  type PlayPattern,
  type ValidatedPlayAction,
} from "../src/core/rules/index.js";
import {
  DEFAULT_AI_STRATEGY,
  createPlayerView,
  type AiDecisionContext,
  type PlayingPlayerView,
} from "../src/core/ai/index.js";
import {
  estimateBasicHandTurns,
  rankPlayActionsWithProposal,
} from "../src/core/ai/enhanced.js";
import { currentPlaySeat, isSameSide } from "../src/core/ai/state-evaluator.js";
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

/** Mirrors the literal in `master-policy.ts` (`expert.slice(0, 3)`). */
export const CF_CANDIDATE_LIMIT = 3;
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

/**
 * Raised when the pipeline cannot produce a *valid* row. The spec is explicit
 * that this is not a label: a fork that does not reach a terminal position is
 * an INVALID pipeline result, not a `0`.
 */
export class CfInvalidError extends Error {}

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

function seatIndex(seat: Seat): number {
  return SEAT_ORDER.indexOf(seat);
}

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

// ---------------------------------------------------------------------------
// Shared command/action helpers
// ---------------------------------------------------------------------------

/** A canonical identity for a play command: card order carries no meaning. */
export function cfCommandKey(command: GameCommand): string {
  switch (command.type) {
    case "pass":
      return "pass";
    case "play":
      return [...command.cards].sort((left, right) => left - right).join(",");
    case "deal":
      return "deal";
    case "bid":
      return `bid:${command.seat}:${command.decision}`;
    case "restart":
      return "restart";
  }
}

export function cfActionCommand(seat: Seat, action: ValidatedPlayAction): GameCommand {
  return action.type === "pass"
    ? Object.freeze({ type: "pass", seat })
    : Object.freeze({
        type: "play",
        seat,
        cards: Object.freeze([...action.play.cards]),
      });
}

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

// ---------------------------------------------------------------------------
// The candidate set
// ---------------------------------------------------------------------------

export type CfProposal = Readonly<{
  /** The shipped expert shortlist, in the shipped ordering, capped at 3. */
  actions: readonly ValidatedPlayAction[];
  /** `anchoredScore` per candidate — diagnostic storage only, never a feature. */
  anchoredScores: readonly number[];
  /** The same evaluation without `defaultPolicyPrior`. */
  baseScores: readonly number[];
}>;

/**
 * The candidate set is production's own: the expert ranking's top three, in the
 * shipped ordering. Nothing here re-scores, re-orders or widens it.
 */
export function cfProposal(context: PlayContext): CfProposal {
  const proposal = rankPlayActionsWithProposal(context, "expert", {
    analyzerNodes: CF_PROPOSAL_ANALYZER_NODES,
  });
  const top = proposal.anchored.slice(0, CF_CANDIDATE_LIMIT);
  const actions: ValidatedPlayAction[] = [];
  const anchoredScores: number[] = [];
  const baseScores: number[] = [];
  for (const entry of top) {
    const detail = proposal.details.find((candidate) => candidate.action === entry.action);
    actions.push(entry.action);
    anchoredScores.push(entry.score);
    baseScores.push(detail?.baseScore ?? entry.score);
  }
  return Object.freeze({
    actions: Object.freeze(actions),
    anchoredScores: Object.freeze(anchoredScores),
    baseScores: Object.freeze(baseScores),
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
 * Plays from `state` to a real terminal position under π0 alone. Both fork
 * branches call this same function with the same tiers and counters, which is
 * the "after the first hand, both branches restore the identical policy" half
 * of the counterfactual.
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
    const command = cfPolicyCommand(tiers, gameSeed, seat, context, active[seat]);
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
 * Forks the state once for the production action and once per candidate, and
 * reduces each terminal winner to a farmer-camp label relative to a0.
 *
 * Both branches consume the acting seat's decision index, because the decision
 * really was made in the full game — only its output is replaced. That is what
 * makes the a0 branch byte-identical to the game the snapshot came from.
 */
export function cfForkLabels(
  state: GameState,
  seat: Seat,
  landlord: Seat,
  commandForCandidate: (index: number) => GameCommand,
  candidateCount: number,
  productionIndex: number,
  counters: CfPolicyCounters,
  tiers: CfSeatTiers,
  gameSeed: number,
): CfForkBundle {
  const after: CfPolicyCounters = { ...counters, [seat]: counters[seat] + 1 };
  const winners: Seat[] = [];
  const forks: CfForkResult[] = [];
  for (let index = 0; index < candidateCount; index += 1) {
    const forced = transition(state, commandForCandidate(index));
    if (!forced.ok) {
      throw new CfInvalidError(`Forced candidate ${index} is illegal for ${seat}.`);
    }
    const fork = cfPlayToTerminal(forced.state, tiers, gameSeed, after);
    forks.push(fork);
    winners.push(fork.winner);
  }
  const reference = winners[productionIndex];
  if (reference === undefined) {
    throw new CfInvalidError("The production action is not one of the candidates.");
  }
  const labels = winners.map((winner) => cfLabel(seat, landlord, reference, winner));
  return Object.freeze({
    labels: Object.freeze(labels),
    winners: Object.freeze(winners),
    forks: Object.freeze(forks),
  });
}

// ---------------------------------------------------------------------------
// Feature representation — Option C
//
//   x(o, a, a0) = [ context(o), phi(o,a), phi(o,a0), delta_numeric(o,a,a0) ]
//
// `phi` splits into a categorical half, which is encoded once per action and
// never differenced (a category integer minus a category integer is not a
// quantity), and a numeric half, which is supplied raw for both actions *and*
// as a difference. Missing numerics are `NaN`, which is also what LightGBM
// reads as missing; nothing is ever encoded as a sentinel and then subtracted.
// ---------------------------------------------------------------------------

export const CF_CONTEXT_NAMES: readonly string[] = Object.freeze([
  "seatDistanceFromLandlord",
  "partnerDistanceFromLandlord",
  "leadingFree",
  "trailingPasses",
  "trickOwnerIsSelf",
  "trickOwnerIsPartner",
  "trickOwnerIsOpponent",
  "partnerPassedLast",
  "opponentPassedLast",
  "selfRemaining",
  "partnerRemaining",
  "opponentRemaining",
  "ownSideRemaining",
  "opponentSideRemaining",
  "partnerNearOut",
  "opponentNearOut",
  "selfNearOut",
  "selfMinTurns",
  "selfLooseSingles",
  "selfControlCards",
  "ownHoldsBothJokers",
  "historyPlayCount",
  "historyPassCount",
  "publicBombsSeen",
  "publicJokersSeen",
  "totalRemaining",
  "turnIndex",
]);

/**
 * Categorical / indicator slots, per action. Encoded separately for the
 * candidate and for a0; **never** differenced.
 */
export const CF_ACTION_CAT_NAMES: readonly string[] = Object.freeze([
  "familyPass",
  "familySingle",
  "familyPair",
  "familyTriple",
  "familySequence",
  "familyFour",
  "familyBomb",
  "usesJoker",
  "usesTopRank",
  "emptiesHand",
  "nextIsSelf",
  "nextIsPartner",
  "nextIsOpponent",
]);

/** Numeric slots, per action. Supplied raw and again as candidate − a0. */
export const CF_ACTION_NUM_NAMES: readonly string[] = Object.freeze([
  "cardCount",
  "mainRankStrength",
  "sequenceLength",
  "afterTurns",
  "turnsDelta",
  "afterLooseSingles",
  "afterControlCards",
  "breaksPair",
  "breaksTriple",
  "breaksFour",
  "unseenHigher",
]);

function repeated(prefix: string, names: readonly string[]): string[] {
  return names.map((name) => `${prefix}${name}`);
}

/**
 * The frozen column order. Any change to this list is a new schema version and
 * invalidates a generated corpus, which is why the corpus manifest carries a
 * hash of exactly this array.
 */
export const CF_FEATURE_NAMES: readonly string[] = Object.freeze([
  ...CF_CONTEXT_NAMES,
  ...repeated("cand_", CF_ACTION_CAT_NAMES),
  ...repeated("cand_", CF_ACTION_NUM_NAMES),
  ...repeated("a0_", CF_ACTION_CAT_NAMES),
  ...repeated("a0_", CF_ACTION_NUM_NAMES),
  ...repeated("delta_", CF_ACTION_NUM_NAMES),
]);

export const CF_ACTION_CAT_OFFSET = CF_CONTEXT_NAMES.length;
export const CF_ACTION_NUM_OFFSET = CF_ACTION_CAT_OFFSET + CF_ACTION_CAT_NAMES.length;
export const CF_A0_CAT_OFFSET = CF_ACTION_NUM_OFFSET + CF_ACTION_NUM_NAMES.length;
export const CF_A0_NUM_OFFSET = CF_A0_CAT_OFFSET + CF_ACTION_CAT_NAMES.length;
export const CF_DELTA_OFFSET = CF_A0_NUM_OFFSET + CF_ACTION_NUM_NAMES.length;

export type CfPatternFamily =
  | "pass"
  | "single"
  | "pair"
  | "triple"
  | "sequence"
  | "four"
  | "bomb";

const CF_FAMILIES: readonly CfPatternFamily[] = Object.freeze([
  "pass",
  "single",
  "pair",
  "triple",
  "sequence",
  "four",
  "bomb",
]);

function patternFamilyOf(pattern: PlayPattern): CfPatternFamily {
  switch (pattern.kind) {
    case "single":
      return "single";
    case "pair":
      return "pair";
    case "triple":
    case "triple-with-single":
    case "triple-with-pair":
      return "triple";
    case "straight":
    case "consecutive-pairs":
    case "airplane":
    case "airplane-with-singles":
    case "airplane-with-pairs":
      return "sequence";
    case "four-with-two-cards":
    case "four-with-two-pairs":
      return "four";
    case "bomb":
    case "rocket":
      return "bomb";
  }
}

function mainRankStrengthOf(pattern: PlayPattern): number {
  // A rocket has no main rank. `NaN` is the honest encoding, and it propagates
  // into the delta rather than inventing a sentinel like 15.
  return pattern.kind === "rocket" ? Number.NaN : rankStrength(pattern.mainRank);
}

function sequenceLengthOf(pattern: PlayPattern): number {
  return "sequenceLength" in pattern ? pattern.sequenceLength : Number.NaN;
}

function groupCounts(cards: readonly CardId[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const cardId of cards) {
    const rank = getCard(cardId).rank;
    counts.set(rank, (counts.get(rank) ?? 0) + 1);
  }
  return counts;
}

function partnerSeatOf(view: PlayingPlayerView): Seat {
  return SEAT_ORDER.find((seat) => seat !== view.seat && seat !== view.landlord) ?? view.seat;
}

function nextSeatOf(seat: Seat): Seat {
  return SEAT_ORDER[(seatIndex(seat) + 1) % SEAT_ORDER.length] ?? seat;
}

function remainingAfter(view: PlayingPlayerView, action: ValidatedPlayAction): CardId[] {
  if (action.type === "pass") {
    return [...view.hand];
  }
  const played = new Set(action.play.cards);
  return view.hand.filter((cardId) => !played.has(cardId));
}

function looseSingles(cards: readonly CardId[]): number {
  let singles = 0;
  for (const count of groupCounts(cards).values()) {
    if (count === 1) {
      singles += 1;
    }
  }
  return singles;
}

function controlCards(cards: readonly CardId[]): number {
  const floor = rankStrength("A");
  return cards.filter((cardId) => rankStrength(getCard(cardId).rank) >= floor).length;
}

/** Cards above the pattern's main rank that no public source has accounted for. */
function unseenHigherUnaccounted(view: PlayingPlayerView, pattern: PlayPattern): number {
  if (pattern.kind !== "single" && pattern.kind !== "pair" && pattern.kind !== "bomb") {
    return Number.NaN;
  }
  const seen = new Map<string, number>();
  const add = (cards: readonly CardId[]) => {
    for (const cardId of cards) {
      const rank = getCard(cardId).rank;
      seen.set(rank, (seen.get(rank) ?? 0) + 1);
    }
  };
  add(view.hand);
  add(view.bottomCards);
  for (const entry of view.history) {
    if (entry.type === "play") {
      add(entry.play.cards);
    }
  }
  const strength = mainRankStrengthOf(pattern);
  let unseen = 0;
  for (let index = strength + 1; index < RANK_ORDER.length; index += 1) {
    const rank = RANK_ORDER[index];
    if (rank === undefined) {
      continue;
    }
    const total = rank === "small-joker" || rank === "big-joker" ? 1 : 4;
    unseen += Math.max(0, total - (seen.get(rank) ?? 0));
  }
  return unseen;
}

function lastPlayEntry(history: readonly PlayHistoryEntry[]): PlayHistoryEntry | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry?.type === "play") {
      return entry;
    }
  }
  return null;
}

/**
 * Public sources only: plays on the table and the revealed bottom cards. The
 * seat's own hand is excluded here so that "how many jokers are still out
 * there" means the same thing at every row; the own-hand fact has its own slot.
 */
function publicCardsSeen(view: PlayingPlayerView): Readonly<{ bombs: number; jokers: number }> {
  let bombs = 0;
  let jokers = 0;
  const countJokers = (cards: readonly CardId[]) => {
    for (const cardId of cards) {
      const rank = getCard(cardId).rank;
      if (rank === "small-joker" || rank === "big-joker") {
        jokers += 1;
      }
    }
  };
  for (const entry of view.history) {
    if (entry.type !== "play") {
      continue;
    }
    const kind = entry.play.pattern.kind;
    if (kind === "bomb" || kind === "rocket") {
      bombs += 1;
    }
    countJokers(entry.play.cards);
  }
  countJokers(view.bottomCards);
  return Object.freeze({ bombs, jokers });
}

export type CfActionFeatures = Readonly<{
  cat: readonly number[];
  num: readonly number[];
}>;

/**
 * `phi(o, a)`: the per-action representation, split into the half that may be
 * differenced and the half that may not.
 *
 * Takes a view and an action and nothing else. A landlord view is rejected
 * outright: Gate A v1 is farmers only, and a landlord row would silently answer
 * a different question.
 */
export function cfActionFeatures(
  view: PlayingPlayerView,
  action: ValidatedPlayAction,
): CfActionFeatures {
  if (view.seat === view.landlord) {
    throw new CfInvalidError("Counterfactual features are defined for farmers only.");
  }
  const partner = partnerSeatOf(view);
  const opponent = view.landlord;
  const isPlay = action.type === "play";
  const pattern = isPlay ? action.play.pattern : null;
  const family = pattern === null ? "pass" : patternFamilyOf(pattern);
  const before = view.hand;
  const after = remainingAfter(view, action);
  const counts = groupCounts(before);
  const used = isPlay ? groupCounts(action.play.cards) : new Map<string, number>();

  const breaksPair = [...used].filter(([rank, taken]) => (counts.get(rank) ?? 0) === 2 && taken === 1).length;
  const breaksTriple = [...used].filter(([rank, taken]) => (counts.get(rank) ?? 0) === 3 && taken < 3).length;
  const breaksFour = [...used].filter(([rank, taken]) => (counts.get(rank) ?? 0) === 4 && taken < 4).length;

  const emptiesHand = isPlay && action.play.cards.length === view.hand.length;
  let nextActor: Seat | null = null;
  if (!emptiesHand) {
    const owner = currentPlaySeat(view);
    const trailing = view.history[view.history.length - 1]?.type === "pass";
    nextActor = action.type === "pass" && trailing && owner !== null ? owner : nextSeatOf(view.seat);
  }

  const beforeTurns = estimateBasicHandTurns(before);
  const afterTurns = estimateBasicHandTurns(after);
  const usesJoker = isPlay && action.play.cards.some((cardId) => {
    const rank = getCard(cardId).rank;
    return rank === "small-joker" || rank === "big-joker";
  });
  const usesTopRank = isPlay && action.play.cards.some(
    (cardId) => rankStrength(getCard(cardId).rank) >= rankStrength("2"),
  );

  const cat = CF_FAMILIES.map((candidate) => (family === candidate ? 1 : 0));
  cat.push(usesJoker ? 1 : 0);
  cat.push(usesTopRank ? 1 : 0);
  cat.push(emptiesHand ? 1 : 0);
  cat.push(nextActor === view.seat ? 1 : 0);
  cat.push(nextActor === partner ? 1 : 0);
  cat.push(nextActor === opponent ? 1 : 0);

  const num = [
    isPlay ? action.play.cards.length : 0,
    pattern === null ? Number.NaN : mainRankStrengthOf(pattern),
    pattern === null ? Number.NaN : sequenceLengthOf(pattern),
    afterTurns,
    beforeTurns - afterTurns,
    looseSingles(after),
    controlCards(after),
    breaksPair,
    breaksTriple,
    breaksFour,
    pattern === null ? Number.NaN : unseenHigherUnaccounted(view, pattern),
  ];

  return Object.freeze({ cat: Object.freeze(cat), num: Object.freeze(num) });
}

/**
 * `context(o)`: public state shared by every candidate at this root. Depends on
 * the view alone, so it is identical across the candidate and a0 halves by
 * construction.
 */
export function cfContextFeatures(view: PlayingPlayerView): readonly number[] {
  if (view.seat === view.landlord) {
    throw new CfInvalidError("Counterfactual features are defined for farmers only.");
  }
  const partner = partnerSeatOf(view);
  const opponent = view.landlord;
  const lastPlay = lastPlayEntry(view.history);
  const lastEntry = view.history[view.history.length - 1] ?? null;
  const seen = publicCardsSeen(view);
  const selfRemaining = view.remainingCardCounts[view.seat];
  const partnerRemaining = view.remainingCardCounts[partner];
  const opponentRemaining = view.remainingCardCounts[opponent];
  const ownJokers = [...groupCounts(view.hand).keys()].filter(
    (rank) => rank === "small-joker" || rank === "big-joker",
  ).length;

  return Object.freeze([
    (seatIndex(view.seat) - seatIndex(view.landlord) + 3) % 3,
    (seatIndex(partner) - seatIndex(view.landlord) + 3) % 3,
    view.currentPlay === null ? 1 : 0,
    view.currentPlay !== null && view.history[view.history.length - 1]?.type === "pass" ? 1 : 0,
    lastPlay !== null && lastPlay.seat === view.seat ? 1 : 0,
    lastPlay !== null && lastPlay.seat === partner ? 1 : 0,
    lastPlay !== null && lastPlay.seat === opponent ? 1 : 0,
    lastEntry !== null && lastEntry.type === "pass" && lastEntry.seat === partner ? 1 : 0,
    lastEntry !== null && lastEntry.type === "pass" && lastEntry.seat === opponent ? 1 : 0,
    selfRemaining,
    partnerRemaining,
    opponentRemaining,
    selfRemaining + partnerRemaining,
    opponentRemaining,
    partnerRemaining <= 2 ? 1 : 0,
    opponentRemaining <= 2 ? 1 : 0,
    selfRemaining <= 2 ? 1 : 0,
    estimateBasicHandTurns(view.hand),
    looseSingles(view.hand),
    controlCards(view.hand),
    ownJokers === 2 ? 1 : 0,
    view.history.filter((entry) => entry.type === "play").length,
    view.history.filter((entry) => entry.type === "pass").length,
    seen.bombs,
    seen.jokers,
    selfRemaining + partnerRemaining + opponentRemaining,
    view.history.length,
  ]);
}

/**
 * `delta_numeric(o, a, a0)`: candidate − a0, numeric slots only. `NaN` on either
 * side propagates, so a missing rank never turns into an arithmetic result.
 */
export function cfNumericDelta(
  candidate: readonly number[],
  reference: readonly number[],
): readonly number[] {
  return Object.freeze(candidate.map((value, index) => value - (reference[index] ?? Number.NaN)));
}

/**
 * The training row's inputs.
 *
 * Three arguments, no state, no seed, no deal index: hidden information is
 * unreachable from here rather than merely unwelcome.
 */
export function cfRow(
  view: PlayingPlayerView,
  action: ValidatedPlayAction,
  reference: ValidatedPlayAction,
): readonly number[] {
  const candidate = cfActionFeatures(view, action);
  const referenceFeatures = cfActionFeatures(view, reference);
  return Object.freeze([
    ...cfContextFeatures(view),
    ...candidate.cat,
    ...candidate.num,
    ...referenceFeatures.cat,
    ...referenceFeatures.num,
    ...cfNumericDelta(candidate.num, referenceFeatures.num),
  ]);
}

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
  /** The command the frozen policy actually played here — the dataset's a0. */
  command: GameCommand;
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
 * Plays one variant to its terminal under π0, collecting every farmer root the
 * studied seat faced. No forking happens here — the group decides what to keep
 * only after every variant has been enumerated.
 */
function cfPlayVariant(
  deck: readonly CardId[],
  variant: CfVariantSpec,
): Readonly<{ winner: Seat; roots: readonly PendingRoot[] }> {
  if (variant.studiedSeat === variant.landlord) {
    throw new CfInvalidError("Gate A v1 studies farmer roots only.");
  }
  let state: GameState = startWithLandlord(deck, variant.landlord);
  const counters: CfPolicyCounters = { human: 0, "ai-one": 0, "ai-two": 0 };
  const roots: PendingRoot[] = [];
  for (let step = 0; step < 256; step += 1) {
    if (state.phase === "finished") {
      return Object.freeze({ winner: state.winner, roots: Object.freeze(roots) });
    }
    if (state.phase !== "playing" && state.phase !== "ready-to-play") {
      throw new CfInvalidError(`Counterfactual game reached phase ${state.phase}.`);
    }
    const seat = state.currentSeat;
    const context = cfPlayContext(state, seat);
    const command = cfPolicyCommand(variant.tiers, variant.gameSeed, seat, context, counters[seat]);
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
        context,
      });
    }
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
 * Enumerates one initial deal group: plays every variant, ranks every farmer
 * root by its keyed priority, and forks the highest-priority eligible roots up
 * to the group cap.
 *
 * Two properties this function exists to guarantee:
 *   - the cap is per *group*, not per game or per seat;
 *   - a group with no eligible root is still registered, with zero snapshots,
 *     and is never back-filled from another deal.
 */
export function cfCaptureGroup(deck: readonly CardId[], spec: CfGroupSpec): CfGroupResult {
  const allRoots: PendingRoot[] = [];
  const variantWinners: Record<string, Seat> = {};
  for (const variant of spec.variants) {
    const played = cfPlayVariant(deck, variant);
    variantWinners[variant.variantId] = played.winner;
    allRoots.push(...played.roots);
  }

  const ordered = [...allRoots].sort((left, right) => {
    const leftPriority = cfSnapshotPriority(
      CF_SNAPSHOT_SALT,
      spec.groupId,
      left.variantId,
      left.seatDecisionIndex,
    );
    const rightPriority = cfSnapshotPriority(
      CF_SNAPSHOT_SALT,
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
    const { labels, winners } = cfForkLabels(
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
    );
    forkGames += proposal.actions.length;
    // Self-check, every snapshot, on the real tier: forcing the production
    // action must reproduce the game the snapshot was taken from. If this ever
    // fires, the per-seat decision counters did not survive the fork and every
    // label in the corpus is measured against the wrong reference.
    const variantWinner = variantWinners[root.variantId];
    if (winners[productionIndex] !== variantWinner) {
      throw new CfInvalidError("The forced production branch did not reproduce its own game.");
    }
    const anchored = proposal.anchoredScores;
    const reference = anchored[productionIndex] ?? 0;
    sourceVariantCounts[root.variantId] = (sourceVariantCounts[root.variantId] ?? 0) + 1;
    snapshots.push(Object.freeze({
      meta: Object.freeze({
        datasetVersion: CF_DATASET_VERSION,
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
