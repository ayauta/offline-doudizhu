import {
  STANDARD_RANKS,
  getCard,
  type CardId,
  type Rank,
} from "../cards/index.js";
import type { GameCommand, Seat } from "../game/index.js";
import type {
  PlayPattern,
  ValidatedPlayAction,
} from "../rules/index.js";
import type { AiDecisionContext, AiStrategy, PlayingPlayerView } from "./ai.js";

type PlayDecisionContext = Extract<
  AiDecisionContext,
  { readonly kind: "play" }
>;

const RANKS: readonly Rank[] = Object.freeze([
  ...STANDARD_RANKS,
  "small-joker",
  "big-joker",
]);
const SEQUENCE_RANKS = STANDARD_RANKS.slice(0, -1);

const NORMAL_BID_THRESHOLD = 17;
const LAST_BIDDER_THRESHOLD = 8;

function rankStrength(rank: Rank): number {
  return RANKS.indexOf(rank);
}

function groupCounts(cards: readonly CardId[]): ReadonlyMap<Rank, number> {
  const counts = new Map<Rank, number>();
  for (const cardId of cards) {
    const rank = getCard(cardId).rank;
    counts.set(rank, (counts.get(rank) ?? 0) + 1);
  }
  return counts;
}

function maximumSequenceSavings(
  counts: ReadonlyMap<Rank, number>,
  cardsPerRank: number,
  minimumLength: number,
): number {
  let best = 0;
  let start = 0;
  while (start < SEQUENCE_RANKS.length) {
    while (
      start < SEQUENCE_RANKS.length &&
      (counts.get(SEQUENCE_RANKS[start]!) ?? 0) < cardsPerRank
    ) {
      start += 1;
    }
    let end = start;
    while (
      end < SEQUENCE_RANKS.length &&
      (counts.get(SEQUENCE_RANKS[end]!) ?? 0) >= cardsPerRank
    ) {
      end += 1;
    }
    if (end - start >= minimumLength) {
      for (let left = start; left <= end - minimumLength; left += 1) {
        let fullyConsumed = 0;
        for (let right = left; right < end; right += 1) {
          if ((counts.get(SEQUENCE_RANKS[right]!) ?? 0) === cardsPerRank) {
            fullyConsumed += 1;
          }
          if (right - left + 1 >= minimumLength) {
            best = Math.max(best, fullyConsumed - 1);
          }
        }
      }
    }
    start = Math.max(end, start + 1);
  }
  return best;
}

function estimatedHandBurden(hand: readonly CardId[]): number {
  if (hand.length === 0) {
    return 0;
  }
  const counts = groupCounts(hand);
  let bestSavings = Math.max(
    maximumSequenceSavings(counts, 1, 5),
    maximumSequenceSavings(counts, 2, 3),
    maximumSequenceSavings(counts, 3, 2),
  );

  const fullyConsumedTriples = [...counts.values()].filter(
    (count) => count === 3,
  ).length;
  const fullyConsumedAttachments = [...counts.values()].filter(
    (count) => count === 1 || count === 2,
  ).length;
  if (fullyConsumedTriples > 0 && fullyConsumedAttachments > 0) {
    bestSavings = Math.max(bestSavings, 1);
  }

  return Math.max(1, counts.size - bestSavings);
}

function bidStructureScore(hand: readonly CardId[]): number {
  const counts = groupCounts(hand);
  const straightSavings = maximumSequenceSavings(counts, 1, 5);
  const pairSavings = maximumSequenceSavings(counts, 2, 3);
  const airplaneSavings = maximumSequenceSavings(counts, 3, 2);
  return Math.max(
    straightSavings,
    pairSavings > 0 ? pairSavings + 1 : 0,
    airplaneSavings > 0 ? airplaneSavings + 2 : 0,
  );
}

