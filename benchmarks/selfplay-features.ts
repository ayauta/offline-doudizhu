/**
 * The full-action self-play state-action feature schema.
 *
 *     features(legal observation, candidate action) -> number[]
 *
 * Three properties are load-bearing, and each is a deliberate departure from the
 * frozen 86-column counterfactual schema (`src/core/ai/cf-features.ts`):
 *
 * 1. **No parent action.** `cfRow` takes three arguments — the view, the
 *    candidate, and the reference action `a0` that production would have played —
 *    and 35 of its 86 columns describe `a0` or the difference from it. A
 *    full-action policy cannot do that: the whole point is to rank actions
 *    without first asking the old policy what it thinks. Every column here is a
 *    function of `(view, action)` alone, and `selfplayRow.length` is asserted to
 *    be 2 so a third input cannot quietly appear.
 *
 * 2. **Legal observation only.** The inputs are a `PlayingPlayerView` and a legal
 *    action, so hidden hands are unreachable rather than merely unwelcome: there
 *    is no `GameState` in scope. No deal seed, deal id, batch id, episode id,
 *    terminal result, future event or policy identity reaches a column.
 *    `pub_unseen_h_*` counts are aggregates over "cards that are not mine and
 *    have not been played publicly", which is exactly what a player at the table
 *    can compute; the vector does not say how the unseen cards are split between
 *    the two other seats. Public pass history is encoded as behaviour only — the
 *    schema never turns "this seat passed" into "this seat holds no card of that
 *    rank".
 *
 * 3. **No hand-crafted move quality.** The engine's own `HandEvaluation` bundles
 *    two weighted sums, `controlCards` (1/2/3/4 per ace/two/joker) and
 *    `structureScore` (2/5/7/8/10/9/12 per shape), whose coefficients were chosen
 *    by hand. Neither is reused: a feature that already says "this is a good
 *    hand" would make "the model only learned state strength" indistinguishable
 *    from "the schema handed it the answer". What is kept are the unweighted
 *    counts those weights were built from, plus `minimumTurns`, a structural
 *    quantity.
 *
 * History is bounded, and the bound is frozen at `SELFPLAY_HISTORY_LENGTH`.
 * Everything older survives only as the cumulative public tallies. This is not
 * a complete history representation and does not claim to be one.
 */
import { type CardId } from "../src/core/cards/index.js";
import { SEAT_ORDER, type PlayHistoryEntry, type Seat } from "../src/core/game/index.js";
import { RANK_ORDER, SEQUENCE_RANKS, type PlayPattern, type ValidatedPlayAction } from "../src/core/rules/index.js";
import type { PlayingPlayerView } from "../src/core/ai/ai.js";

export const SELFPLAY_FEATURE_SCHEMA_VERSION = 1;

/** Frozen: the most recent public events carried into a row. */
export const SELFPLAY_HISTORY_LENGTH = 12;

/** `RANK_ORDER` is `3 … A, 2, small-joker, big-joker`; the jokers are last. */
const SLOT_OF_TWO = RANK_ORDER.indexOf("2");
const SLOT_OF_SMALL_JOKER = RANK_ORDER.indexOf("small-joker");
const SLOT_OF_BIG_JOKER = RANK_ORDER.indexOf("big-joker");
const SLOT_OF_KING = RANK_ORDER.indexOf("K");

/**
 * Categorical pattern encoding. `-1` means "there is no action here" and is used
 * for history padding and for an absent trick; `0` means a real pass. Keeping
 * those distinct matters, because "nobody has played yet" and "the last event
 * was a pass" are different states.
 */
export const SELFPLAY_PATTERN_KINDS: readonly string[] = Object.freeze([
  "pass",
  "single",
  "pair",
  "triple",
  "triple-with-single",
  "triple-with-pair",
  "straight",
  "consecutive-pairs",
  "airplane",
  "airplane-with-singles",
  "airplane-with-pairs",
  "four-with-two-cards",
  "four-with-two-pairs",
  "bomb",
  "rocket",
]);

const PATTERN_KIND_INDEX = new Map<string, number>(
  SELFPLAY_PATTERN_KINDS.map((kind, index) => [kind, index]),
);

export const NO_ACTION_PATTERN_INDEX = -1;

export function patternIndexOf(kind: string): number {
  return PATTERN_KIND_INDEX.get(kind) ?? NO_ACTION_PATTERN_INDEX;
}

