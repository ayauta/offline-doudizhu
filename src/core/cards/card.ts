export const CARD_COUNT = 54;

export const SUITS = ["clubs", "diamonds", "hearts", "spades"] as const;
export type Suit = (typeof SUITS)[number];

export const STANDARD_RANKS = [
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
  "A",
  "2",
] as const;
export type StandardRank = (typeof STANDARD_RANKS)[number];
export type JokerRank = "small-joker" | "big-joker";
export type Rank = StandardRank | JokerRank;

declare const cardIdBrand: unique symbol;
export type CardId = number & { readonly [cardIdBrand]: "CardId" };

export interface StandardCard {
  readonly id: CardId;
  readonly kind: "standard";
  readonly rank: StandardRank;
  readonly suit: Suit;
}

export interface JokerCard {
  readonly id: CardId;
  readonly kind: "joker";
  readonly rank: JokerRank;
}

export type Card = StandardCard | JokerCard;

export function asCardId(value: number): CardId {
  if (!Number.isInteger(value) || value < 0 || value >= CARD_COUNT) {
    throw new RangeError(`Card ID must be an integer from 0 through 53; received ${value}.`);
  }

  return value as CardId;
}

const CARD_IDS: readonly CardId[] = Object.freeze(
  Array.from({ length: CARD_COUNT }, (_, index) => asCardId(index)),
);

const CARDS: readonly Card[] = Object.freeze(
  CARD_IDS.map((id): Card => {
    if (id === 52) {
      return Object.freeze({ id, kind: "joker", rank: "small-joker" });
    }
    if (id === 53) {
      return Object.freeze({ id, kind: "joker", rank: "big-joker" });
    }

    const rank = STANDARD_RANKS[Math.floor(id / SUITS.length)];
    const suit = SUITS[id % SUITS.length];
    if (rank === undefined || suit === undefined) {
      throw new Error(`Canonical card mapping is incomplete for card ID ${id}.`);
    }

    return Object.freeze({ id, kind: "standard", rank, suit });
  }),
);

export function createDeck(): CardId[] {
  return [...CARD_IDS];
}

export function getCard(id: CardId): Card {
  const card = CARDS[id];
  if (card === undefined) {
    throw new RangeError(`Unknown card ID: ${id}.`);
  }
  return card;
}

export function compareCardIds(left: CardId, right: CardId): number {
  return left - right;
}