function casualBidStrength(hand: readonly CardId[]): number {
  const counts = groupCounts(hand);
  let score = bidStructureScore(hand);
  const smallJoker = counts.get("small-joker") ?? 0;
  const bigJoker = counts.get("big-joker") ?? 0;
  score += smallJoker * 6 + bigJoker * 8;
  if (smallJoker > 0 && bigJoker > 0) {
    score += 5;
  }
  score += (counts.get("2") ?? 0) * 3;
  score += counts.get("A") ?? 0;

  for (const count of counts.values()) {
    if (count === 4) {
      score += 7;
    } else if (count === 3) {
      score += 1.5;
    } else if (count === 2) {
      score += 0.5;
    }
  }
  return score;
}

function isSameSide(left: Seat, right: Seat, landlord: Seat): boolean {
  return left === landlord ? right === landlord : right !== landlord;
}

function currentPlaySeat(view: PlayingPlayerView): Seat | null {
  for (let index = view.history.length - 1; index >= 0; index -= 1) {
    const entry = view.history[index];
    if (entry?.type === "play") {
      return entry.seat;
    }
  }
  return null;
}

function patternMainRankStrength(pattern: PlayPattern): number {
  return pattern.kind === "rocket"
    ? RANKS.length
    : rankStrength(pattern.mainRank);
}

function patternShapeBonus(pattern: PlayPattern): number {
  switch (pattern.kind) {
    case "single":
      return 0;
    case "pair":
      return 8;
    case "triple":
      return 18;
    case "triple-with-single":
      return 34;
    case "triple-with-pair":
      return 42;
    case "straight":
      return pattern.sequenceLength * 12;
    case "consecutive-pairs":
      return pattern.sequenceLength * 18;
    case "airplane":
      return pattern.sequenceLength * 24;
    case "airplane-with-singles":
      return pattern.sequenceLength * 32;
    case "airplane-with-pairs":
      return pattern.sequenceLength * 38;
    case "four-with-two-cards":
      return 25;
    case "four-with-two-pairs":
      return 35;
    case "bomb":
    case "rocket":
      return 0;
  }
}

function highCardCost(cards: readonly CardId[]): number {
  let cost = 0;
  for (const cardId of cards) {
    switch (getCard(cardId).rank) {
      case "A":
        cost += 6;
        break;
      case "2":
        cost += 18;
        break;
      case "small-joker":
        cost += 30;
        break;
      case "big-joker":
        cost += 40;
        break;
      default:
        break;
    }
  }
  return cost;
}

function structureBreakCost(
  hand: readonly CardId[],
  actionCards: readonly CardId[],
  pattern: PlayPattern,
): number {
  const handCounts = groupCounts(hand);
  const actionCounts = groupCounts(actionCards);
  let cost = 0;
  for (const [rank, used] of actionCounts) {
    const available = handCounts.get(rank) ?? 0;
    if (used >= available) {
      if (
        available === 4 &&
        pattern.kind !== "bomb" &&
        pattern.kind !== "four-with-two-cards" &&
        pattern.kind !== "four-with-two-pairs"
      ) {
        cost += 100;
      }
      continue;
    }
    if (available === 4) {
      cost += used === 1 ? 170 : used === 2 ? 125 : 80;
    } else if (available === 3) {
      cost += used === 1 ? 75 : 50;
    } else if (available === 2) {
      cost += 42;
    }
  }
  return cost;
}

function withoutCards(
  hand: readonly CardId[],
  selected: readonly CardId[],
): readonly CardId[] {
  const selectedSet = new Set(selected);
  return hand.filter((cardId) => !selectedSet.has(cardId));
}

function minimumEnemyCount(view: PlayingPlayerView): number {
  return Math.min(
    ...(["human", "ai-one", "ai-two"] as const)
      .filter((seat) => !isSameSide(view.seat, seat, view.landlord))
      .map((seat) => view.remainingCardCounts[seat]),
  );
}