/** Slot of a card in `RANK_ORDER`; the two jokers are the last two slots. */
export function rankSlot(cardId: CardId): number {
  return cardId < 52
    ? Math.floor(cardId / 4)
    : cardId === 52
      ? SLOT_OF_SMALL_JOKER
      : SLOT_OF_BIG_JOKER;
}

/** Copies of a rank in a full deck: four for standard ranks, one per joker. */
function copiesInDeck(slot: number): number {
  return slot < SLOT_OF_SMALL_JOKER ? 4 : 1;
}

export function zeroCounts(): number[] {
  return new Array<number>(RANK_ORDER.length).fill(0);
}

export function countsOf(cards: readonly CardId[]): number[] {
  const counts = zeroCounts();
  for (const cardId of cards) {
    const slot = rankSlot(cardId);
    counts[slot] = (counts[slot] ?? 0) + 1;
  }
  return counts;
}

/**
 * Maximal windows of the standard ladder in which every rank holds at least
 * `perRank` cards. `runs` counts windows of at least `minimum`; `longest` is the
 * longest window of any length. The two-and-the-jokers tail is excluded by
 * construction, which is what `SEQUENCE_RANKS` is for.
 */
export function maximalRuns(
  counts: readonly number[],
  perRank: number,
  minimum: number,
): { readonly runs: number; readonly longest: number } {
  let runs = 0;
  let longest = 0;
  let length = 0;

  for (let index = 0; index < SEQUENCE_RANKS.length; index += 1) {
    if ((counts[index] ?? 0) >= perRank) {
      length += 1;
    } else {
      if (length >= minimum) {
        runs += 1;
      }
      longest = Math.max(longest, length);
      length = 0;
    }
  }
  if (length >= minimum) {
    runs += 1;
  }
  longest = Math.max(longest, length);

  return { runs, longest };
}

/**
 * The engine's `estimateBasicHandTurns`, recomputed from a count vector so a
 * candidate action's post-hand can be scored without rebuilding card arrays.
 * `tests/core/selfplay-features.test.ts` pins this against
 * `estimateBasicHandTurns` over a table of hands and over random hands, because
 * a fast path that drifts from the engine's descriptor would silently change
 * what the model sees.
 */
export function minimumTurnsFromCounts(counts: readonly number[]): number {
  let cardCount = 0;
  let groups = 0;
  for (const count of counts) {
    cardCount += count;
    if (count > 0) {
      groups += 1;
    }
  }
  if (cardCount === 0) {
    return 0;
  }

  const straightSavings = maximalRuns(counts, 1, 5).runs * 4;
  const pairSavings = maximalRuns(counts, 2, 3).runs * 2;
  const airplaneSavings = maximalRuns(counts, 3, 2).runs * 2;
  groups -= Math.max(straightSavings, pairSavings, airplaneSavings);

  const triples = counts.filter((count) => count === 3).length;
  const attachments = counts.filter((count) => count === 1 || count === 2).length;
  groups -= Math.min(triples, attachments);

  return Math.max(1, groups);
}

/** Unweighted structural descriptors of one hand, from its count vector. */
export interface HandShape {
  readonly cardCount: number;
  readonly distinctRanks: number;
  readonly singles: number;
  readonly pairs: number;
  readonly triples: number;
  readonly quads: number;
  readonly hasRocket: number;
  readonly sequenceRuns: number;
  readonly longestSequenceRun: number;
  readonly pairRuns: number;
  readonly longestPairRun: number;
  readonly tripleRuns: number;
  readonly longestTripleRun: number;
  readonly minimumTurns: number;
  readonly nAces: number;
  readonly nTwos: number;
  readonly nSmallJoker: number;
  readonly nBigJoker: number;
  readonly looseSingles: number;
}

