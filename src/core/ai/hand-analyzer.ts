import {
  STANDARD_RANKS,
  asCardId,
  getCard,
  type CardId,
  type Rank,
} from "../cards/index.js";
import { generateLegalActions } from "../rules/index.js";

const RANKS: readonly Rank[] = Object.freeze([
  ...STANDARD_RANKS,
  "small-joker",
  "big-joker",
]);
const SEQUENCE_RANKS = STANDARD_RANKS.slice(0, -1);

export type HandEvaluation = Readonly<{
  minimumTurns: number;
  looseSingles: number;
  pairs: number;
  triples: number;
  straights: number;
  consecutivePairs: number;
  airplanes: number;
  bombs: number;
  rocket: boolean;
  controlCards: number;
  structureScore: number;
}>;

export type HandAnalyzerStats = Readonly<{
  cacheHits: number;
  cacheSize: number;
  visitedNodes: number;
}>;

export interface HandAnalyzer {
  readonly analyze: (hand: readonly CardId[]) => HandEvaluation;
  readonly stats: () => HandAnalyzerStats;
}

type RankCounts = readonly number[];

function rankCounts(cards: readonly CardId[]): RankCounts {
  const counts = Array.from({ length: RANKS.length }, () => 0);
  for (const cardId of cards) {
    const index = RANKS.indexOf(getCard(cardId).rank);
    if (index >= 0) {
      counts[index] = (counts[index] ?? 0) + 1;
    }
  }
  return counts;
}

function countsKey(counts: RankCounts): string {
  return counts.join("");
}

function handKey(cards: readonly CardId[]): string {
  return countsKey(rankCounts(cards));
}

function canonicalHand(counts: RankCounts): CardId[] {
  const cards: CardId[] = [];
  for (let rankIndex = 0; rankIndex < STANDARD_RANKS.length; rankIndex += 1) {
    const count = counts[rankIndex] ?? 0;
    for (let suit = 0; suit < count; suit += 1) {
      cards.push(asCardId(rankIndex * 4 + suit));
    }
  }
  if ((counts[13] ?? 0) > 0) {
    cards.push(asCardId(52));
  }
  if ((counts[14] ?? 0) > 0) {
    cards.push(asCardId(53));
  }
  return cards;
}

function sequenceRuns(counts: RankCounts, cardsPerRank: number, minimum: number): number {
  let runs = 0;
  let length = 0;
  for (let index = 0; index < SEQUENCE_RANKS.length; index += 1) {
    if ((counts[index] ?? 0) >= cardsPerRank) {
      length += 1;
    } else {
      if (length >= minimum) {
        runs += 1;
      }
      length = 0;
    }
  }
  return runs + (length >= minimum ? 1 : 0);
}

function basicTurnEstimate(counts: RankCounts): number {
  const cardCount = counts.reduce((sum, count) => sum + count, 0);
  if (cardCount === 0) {
    return 0;
  }
  let groups = counts.filter((count) => count > 0).length;
  const straightSavings = sequenceRuns(counts, 1, 5) * 4;
  const pairSavings = sequenceRuns(counts, 2, 3) * 2;
  const airplaneSavings = sequenceRuns(counts, 3, 2) * 2;
  groups -= Math.max(straightSavings, pairSavings, airplaneSavings);
  const triples = counts.filter((count) => count === 3).length;
  const attachments = counts.filter((count) => count === 1 || count === 2).length;
  groups -= Math.min(triples, attachments);
  return Math.max(1, groups);
}

function removeCards(hand: readonly CardId[], selected: readonly CardId[]): CardId[] {
  const removed = new Set(selected);
  return hand.filter((cardId) => !removed.has(cardId));
}

function featureEvaluation(counts: RankCounts, minimumTurns: number): HandEvaluation {
  const pairs = counts.filter((count) => count === 2).length;
  const triples = counts.filter((count) => count === 3).length;
  const bombs = counts.filter((count) => count === 4).length;
  const straights = sequenceRuns(counts, 1, 5);
  const consecutivePairs = sequenceRuns(counts, 2, 3);
  const airplanes = sequenceRuns(counts, 3, 2);
  const rocket = (counts[13] ?? 0) === 1 && (counts[14] ?? 0) === 1;
  const controlCards = (counts[11] ?? 0) + (counts[12] ?? 0) * 2 +
    (counts[13] ?? 0) * 3 + (counts[14] ?? 0) * 4;
  const looseSingles = counts.reduce((total, count, index) =>
    total + (count === 1 && index < 11 ? 1 : 0), 0);
  const structureScore = pairs * 2 + triples * 5 + straights * 7 +
    consecutivePairs * 8 + airplanes * 10 + bombs * 9 + (rocket ? 12 : 0);
  return Object.freeze({
    minimumTurns,
    looseSingles,
    pairs,
    triples,
    straights,
    consecutivePairs,
    airplanes,
    bombs,
    rocket,
    controlCards,
    structureScore,
  });
}

export function estimateBasicHandTurns(hand: readonly CardId[]): number {
  return basicTurnEstimate(rankCounts(hand));
}

export function createHandAnalyzer(options: Readonly<{ maxNodes?: number }> = {}): HandAnalyzer {
  const maxNodes = Math.max(1, options.maxNodes ?? 600);
  const minimumCache = new Map<string, number>();
  const evaluationCache = new Map<string, HandEvaluation>();
  const sharedBudget = { remaining: maxNodes };
  let cacheHits = 0;
  let visitedNodes = 0;

  function solveMinimumTurns(hand: readonly CardId[], budget: { remaining: number }): number {
    if (hand.length === 0) {
      return 0;
    }
    const key = handKey(hand);
    const cached = minimumCache.get(key);
    if (cached !== undefined) {
      cacheHits += 1;
      return cached;
    }
    if (budget.remaining <= 0) {
      return estimateBasicHandTurns(hand);
    }
    budget.remaining -= 1;
    visitedNodes += 1;

    const actions = generateLegalActions({ hand, currentPlay: null })
      .filter((action) => action.type === "play")
      .sort((left, right) => right.play.cards.length - left.play.cards.length);
    let best = estimateBasicHandTurns(hand);
    const seenRemainders = new Set<string>();
    for (const action of actions) {
      if (action.play.cards.length === hand.length) {
        best = 1;
        break;
      }
      const remaining = removeCards(hand, action.play.cards);
      const remainderKey = handKey(remaining);
      if (seenRemainders.has(remainderKey)) {
        continue;
      }
      seenRemainders.add(remainderKey);
      best = Math.min(best, 1 + solveMinimumTurns(remaining, budget));
      if (best <= 2 || budget.remaining <= 0) {
        break;
      }
    }
    minimumCache.set(key, best);
    return best;
  }

  return Object.freeze({
    analyze(hand: readonly CardId[]) {
      const counts = rankCounts(hand);
      const key = countsKey(counts);
      const cached = evaluationCache.get(key);
      if (cached !== undefined) {
        cacheHits += 1;
        return cached;
      }
      const normalized = canonicalHand(counts);
      const minimumTurns = solveMinimumTurns(normalized, sharedBudget);
      const evaluation = featureEvaluation(counts, minimumTurns);
      evaluationCache.set(key, evaluation);
      return evaluation;
    },
    stats() {
      return Object.freeze({
        cacheHits,
        cacheSize: evaluationCache.size + minimumCache.size,
        visitedNodes,
      });
    },
  });
}