function passScore(
  view: PlayingPlayerView,
  incumbentSeat: Seat | null,
): number {
  if (
    incumbentSeat !== null &&
    isSameSide(view.seat, incumbentSeat, view.landlord)
  ) {
    return 500;
  }
  const enemyCount = minimumEnemyCount(view);
  if (enemyCount <= 1) {
    return -500;
  }
  if (enemyCount <= 2) {
    return -250;
  }
  if (enemyCount <= 5) {
    return -80;
  }
  return 0;
}

function playScore(
  context: PlayDecisionContext,
  action: Extract<ValidatedPlayAction, { readonly type: "play" }>,
  incumbentSeat: Seat | null,
  beforeBurden: number,
): number {
  const { view } = context;
  const { play } = action;
  if (play.cards.length === view.hand.length) {
    return 1_000_000;
  }

  const remainingHand = withoutCards(view.hand, play.cards);
  const enemyCount = minimumEnemyCount(view);
  const respondingToPartner =
    incumbentSeat !== null &&
    isSameSide(view.seat, incumbentSeat, view.landlord);
  const respondingToEnemy = incumbentSeat !== null && !respondingToPartner;
  const isBomb = play.pattern.kind === "bomb" || play.pattern.kind === "rocket";

  let score = play.cards.length * 60;
  score += patternShapeBonus(play.pattern);
  score += (beforeBurden - estimatedHandBurden(remainingHand)) * 120;
  score -= patternMainRankStrength(play.pattern) * 4;
  score -= highCardCost(play.cards);
  score -= structureBreakCost(view.hand, play.cards, play.pattern);

  if (respondingToPartner) {
    score -= 700;
  }

  if (respondingToEnemy) {
    score += enemyCount <= 1 ? 500 : enemyCount <= 2 ? 280 : enemyCount <= 5 ? 90 : 0;
  } else if (incumbentSeat === null && enemyCount <= 1 && play.pattern.kind === "single") {
    score -= 250;
  }

  if (isBomb) {
    let conservationCost = play.pattern.kind === "rocket" ? 850 : 650;
    if (view.hand.length <= 6) {
      conservationCost -= 250;
    }
    if (respondingToEnemy && enemyCount <= 1) {
      conservationCost = 0;
    } else if (respondingToEnemy && enemyCount <= 2) {
      conservationCost -= 400;
    }
    score -= conservationCost;
  } else if (
    play.pattern.kind === "four-with-two-cards" ||
    play.pattern.kind === "four-with-two-pairs"
  ) {
    score -= 130;
  }

  return score;
}

export function rankCasualPlayActions(
  context: PlayDecisionContext,
): readonly ValidatedPlayAction[] {
  const incumbentSeat = currentPlaySeat(context.view);
  const beforeBurden = estimatedHandBurden(context.view.hand);
  const ranked = context.legalActions.map((action, index) => ({
    action,
    index,
    score:
      action.type === "pass"
        ? passScore(context.view, incumbentSeat)
        : playScore(context, action, incumbentSeat, beforeBurden),
  }));
  ranked.sort((left, right) => right.score - left.score || left.index - right.index);
  return Object.freeze(ranked.map(({ action }) => action));
}

function playCommand(context: PlayDecisionContext): GameCommand {
  const action = rankCasualPlayActions(context)[0];
  if (action === undefined || action.type === "pass") {
    return Object.freeze({ type: "pass", seat: context.view.seat });
  }
  return Object.freeze({
    type: "play",
    seat: context.view.seat,
    cards: Object.freeze([...action.play.cards]),
  });
}

export const CASUAL_AI_STRATEGY: AiStrategy = Object.freeze({
  chooseCommand(context: AiDecisionContext): GameCommand {
    if (context.kind === "play") {
      return playCommand(context);
    }

    const threshold =
      context.view.seat === "ai-two" && context.view.declinedSeats.length >= 2
        ? LAST_BIDDER_THRESHOLD
        : NORMAL_BID_THRESHOLD;
    return Object.freeze({
      type: "bid",
      seat: context.view.seat,
      decision:
        casualBidStrength(context.view.hand) >= threshold ? "call" : "decline",
    });
  },
});