export function handShapeOf(counts: readonly number[]): HandShape {
  const sequences = maximalRuns(counts, 1, 5);
  const pairs = maximalRuns(counts, 2, 3);
  const triples = maximalRuns(counts, 3, 2);

  let cardCount = 0;
  let distinctRanks = 0;
  let singles = 0;
  let pairCount = 0;
  let tripleCount = 0;
  let quads = 0;
  let looseSingles = 0;
  for (let slot = 0; slot < counts.length; slot += 1) {
    const count = counts[slot] ?? 0;
    cardCount += count;
    if (count === 0) {
      continue;
    }
    distinctRanks += 1;
    if (count === 1) {
      singles += 1;
      // A "loose single" is a lone card at or below the king — the engine's own
      // notion (`count === 1 && index < 11` over `STANDARD_RANKS`).
      if (slot <= SLOT_OF_KING) {
        looseSingles += 1;
      }
    } else if (count === 2) {
      pairCount += 1;
    } else if (count === 3) {
      tripleCount += 1;
    } else {
      quads += 1;
    }
  }

  return {
    cardCount,
    distinctRanks,
    singles,
    pairs: pairCount,
    triples: tripleCount,
    quads,
    hasRocket:
      (counts[SLOT_OF_SMALL_JOKER] ?? 0) > 0 && (counts[SLOT_OF_BIG_JOKER] ?? 0) > 0 ? 1 : 0,
    sequenceRuns: sequences.runs,
    longestSequenceRun: sequences.longest,
    pairRuns: pairs.runs,
    longestPairRun: pairs.longest,
    tripleRuns: triples.runs,
    longestTripleRun: triples.longest,
    minimumTurns: minimumTurnsFromCounts(counts),
    nAces: counts[RANK_ORDER.indexOf("A")] ?? 0,
    nTwos: counts[SLOT_OF_TWO] ?? 0,
    nSmallJoker: counts[SLOT_OF_SMALL_JOKER] ?? 0,
    nBigJoker: counts[SLOT_OF_BIG_JOKER] ?? 0,
    looseSingles,
  };
}

export const HAND_SHAPE_NAMES: readonly (keyof HandShape)[] = Object.freeze([
  "cardCount",
  "distinctRanks",
  "singles",
  "pairs",
  "triples",
  "quads",
  "hasRocket",
  "sequenceRuns",
  "longestSequenceRun",
  "pairRuns",
  "longestPairRun",
  "tripleRuns",
  "longestTripleRun",
  "minimumTurns",
  "nAces",
  "nTwos",
  "nSmallJoker",
  "nBigJoker",
  "looseSingles",
]);

function shapeValues(shape: HandShape): number[] {
  return HAND_SHAPE_NAMES.map((name) => shape[name]);
}

/**
 * Descriptor deltas from the pre-action hand to the post-action hand. Trees can
 * subtract nothing, and "this play costs me two loose singles" is exactly the
 * kind of quantity an action-ranking model needs, so the differences are given
 * explicitly. These are differences within one candidate's own before/after
 * state; there is no reference action anywhere in them.
 */
export const SHAPE_DELTA_NAMES: readonly (keyof HandShape)[] = Object.freeze([
  "cardCount",
  "distinctRanks",
  "singles",
  "pairs",
  "triples",
  "quads",
  "sequenceRuns",
  "longestSequenceRun",
  "pairRuns",
  "tripleRuns",
  "minimumTurns",
  "looseSingles",
]);

const SELF_HAND_NAMES: readonly string[] = Object.freeze([
  ...RANK_ORDER.map((rank) => `self_h_${rank}`),
  ...HAND_SHAPE_NAMES.map((name) => `self_${name}`),
]);

const ACTION_NAMES: readonly string[] = Object.freeze([
  ...RANK_ORDER.map((rank) => `act_h_${rank}`),
  "act_isPass",
  "act_patternKind",
  "act_cardCount",
  "act_mainRankStrength",
  "act_sequenceLength",
  "act_isBomb",
  "act_isRocket",
  "act_isFourWith",
]);

const POST_HAND_NAMES: readonly string[] = Object.freeze([
  ...RANK_ORDER.map((rank) => `post_h_${rank}`),
  ...HAND_SHAPE_NAMES.map((name) => `post_${name}`),
  "post_emptiesHand",
  ...SHAPE_DELTA_NAMES.map((name) => `delta_${name}`),
]);

const PUBLIC_NAMES: readonly string[] = Object.freeze([
  "role_isLandlord",
  "role_seatIndex",
  "role_seatDistanceFromLandlord",
  "pub_selfRemaining",
  "pub_partnerRemaining",
  "pub_opponentRemaining",
  "pub_landlordRemaining",
  "pub_nearestOpponentRemaining",
  "pub_totalRemaining",
  "trick_present",
  ...RANK_ORDER.map((rank) => `trick_h_${rank}`),
  "trick_patternKind",
  "trick_cardCount",
  "trick_mainRankStrength",
  "trick_sequenceLength",
  "trick_ownerIsSelf",
  "trick_ownerIsPartner",
  "trick_ownerIsOpponent",
  "trick_trailingPasses",
  ...RANK_ORDER.map((rank) => `pub_played_h_${rank}`),
  "pub_playedBySelf",
  "pub_playedByPartner",
  "pub_playedByOpponent",
  ...RANK_ORDER.map((rank) => `pub_unseen_h_${rank}`),
  "act_unseenHigherCards",
  "act_unseenHigherPairs",
  "pub_publicBombs",
  "pub_publicJokers",
  "pub_turnIndex",
]);

