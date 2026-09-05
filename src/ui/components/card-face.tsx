import type { JSX } from "preact";

import { getCard, type CardId, type Suit } from "../../core/cards/index.js";

const SUIT_NAMES: Readonly<Record<Suit, string>> = {
  clubs: "梅花",
  diamonds: "方块",
  hearts: "红桃",
  spades: "黑桃",
};

function SuitMark({ suit }: Readonly<{ suit: Suit }>) {
  const path = suit === "hearts"
    ? "M12 21C10.7 19.8 4 14.5 4 9.3C4 6.2 6.2 4 9.1 4c1.5 0 2.5.8 2.9 1.6C12.4 4.8 13.4 4 14.9 4 17.8 4 20 6.2 20 9.3 20 14.5 13.3 19.8 12 21Z"
    : suit === "diamonds"
      ? "M12 2 20 12 12 22 4 12 12 2Z"
      : suit === "clubs"
        ? "M12 3.2a4.1 4.1 0 0 1 3.3 6.6 4.2 4.2 0 1 1 1.7 7.8H14c.1 1.6.7 2.8 2 3.4H8c1.3-.6 1.9-1.8 2-3.4H7a4.2 4.2 0 1 1 1.7-7.8A4.1 4.1 0 0 1 12 3.2Z"
        : "M12 2.8C10.6 4.1 4 9.3 4 14.2a4.1 4.1 0 0 0 7 2.9c-.1 1.8-.7 3.2-2.2 4h6.4c-1.5-.8-2.1-2.2-2.2-4a4.1 4.1 0 0 0 7-2.9c0-4.9-6.6-10.1-8-11.4Z";
  return (
    <svg aria-hidden="true" class="suit-mark" viewBox="0 0 24 24">
      <path d={path} />
    </svg>
  );
}

function CardArtwork({ cardId }: Readonly<{ cardId: CardId }>) {
  const card = getCard(cardId);
  if (card.kind === "joker") {
    return (
      <span class="playing-card__joker-word" aria-hidden="true">
        {Array.from("JOKER", (letter) => <span key={letter}>{letter}</span>)}
      </span>
    );
  }
  return (
    <span class="playing-card__corner" aria-hidden="true">
      <strong>{card.rank}</strong>
      <SuitMark suit={card.suit} />
    </span>
  );
}

function cardName(cardId: CardId): string {
  const card = getCard(cardId);
  return card.kind === "joker"
    ? card.rank === "big-joker" ? "大王" : "小王"
    : `${SUIT_NAMES[card.suit]}${card.rank}`;
}

function isRed(cardId: CardId): boolean {
  const card = getCard(cardId);
  return card.kind === "joker"
    ? card.rank === "big-joker"
    : card.suit === "diamonds" || card.suit === "hearts";
}

interface HandCardProps {
  readonly cardId: CardId;
  readonly index: number;
  readonly received?: boolean;
  readonly selected: boolean;
}

export function HandCard({ cardId, index, received = false, selected }: HandCardProps) {
  const style = {
    "--card-index": index,
    zIndex: index + 1,
  } as unknown as JSX.CSSProperties;
  return (
    <button
      aria-label={cardName(cardId)}
      aria-pressed={selected}
      class={`playing-card${isRed(cardId) ? " playing-card--red" : ""}${received ? " playing-card--received" : ""}`}
      data-card-id={cardId}
      draggable={false}
      onDragStart={(event) => event.preventDefault()}
      style={style}
      type="button"
    >
      <CardArtwork cardId={cardId} />
    </button>
  );
}

export function TableCard({ cardId }: Readonly<{ cardId: CardId }>) {
  return (
    <span
      aria-label={cardName(cardId)}
      class={`playing-card table-card${isRed(cardId) ? " playing-card--red" : ""}`}
      role="img"
    >
      <CardArtwork cardId={cardId} />
    </span>
  );
}

export function CardBack({ label = "牌背" }: Readonly<{ label?: string }>) {
  return (
    <span aria-label={label} class="card-back" role="img">
      <svg aria-hidden="true" class="card-back__motif" viewBox="0 0 48 66">
        <path d="M8 47C12 28 20 18 24 14" />
        <path d="M15 51C18 34 24 25 29 20" />
        <path d="M24 52C27 39 32 31 39 26" />
      </svg>
    </span>
  );
}
