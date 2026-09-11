import { STANDARD_RANKS, getCard, type CardId, type Rank } from "../cards/index.js";
import type { Seat } from "../game/index.js";
import type { PlayPattern, ValidatedPlayAction } from "../rules/index.js";
import type { PlayingPlayerView } from "./ai.js";

const RANKS: readonly Rank[] = Object.freeze([
  ...STANDARD_RANKS,
  "small-joker",
  "big-joker",
]);

export function isSameSide(left: Seat, right: Seat, landlord: Seat): boolean {
  return left === landlord ? right === landlord : right !== landlord;
}

export function currentPlaySeat(view: PlayingPlayerView): Seat | null {
  for (let index = view.history.length - 1; index >= 0; index -= 1) {
    const entry = view.history[index];
    if (entry?.type === "play") {
      return entry.seat;
    }
  }
  return null;
}

export function mainRankStrength(pattern: PlayPattern): number {
  return pattern.kind === "rocket" ? RANKS.length : RANKS.indexOf(pattern.mainRank);
}

function opposingSeats(view: PlayingPlayerView): readonly Seat[] {
  return (["human", "ai-one", "ai-two"] as const)
    .filter((seat) => seat !== view.seat && !isSameSide(view.seat, seat, view.landlord));
}

function partnerSeat(view: PlayingPlayerView): Seat | null {
  if (view.seat === view.landlord) {
    return null;
  }
  return (["human", "ai-one", "ai-two"] as const)
    .find((seat) => seat !== view.seat && seat !== view.landlord) ?? null;
}

function dangerShapePenalty(view: PlayingPlayerView, pattern: PlayPattern): number {
  let penalty = 0;
  for (const seat of opposingSeats(view)) {
    const count = view.remainingCardCounts[seat];
    if (count === 1 && pattern.kind === "single") {
      penalty += 720;
    } else if (count === 2 && pattern.kind === "pair") {
      penalty += 620;
    } else if (count === 3 && pattern.kind === "triple") {
      penalty += 420;
    }
  }
  return penalty;
}

function partnerFeedScore(view: PlayingPlayerView, action: ValidatedPlayAction): number {
  if (action.type === "pass") {
    return 0;
  }
  const partner = partnerSeat(view);
  if (partner === null || view.currentPlay !== null) {
    return 0;
  }
  const count = view.remainingCardCounts[partner];
  const strength = mainRankStrength(action.play.pattern);
  if (count === 1 && action.play.pattern.kind === "single") {
    return 780 - strength * 32;
  }
  if (count === 2 && action.play.pattern.kind === "pair") {
    return 620 - strength * 24;
  }
  return 0;
}

function seenRankCounts(view: PlayingPlayerView): Map<Rank, number> {
  const counts = new Map<Rank, number>();
  const seenCards = new Set<CardId>();
  const add = (cards: readonly CardId[]) => {
    for (const cardId of cards) {
      if (seenCards.has(cardId)) {
        continue;
      }
      seenCards.add(cardId);
      const rank = getCard(cardId).rank;
      counts.set(rank, (counts.get(rank) ?? 0) + 1);
    }
  };
  add(view.hand);
  add(view.bottomCards);
  for (const entry of view.history) {
    if (entry.type === "play") {
      add(entry.play.cards);
    }
  }
  return counts;
}

function publicControlScore(view: PlayingPlayerView, pattern: PlayPattern): number {
  if (pattern.kind === "rocket") {
    return 260;
  }
  if (pattern.kind !== "single" && pattern.kind !== "pair" && pattern.kind !== "bomb") {
    return 0;
  }
  const strength = mainRankStrength(pattern);
  const seen = seenRankCounts(view);
  let unseenHigher = 0;
  for (let index = strength + 1; index < RANKS.length; index += 1) {
    const rank = RANKS[index];
    if (rank !== undefined) {
      const total = rank === "small-joker" || rank === "big-joker" ? 1 : 4;
      unseenHigher += Math.max(0, total - (seen.get(rank) ?? 0));
    }
  }
  return Math.max(-180, 210 - unseenHigher * 24);
}

export function scorePublicPosition(
  view: PlayingPlayerView,
  action: ValidatedPlayAction,
  profile: "casual" | "expert",
): number {
  const incumbent = currentPlaySeat(view);
  const partnerLeading = incumbent !== null && isSameSide(view.seat, incumbent, view.landlord);
  const enemyCounts = opposingSeats(view).map((seat) => view.remainingCardCounts[seat]);
  const minimumEnemy = Math.min(...enemyCounts);

  if (action.type === "pass") {
    if (partnerLeading) {
      return profile === "expert" ? 760 : 560;
    }
    if (minimumEnemy <= 1) {
      return -820;
    }
    if (minimumEnemy <= 2) {
      return -440;
    }
    return -40;
  }

  let score = partnerFeedScore(view, action);
  if (partnerLeading) {
    score -= profile === "expert" ? 940 : 680;
  } else if (incumbent !== null) {
    score += minimumEnemy <= 1 ? 760 : minimumEnemy <= 2 ? 430 : minimumEnemy <= 4 ? 180 : 50;
  } else {
    score -= dangerShapePenalty(view, action.play.pattern);
  }
  if (profile === "expert") {
    score += publicControlScore(view, action.play.pattern);
    if (view.seat === view.landlord) {
      score += Math.max(0, 8 - minimumEnemy) * 18;
    } else if (view.remainingCardCounts[view.landlord] <= 4) {
      score += 160;
    }
  }
  return score;
}