const HISTORY_EVENT_NAMES: readonly string[] = Object.freeze([
  ...RANK_ORDER.map((rank) => `h_h_${rank}`),
  "h_patternKind",
  "h_isPass",
  "h_actorIsSelf",
  "h_actorIsPartner",
]);

const HISTORY_NAMES: readonly string[] = Object.freeze(
  Array.from({ length: SELFPLAY_HISTORY_LENGTH }, (_, index) =>
    HISTORY_EVENT_NAMES.map((name) => `hist${index}_${name}`),
  ).flat(),
);

export const SELFPLAY_FEATURE_NAMES: readonly string[] = Object.freeze([
  ...SELF_HAND_NAMES,
  ...ACTION_NAMES,
  ...POST_HAND_NAMES,
  ...PUBLIC_NAMES,
  ...HISTORY_NAMES,
]);

export const SELFPLAY_FEATURE_COUNT = SELFPLAY_FEATURE_NAMES.length;

export interface PublicTally {
  readonly played: readonly number[];
  readonly playedBySeat: Readonly<Record<Seat, number>>;
  readonly unseen: readonly number[];
  readonly publicBombs: number;
  readonly publicJokers: number;
  readonly turnIndex: number;
}

/**
 * Cumulative public information, read off the same history array the table shows
 * to everybody. `unseen` is "deck copies minus my own cards minus publicly
 * played cards", floored at zero.
 */
export function publicTally(view: PlayingPlayerView, handCounts: readonly number[]): PublicTally {
  const played = zeroCounts();
  const playedBySeat: Record<Seat, number> = { human: 0, "ai-one": 0, "ai-two": 0 };
  let publicBombs = 0;
  let publicJokers = 0;

  for (const entry of view.history) {
    if (entry.type !== "play") {
      continue;
    }
    for (const cardId of entry.play.cards) {
      const slot = rankSlot(cardId);
      played[slot] = (played[slot] ?? 0) + 1;
    }
    playedBySeat[entry.seat] += entry.play.cards.length;
    if (entry.play.pattern.kind === "bomb") {
      publicBombs += 1;
    }
    if (entry.play.pattern.kind === "rocket") {
      publicJokers += 1;
    }
  }

  const unseen = zeroCounts();
  for (let slot = 0; slot < unseen.length; slot += 1) {
    unseen[slot] = Math.max(
      0,
      copiesInDeck(slot) - (handCounts[slot] ?? 0) - (played[slot] ?? 0),
    );
  }

  return {
    played,
    playedBySeat,
    unseen,
    publicBombs,
    publicJokers,
    turnIndex: view.history.length,
  };
}

function sequenceLengthOf(pattern: PlayPattern): number {
  switch (pattern.kind) {
    case "straight":
    case "consecutive-pairs":
    case "airplane":
    case "airplane-with-singles":
    case "airplane-with-pairs":
      return pattern.sequenceLength;
    default:
      return Number.NaN;
  }
}

/** The seat that is neither `seat` nor `landlord` — a farmer's partner. */
export function partnerOf(seat: Seat, landlord: Seat): Seat | null {
  if (seat === landlord) {
    return null;
  }
  return SEAT_ORDER.find((candidate) => candidate !== seat && candidate !== landlord) ?? null;
}

export function seatDistanceFromLandlord(seat: Seat, landlord: Seat): number {
  return (SEAT_ORDER.indexOf(seat) - SEAT_ORDER.indexOf(landlord) + SEAT_ORDER.length) % SEAT_ORDER.length;
}

/**
 * Public history events carried by the schema, most recent first. Padding for a
 * short history uses `patternKind = -1`, which is distinguishable from a real
 * pass (`patternKind = 0`).
 */
export interface HistoryEventEncoding {
  readonly counts: readonly number[];
  readonly patternKind: number;
  readonly isPass: number;
  readonly actorIsSelf: number;
  readonly actorIsPartner: number;
}

