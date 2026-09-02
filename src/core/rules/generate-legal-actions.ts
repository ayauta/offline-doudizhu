import {
  STANDARD_RANKS,
  compareCardIds,
  getCard,
  type CardId,
  type Rank,
} from "../cards/index.js";
import { RANK_ORDER, rankStrength } from "./ranks.js";
import type { PlayPattern, PlayPatternKind } from "./types.js";
import {
  validatePlay,
  type PlayContext,
  type ValidatedPlayAction,
} from "./validate-play.js";

interface RankGroup {
  readonly rank: Rank;
  readonly cards: readonly CardId[];
}

const PATTERN_KIND_ORDER: readonly PlayPatternKind[] = Object.freeze([
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

const SEQUENCE_RANKS = STANDARD_RANKS.slice(0, -1);

function groupHand(hand: readonly CardId[]): readonly RankGroup[] {
  const byRank = new Map<Rank, CardId[]>();
  for (const cardId of hand) {
    const rank = getCard(cardId).rank;
    const cards = byRank.get(rank) ?? [];
    cards.push(cardId);
    byRank.set(rank, cards);
  }

  return RANK_ORDER.flatMap((rank) => {
    const cards = byRank.get(rank);
    return cards === undefined
      ? []
      : [{ rank, cards: Object.freeze([...cards].sort(compareCardIds)) }];
  });
}

function mainRankStrength(pattern: PlayPattern): number {
  return pattern.kind === "rocket" ? RANK_ORDER.length : rankStrength(pattern.mainRank);
}

function compareActions(left: ValidatedPlayAction, right: ValidatedPlayAction): number {
  if (left.type === "pass") {
    return right.type === "pass" ? 0 : 1;
  }
  if (right.type === "pass") {
    return -1;
  }

  const kindDifference =
    PATTERN_KIND_ORDER.indexOf(left.play.pattern.kind) -
    PATTERN_KIND_ORDER.indexOf(right.play.pattern.kind);
  if (kindDifference !== 0) {
    return kindDifference;
  }

  const countDifference = left.play.cards.length - right.play.cards.length;
  if (countDifference !== 0) {
    return countDifference;
  }

  const rankDifference =
    mainRankStrength(left.play.pattern) - mainRankStrength(right.play.pattern);
  if (rankDifference !== 0) {
    return rankDifference;
  }

  for (let index = 0; index < left.play.cards.length; index += 1) {
    const difference = (left.play.cards[index] ?? 0) - (right.play.cards[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function addCandidate(
  context: PlayContext,
  cards: readonly CardId[],
  actions: ValidatedPlayAction[],
  seen: Set<string>,
): void {
  const result = validatePlay(context, { type: "play", cards });
  if (!result.ok || result.action.type !== "play") {
    return;
  }

  const key = result.action.play.cards.join(",");
  if (!seen.has(key)) {
    seen.add(key);
    actions.push(result.action);
  }
}

function consecutiveSelections(
  groups: ReadonlyMap<Rank, RankGroup>,
  cardsPerRank: number,
  minimumLength: number,
  maximumLength: number,
): readonly CardId[][] {
  const selections: CardId[][] = [];

  for (let length = minimumLength; length <= maximumLength; length += 1) {
    for (let start = 0; start + length <= SEQUENCE_RANKS.length; start += 1) {
      const cards: CardId[] = [];
      let complete = true;
      for (const rank of SEQUENCE_RANKS.slice(start, start + length)) {
        const group = groups.get(rank);
        if (group === undefined || group.cards.length < cardsPerRank) {
          complete = false;
          break;
        }
        cards.push(...group.cards.slice(0, cardsPerRank));
      }
      if (complete) {
        selections.push(cards);
      }
    }
  }

  return selections;
}

function singleAttachmentSelections(
  groups: readonly RankGroup[],
  excludedRanks: ReadonlySet<Rank>,
  cardCount: number,
): readonly CardId[][] {
  const eligibleGroups = groups.filter((group) => !excludedRanks.has(group.rank));
  const selections: CardId[][] = [];

  function visit(groupIndex: number, remaining: number, selected: readonly CardId[]): void {
    if (remaining === 0) {
      const selectedRanks = new Set(selected.map((cardId) => getCard(cardId).rank));
      if (!(selectedRanks.has("small-joker") && selectedRanks.has("big-joker"))) {
        selections.push([...selected]);
      }
      return;
    }
    if (groupIndex >= eligibleGroups.length) {
      return;
    }

    const group = eligibleGroups[groupIndex];
    if (group === undefined) {
      return;
    }

    for (
      let take = 0;
      take <= Math.min(2, group.cards.length, remaining);
      take += 1
    ) {
      visit(
        groupIndex + 1,
        remaining - take,
        [...selected, ...group.cards.slice(0, take)],
      );
    }
  }

  visit(0, cardCount, []);
  return selections;
}

function pairAttachmentSelections(
  groups: readonly RankGroup[],
  excludedRanks: ReadonlySet<Rank>,
  pairCount: number,
): readonly CardId[][] {
  const eligibleGroups = groups.filter(
    (group) => !excludedRanks.has(group.rank) && group.cards.length >= 2,
  );
  const selections: CardId[][] = [];

  function visit(
    groupIndex: number,
    remainingPairs: number,
    selected: readonly CardId[],
  ): void {
    if (remainingPairs === 0) {
      selections.push([...selected]);
      return;
    }
    if (eligibleGroups.length - groupIndex < remainingPairs) {
      return;
    }

    for (
      let index = groupIndex;
      index <= eligibleGroups.length - remainingPairs;
      index += 1
    ) {
      const group = eligibleGroups[index];
      if (group !== undefined) {
        visit(index + 1, remainingPairs - 1, [
          ...selected,
          ...group.cards.slice(0, 2),
        ]);
      }
    }
  }

  visit(0, pairCount, []);
  return selections;
}

export function generateLegalActions(
  context: PlayContext,
): readonly ValidatedPlayAction[] {
  const groups = groupHand(context.hand);
  const groupsByRank = new Map(groups.map((group) => [group.rank, group]));
  const actions: ValidatedPlayAction[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    addCandidate(context, group.cards.slice(0, 1), actions, seen);
    if (group.cards.length >= 2) {
      addCandidate(context, group.cards.slice(0, 2), actions, seen);
    }
    if (group.cards.length >= 3) {
      addCandidate(context, group.cards.slice(0, 3), actions, seen);
    }
    if (group.cards.length >= 4) {
      addCandidate(context, group.cards.slice(0, 4), actions, seen);
    }
  }

  for (const core of groups.filter((group) => group.cards.length >= 3)) {
    for (const attachment of groups.filter((group) => group.rank !== core.rank)) {
      addCandidate(
        context,
        [...core.cards.slice(0, 3), ...attachment.cards.slice(0, 1)],
        actions,
        seen,
      );
      if (attachment.cards.length >= 2) {
        addCandidate(
          context,
          [...core.cards.slice(0, 3), ...attachment.cards.slice(0, 2)],
          actions,
          seen,
        );
      }
    }
  }

  for (const cards of consecutiveSelections(groupsByRank, 1, 5, 12)) {
    addCandidate(context, cards, actions, seen);
  }
  for (const cards of consecutiveSelections(groupsByRank, 2, 3, 10)) {
    addCandidate(context, cards, actions, seen);
  }
  for (const coreCards of consecutiveSelections(groupsByRank, 3, 2, 6)) {
    addCandidate(context, coreCards, actions, seen);
  }

  for (const coreCards of consecutiveSelections(groupsByRank, 3, 2, 5)) {
    const coreRanks = new Set(coreCards.map((cardId) => getCard(cardId).rank));
    const sequenceLength = coreCards.length / 3;
    for (const attachments of singleAttachmentSelections(
      groups,
      coreRanks,
      sequenceLength,
    )) {
      addCandidate(context, [...coreCards, ...attachments], actions, seen);
    }
  }

  for (const coreCards of consecutiveSelections(groupsByRank, 3, 2, 4)) {
    const coreRanks = new Set(coreCards.map((cardId) => getCard(cardId).rank));
    const sequenceLength = coreCards.length / 3;
    for (const attachments of pairAttachmentSelections(
      groups,
      coreRanks,
      sequenceLength,
    )) {
      addCandidate(context, [...coreCards, ...attachments], actions, seen);
    }
  }

  for (const core of groups.filter((group) => group.cards.length >= 4)) {
    const coreCards = core.cards.slice(0, 4);
    const excludedRanks = new Set<Rank>([core.rank]);
    for (const attachments of singleAttachmentSelections(groups, excludedRanks, 2)) {
      addCandidate(context, [...coreCards, ...attachments], actions, seen);
    }
    for (const attachments of pairAttachmentSelections(groups, excludedRanks, 2)) {
      addCandidate(context, [...coreCards, ...attachments], actions, seen);
    }
  }

  const smallJoker = groupsByRank.get("small-joker")?.cards[0];
  const bigJoker = groupsByRank.get("big-joker")?.cards[0];
  if (smallJoker !== undefined && bigJoker !== undefined) {
    addCandidate(context, [smallJoker, bigJoker], actions, seen);
  }

  const passResult = validatePlay(context, { type: "pass" });
  if (passResult.ok && passResult.action.type === "pass") {
    actions.push(passResult.action);
  }

  actions.sort(compareActions);
  return Object.freeze(actions);
}
