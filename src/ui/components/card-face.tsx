import type { TargetedMouseEvent } from "preact";

import type { Card } from "../../core/cards/index.js";

const SUIT_PRESENTATION = {
  clubs: { label: "梅花", symbol: "♣" },
  diamonds: { label: "方块", symbol: "♦" },
  hearts: { label: "红桃", symbol: "♥" },
  spades: { label: "黑桃", symbol: "♠" },
} as const;

interface CardFaceProps {
  readonly card: Card;
  readonly index: number;
  readonly onKeyboardActivate: (card: Card) => void;
  readonly selected: boolean;
}

export function CardFace({
  card,
  index,
  onKeyboardActivate,
  selected,
}: CardFaceProps) {
  const presentation = card.kind === "standard"
    ? {
        accessibleName: `${SUIT_PRESENTATION[card.suit].label}${card.rank}`,
        rank: card.rank,
        red: card.suit === "diamonds" || card.suit === "hearts",
        suit: SUIT_PRESENTATION[card.suit].symbol,
      }
    : {
        accessibleName: card.rank === "small-joker" ? "小王" : "大王",
        rank: card.rank === "small-joker" ? "小" : "大",
        red: card.rank === "big-joker",
        suit: "王",
      };

  function handleClick(event: TargetedMouseEvent<HTMLButtonElement>) {
    if (event.detail === 0) {
      onKeyboardActivate(card);
    }
  }

  return (
    <button
      aria-label={presentation.accessibleName}
      aria-pressed={selected}
      class={`playing-card${presentation.red ? " playing-card--red" : ""}`}
      data-card-id={card.id}
      data-testid={`card-${index}`}
      draggable={false}
      onClick={handleClick}
      onDragStart={(event) => event.preventDefault()}
      style={{ zIndex: index + 1 }}
      type="button"
    >
      <span class="playing-card__corner" aria-hidden="true">
        <strong>{presentation.rank}</strong>
        <span>{presentation.suit}</span>
      </span>
      <span class="playing-card__center" aria-hidden="true">{presentation.suit}</span>
      <span class="playing-card__selected" aria-hidden="true">✓</span>
    </button>
  );
}