export function encodeHistoryEvent(
  entry: PlayHistoryEntry,
  seat: Seat,
  partner: Seat | null,
): HistoryEventEncoding {
  const shared = {
    actorIsSelf: entry.seat === seat ? 1 : 0,
    actorIsPartner: partner !== null && entry.seat === partner ? 1 : 0,
  };
  if (entry.type === "pass") {
    return {
      counts: zeroCounts(),
      patternKind: patternIndexOf("pass"),
      isPass: 1,
      ...shared,
    };
  }
  return {
    counts: countsOf(entry.play.cards),
    patternKind: patternIndexOf(entry.play.pattern.kind),
    isPass: 0,
    ...shared,
  };
}

export const EMPTY_HISTORY_EVENT: HistoryEventEncoding = Object.freeze({
  counts: Object.freeze(zeroCounts()),
  patternKind: NO_ACTION_PATTERN_INDEX,
  isPass: -1,
  actorIsSelf: -1,
  actorIsPartner: -1,
});

export function recentHistory(
  view: PlayingPlayerView,
  seat: Seat,
  partner: Seat | null,
): readonly HistoryEventEncoding[] {
  const events: HistoryEventEncoding[] = [];
  for (
    let index = view.history.length - 1;
    index >= 0 && events.length < SELFPLAY_HISTORY_LENGTH;
    index -= 1
  ) {
    const entry = view.history[index];
    if (entry !== undefined) {
      events.push(encodeHistoryEvent(entry, seat, partner));
    }
  }
  while (events.length < SELFPLAY_HISTORY_LENGTH) {
    events.push(EMPTY_HISTORY_EVENT);
  }
  return events;
}

/**
 * Who owns the current trick, and how many passes trail behind it. Derived from
 * the public history alone; `tests/core/selfplay-features.test.ts` pins it
 * against the engine's own `currentPlaySeat`.
 */
export function trickOwnership(view: PlayingPlayerView): {
  readonly owner: Seat | null;
  readonly trailingPasses: number;
} {
  let trailingPasses = 0;
  for (let index = view.history.length - 1; index >= 0; index -= 1) {
    const entry = view.history[index];
    if (entry === undefined) {
      continue;
    }
    if (entry.type === "pass") {
      trailingPasses += 1;
      continue;
    }
    return { owner: entry.seat, trailingPasses };
  }
  return { owner: null, trailingPasses: 0 };
}

/**
 * Everything a row needs that does not depend on the candidate action. Built
 * once per decision and reused across every legal action, which is the only
 * reason a full-action policy is affordable: the public tally walks the whole
 * history, and walking it once per candidate would dominate the decision.
 */
export interface SelfPlayStateFeatures {
  readonly seat: Seat;
  readonly landlord: Seat;
  readonly partner: Seat | null;
  readonly opponents: readonly Seat[];
  readonly selfCounts: readonly number[];
  readonly selfShape: HandShape;
  readonly tally: PublicTally;
  readonly ownership: { readonly owner: Seat | null; readonly trailingPasses: number };
  readonly history: readonly HistoryEventEncoding[];
}

export function stateFeaturesOf(view: PlayingPlayerView): SelfPlayStateFeatures {
  const seat = view.seat;
  const landlord = view.landlord;
  const partner = partnerOf(seat, landlord);
  const selfCounts = countsOf(view.hand);

  return {
    seat,
    landlord,
    partner,
    opponents: SEAT_ORDER.filter((candidate) => candidate !== seat && candidate !== partner),
    selfCounts,
    selfShape: handShapeOf(selfCounts),
    tally: publicTally(view, selfCounts),
    ownership: trickOwnership(view),
    history: recentHistory(view, seat, partner),
  };
}

/**
 * A row is built from exactly these two inputs. The arity is asserted by
 * `tests/core/selfplay-features.test.ts`, in the same spirit as the frozen
 * schema's `cfRow.length === 3` guard: a row that could see a third thing could
 * see the answer.
 */
export function selfplayRow(
  view: PlayingPlayerView,
  action: ValidatedPlayAction,
): readonly number[] {
  return selfplayRowFromState(view, stateFeaturesOf(view), action);
}

