/**
 * The frozen Option-C feature schema, in `src/` because the shipped Worker now
 * builds these rows itself.
 *
 *   x(o, a, a0) = [ context(o), phi(o,a), phi(o,a0), delta_numeric(o,a,a0) ]
 *
 * Moved here verbatim from `benchmarks/cf-dataset.ts`, which now re-exports it.
 * That is deliberate: there is exactly one implementation of the frozen schema,
 * so the corpus, the Gates A/B benchmarks and the shipped Worker cannot drift
 * apart.
 *
 * The one idea it is built around: a row is a pure function of what a player
 * could legally see. `cfRow` takes a `PlayingPlayerView` and two actions and
 * has no access to a `GameState`, so hidden hands are unreachable rather than
 * merely unwelcome.
 */
import { getCard, type CardId } from "../cards/index.js";
import { SEAT_ORDER, type PlayHistoryEntry, type Seat } from "../game/index.js";
import {
  RANK_ORDER,
  rankStrength,
  type PlayPattern,
  type ValidatedPlayAction,
} from "../rules/index.js";
import type { PlayingPlayerView } from "./ai.js";
import { estimateBasicHandTurns } from "./hand-analyzer.js";
import { currentPlaySeat } from "./state-evaluator.js";

/**
 * Raised when the pipeline cannot produce a *valid* row. A fork that does not
 * reach a terminal position is an INVALID pipeline result, not a `0`.
 */
export class CfInvalidError extends Error {}

export function seatIndex(seat: Seat): number {
  return SEAT_ORDER.indexOf(seat);
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
