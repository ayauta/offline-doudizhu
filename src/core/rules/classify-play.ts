import {
  CARD_COUNT,
  compareCardIds,
  getCard,
  type CardId,
  type Rank,
  type StandardRank,
} from "../cards/index.js";
import {
  MAX_SEQUENCE_RANK_STRENGTH,
  RANK_ORDER,
} from "./ranks.js";
import type {
  ClassificationErrorCode,
  ClassificationResult,
  ClassifiedPlay,
  PlayPattern,
} from "./types.js";

const MAX_PLAY_CARD_COUNT = 20;

interface RankGroup {
  readonly rank: Rank;
  readonly count: number;
  readonly strength: number;
}

function freezePattern<Pattern extends PlayPattern>(pattern: Pattern): Pattern {
  return Object.freeze(pattern);
}

function failure(code: ClassificationErrorCode): ClassificationResult {
  const error = Object.freeze({ code });
  return Object.freeze({ ok: false, error });
}

function isRuntimeCardId(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value < CARD_COUNT;
}

function buildGroups(cards: readonly CardId[]): readonly RankGroup[] {
  const counts = new Map<Rank, number>();
  for (const cardId of cards) {
    const rank = getCard(cardId).rank;
    counts.set(rank, (counts.get(rank) ?? 0) + 1);
  }

  return RANK_ORDER.flatMap((rank, strength) => {
    const count = counts.get(rank);
    return count === undefined ? [] : [{ rank, count, strength }];
  });
}

function onlyGroupWithCount(
  groups: readonly RankGroup[],
  count: number,
): RankGroup | undefined {
  return groups.length === 1 && groups[0]?.count === count ? groups[0] : undefined;
}

function isConsecutiveCore(
  groups: readonly RankGroup[],
  expectedCount: number,
  minimumLength: number,
): groups is readonly (RankGroup & { readonly rank: StandardRank })[] {
  if (groups.length < minimumLength) {
    return false;
  }

  const first = groups[0];
  if (first === undefined) {
    return false;
  }

  return groups.every(
    (group, index) =>
      group.count === expectedCount &&
      group.strength <= MAX_SEQUENCE_RANK_STRENGTH &&
      group.strength === first.strength + index,
  );
}

function highestRank(groups: readonly RankGroup[]): StandardRank {
  const group = groups[groups.length - 1];
  if (group === undefined || group.strength > MAX_SEQUENCE_RANK_STRENGTH) {
    throw new Error("Expected a non-empty standard-rank core.");
  }
  return group.rank as StandardRank;
}

function containsBothJokers(groups: readonly RankGroup[]): boolean {
  return (
    groups.some((group) => group.rank === "small-joker") &&
    groups.some((group) => group.rank === "big-joker")
  );
}

function classifyStraight(groups: readonly RankGroup[]): PlayPattern | undefined {
  if (!isConsecutiveCore(groups, 1, 5)) {
    return undefined;
  }
  return freezePattern({
    kind: "straight",
    mainRank: highestRank(groups),
    sequenceLength: groups.length,
  });
}

function classifyConsecutivePairs(groups: readonly RankGroup[]): PlayPattern | undefined {
  if (!isConsecutiveCore(groups, 2, 3)) {
    return undefined;
  }
  return freezePattern({
    kind: "consecutive-pairs",
    mainRank: highestRank(groups),
    sequenceLength: groups.length,
  });
}

function classifyAirplane(groups: readonly RankGroup[]): PlayPattern | undefined {
  if (!isConsecutiveCore(groups, 3, 2)) {
    return undefined;
  }
  return freezePattern({
    kind: "airplane",
    mainRank: highestRank(groups),
    sequenceLength: groups.length,
  });
}

function airplaneCore(
  groups: readonly RankGroup[],
  sequenceLength: number,
): readonly (RankGroup & { readonly rank: StandardRank })[] | undefined {
  const triples = groups.filter((group) => group.count === 3);
  if (triples.length !== sequenceLength || !isConsecutiveCore(triples, 3, 2)) {
    return undefined;
  }
  return triples;
}

function classifyAirplaneWithSingles(
  cardCount: number,
  groups: readonly RankGroup[],
): PlayPattern | undefined {
  if (cardCount % 4 !== 0) {
    return undefined;
  }

  const sequenceLength = cardCount / 4;
  const core = airplaneCore(groups, sequenceLength);
  if (core === undefined) {
    return undefined;
  }

  const coreRanks = new Set<Rank>(core.map((group) => group.rank));
  const attachments = groups.filter((group) => !coreRanks.has(group.rank));
  const attachmentCount = attachments.reduce((sum, group) => sum + group.count, 0);
  if (
    attachmentCount !== sequenceLength ||
    attachments.some((group) => group.count < 1 || group.count > 2) ||
    containsBothJokers(attachments)
  ) {
    return undefined;
  }

  return freezePattern({
    kind: "airplane-with-singles",
    mainRank: highestRank(core),
    sequenceLength,
  });
}

function classifyAirplaneWithPairs(
  cardCount: number,
  groups: readonly RankGroup[],
): PlayPattern | undefined {
  if (cardCount % 5 !== 0) {
    return undefined;
  }

  const sequenceLength = cardCount / 5;
  const core = airplaneCore(groups, sequenceLength);
  if (core === undefined) {
    return undefined;
  }

  const coreRanks = new Set<Rank>(core.map((group) => group.rank));
  const attachments = groups.filter((group) => !coreRanks.has(group.rank));
  if (
    attachments.length !== sequenceLength ||
    attachments.some((group) => group.count !== 2)
  ) {
    return undefined;
  }

  return freezePattern({
    kind: "airplane-with-pairs",
    mainRank: highestRank(core),
    sequenceLength,
  });
}