/** The same row, with the per-decision state work already done. */
export function selfplayRowFromState(
  view: PlayingPlayerView,
  state: SelfPlayStateFeatures,
  action: ValidatedPlayAction,
): readonly number[] {
  const seat = view.seat;
  const landlord = view.landlord;
  const partner = state.partner;
  const opponents = state.opponents;

  const selfCounts = state.selfCounts;
  const selfShape = state.selfShape;

  const isPass = action.type === "pass";
  const playedCounts = isPass ? zeroCounts() : countsOf(action.play.cards);
  const postCounts = zeroCounts();
  for (let slot = 0; slot < postCounts.length; slot += 1) {
    postCounts[slot] = (selfCounts[slot] ?? 0) - (playedCounts[slot] ?? 0);
  }
  const postShape = handShapeOf(postCounts);

  const tally = state.tally;
  const ownership = state.ownership;

  // How many cards of a strictly higher rank could still be out there. This is
  // an aggregate over the unseen pool, not a claim about who holds them.
  const mainRankSlot = isPass
    ? -1
    : action.play.pattern.kind === "rocket"
      ? RANK_ORDER.length
      : RANK_ORDER.indexOf(action.play.pattern.mainRank);
  let unseenHigherCards = 0;
  let unseenHigherPairs = 0;
  if (mainRankSlot >= 0) {
    for (let slot = mainRankSlot + 1; slot < tally.unseen.length; slot += 1) {
      unseenHigherCards += tally.unseen[slot] ?? 0;
      if ((tally.unseen[slot] ?? 0) >= 2) {
        unseenHigherPairs += 1;
      }
    }
  }

  const pattern = isPass ? null : action.play.pattern;

  const row: number[] = [
    ...selfCounts,
    ...shapeValues(selfShape),

    ...playedCounts,
    isPass ? 1 : 0,
    patternIndexOf(isPass ? "pass" : action.play.pattern.kind),
    isPass ? 0 : action.play.cards.length,
    pattern === null || pattern.kind === "rocket"
      ? Number.NaN
      : RANK_ORDER.indexOf(pattern.mainRank),
    pattern === null ? Number.NaN : sequenceLengthOf(pattern),
    pattern !== null && pattern.kind === "bomb" ? 1 : 0,
    pattern !== null && pattern.kind === "rocket" ? 1 : 0,
    pattern !== null &&
    (pattern.kind === "four-with-two-cards" || pattern.kind === "four-with-two-pairs")
      ? 1
      : 0,

    ...postCounts,
    ...shapeValues(postShape),
    postShape.cardCount === 0 ? 1 : 0,
    ...SHAPE_DELTA_NAMES.map(
      (name) => (postShape[name] as number) - (selfShape[name] as number),
    ),

    seat === landlord ? 1 : 0,
    SEAT_ORDER.indexOf(seat),
    seatDistanceFromLandlord(seat, landlord),
    view.remainingCardCounts[seat],
    partner === null ? Number.NaN : view.remainingCardCounts[partner],
    opponents.reduce((sum, opponent) => sum + view.remainingCardCounts[opponent], 0),
    view.remainingCardCounts[landlord],
    Math.min(...opponents.map((opponent) => view.remainingCardCounts[opponent])),
    view.remainingCardCounts.human +
      view.remainingCardCounts["ai-one"] +
      view.remainingCardCounts["ai-two"],

    view.currentPlay === null ? 0 : 1,
    ...(view.currentPlay === null ? zeroCounts() : countsOf(view.currentPlay.cards)),
    view.currentPlay === null
      ? NO_ACTION_PATTERN_INDEX
      : patternIndexOf(view.currentPlay.pattern.kind),
    view.currentPlay === null ? 0 : view.currentPlay.cards.length,
    view.currentPlay === null || view.currentPlay.pattern.kind === "rocket"
      ? Number.NaN
      : RANK_ORDER.indexOf(view.currentPlay.pattern.mainRank),
    view.currentPlay === null ? Number.NaN : sequenceLengthOf(view.currentPlay.pattern),
    ownership.owner === seat ? 1 : 0,
    ownership.owner !== null && ownership.owner === partner ? 1 : 0,
    ownership.owner !== null && ownership.owner !== seat && ownership.owner !== partner ? 1 : 0,
    ownership.trailingPasses,

    ...tally.played,
    tally.playedBySeat[seat],
    partner === null ? Number.NaN : tally.playedBySeat[partner],
    opponents.reduce((sum, opponent) => sum + tally.playedBySeat[opponent], 0),
    ...tally.unseen,
    unseenHigherCards,
    unseenHigherPairs,
    tally.publicBombs,
    tally.publicJokers,
    tally.turnIndex,

    ...state.history.flatMap((event) => [
      ...event.counts,
      event.patternKind,
      event.isPass,
      event.actorIsSelf,
      event.actorIsPartner,
    ]),
  ];

  return Object.freeze(row);
}