function classifyFourWithTwoCards(groups: readonly RankGroup[]): PlayPattern | undefined {
  const cores = groups.filter((group) => group.count === 4);
  if (cores.length !== 1) {
    return undefined;
  }

  const core = cores[0];
  if (core === undefined || core.strength > MAX_SEQUENCE_RANK_STRENGTH + 1) {
    return undefined;
  }

  const attachments = groups.filter((group) => group.rank !== core.rank);
  const attachmentCount = attachments.reduce((sum, group) => sum + group.count, 0);
  if (
    attachmentCount !== 2 ||
    attachments.some((group) => group.count > 2) ||
    containsBothJokers(attachments)
  ) {
    return undefined;
  }

  return freezePattern({ kind: "four-with-two-cards", mainRank: core.rank as StandardRank });
}

function classifyFourWithTwoPairs(groups: readonly RankGroup[]): PlayPattern | undefined {
  const cores = groups.filter((group) => group.count === 4);
  if (cores.length !== 1) {
    return undefined;
  }

  const core = cores[0];
  if (core === undefined || core.strength > MAX_SEQUENCE_RANK_STRENGTH + 1) {
    return undefined;
  }

  const attachments = groups.filter((group) => group.rank !== core.rank);
  if (attachments.length !== 2 || attachments.some((group) => group.count !== 2)) {
    return undefined;
  }

  return freezePattern({ kind: "four-with-two-pairs", mainRank: core.rank as StandardRank });
}

function classifyPattern(cards: readonly CardId[], groups: readonly RankGroup[]): PlayPattern | undefined {
  const cardCount = cards.length;

  if (cardCount === 1) {
    const group = onlyGroupWithCount(groups, 1);
    return group === undefined
      ? undefined
      : freezePattern({ kind: "single", mainRank: group.rank });
  }

  if (cardCount === 2) {
    if (
      groups.length === 2 &&
      groups[0]?.rank === "small-joker" &&
      groups[1]?.rank === "big-joker"
    ) {
      return freezePattern({ kind: "rocket" });
    }
    const group = onlyGroupWithCount(groups, 2);
    return group === undefined
      ? undefined
      : freezePattern({ kind: "pair", mainRank: group.rank as StandardRank });
  }

  if (cardCount === 3) {
    const group = onlyGroupWithCount(groups, 3);
    return group === undefined
      ? undefined
      : freezePattern({ kind: "triple", mainRank: group.rank as StandardRank });
  }

  if (cardCount === 4) {
    const bomb = onlyGroupWithCount(groups, 4);
    if (bomb !== undefined) {
      return freezePattern({ kind: "bomb", mainRank: bomb.rank as StandardRank });
    }
    const triple = groups.find((group) => group.count === 3);
    if (triple !== undefined && groups.length === 2) {
      return freezePattern({ kind: "triple-with-single", mainRank: triple.rank as StandardRank });
    }
  }

  if (cardCount === 5) {
    const triple = groups.find((group) => group.count === 3);
    const pair = groups.find((group) => group.count === 2);
    if (triple !== undefined && pair !== undefined && groups.length === 2) {
      return freezePattern({ kind: "triple-with-pair", mainRank: triple.rank as StandardRank });
    }
  }

  const straight = classifyStraight(groups);
  if (straight !== undefined) {
    return straight;
  }

  const consecutivePairs = classifyConsecutivePairs(groups);
  if (consecutivePairs !== undefined) {
    return consecutivePairs;
  }

  const airplane = classifyAirplane(groups);
  if (airplane !== undefined) {
    return airplane;
  }

  const airplaneWithSingles = classifyAirplaneWithSingles(cardCount, groups);
  if (airplaneWithSingles !== undefined) {
    return airplaneWithSingles;
  }

  const airplaneWithPairs = classifyAirplaneWithPairs(cardCount, groups);
  if (airplaneWithPairs !== undefined) {
    return airplaneWithPairs;
  }

  if (cardCount === 6) {
    return classifyFourWithTwoCards(groups);
  }

  if (cardCount === 8) {
    return classifyFourWithTwoPairs(groups);
  }

  return undefined;
}

export function classifyPlay(cardIds: readonly CardId[]): ClassificationResult {
  if (cardIds.length === 0) {
    return failure("empty-selection");
  }
  if (cardIds.length > MAX_PLAY_CARD_COUNT) {
    return failure("too-many-cards");
  }

  const seen = new Set<number>();
  for (const cardId of cardIds) {
    const value: number = cardId;
    if (!isRuntimeCardId(value)) {
      return failure("invalid-card-id");
    }
    if (seen.has(value)) {
      return failure("duplicate-card-id");
    }
    seen.add(value);
  }

  const cards = Object.freeze([...cardIds].sort(compareCardIds));
  const groups = buildGroups(cards);
  const pattern = classifyPattern(cards, groups);
  if (pattern === undefined) {
    return failure("unsupported-pattern");
  }

  const play: ClassifiedPlay = Object.freeze({ cards, pattern });
  return Object.freeze({ ok: true, play });
}
