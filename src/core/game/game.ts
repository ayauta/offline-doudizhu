import { CARD_COUNT, compareCardIds, type CardId } from "../cards/index.js";

export const SEAT_ORDER = Object.freeze(["human", "ai-one", "ai-two"] as const);
export type Seat = (typeof SEAT_ORDER)[number];

export type Hands = Readonly<Record<Seat, readonly CardId[]>>;

export type AwaitingDealState = Readonly<{
  phase: "awaiting-deal";
}>;

export type BiddingState = Readonly<{
  phase: "bidding";
  hands: Hands;
  bottomCards: readonly CardId[];
  currentSeat: Seat;
  declinedSeats: readonly Seat[];
}>;

export type ReadyToPlayState = Readonly<{
  phase: "ready-to-play";
  hands: Hands;
  bottomCards: readonly CardId[];
  landlord: Seat;
  currentSeat: Seat;
}>;

export type GameState = AwaitingDealState | BiddingState | ReadyToPlayState;

export type BidDecision = "call" | "decline";

export type GameCommand =
  | Readonly<{
      type: "deal";
      deck: readonly CardId[];
    }>
  | Readonly<{
      type: "bid";
      seat: Seat;
      decision: BidDecision;
    }>;

export type GameEvent =
  | Readonly<{
      type: "deal-completed";
    }>
  | Readonly<{
      type: "bid-declined";
      seat: Seat;
    }>
  | Readonly<{
      type: "redeal-requested";
    }>
  | Readonly<{
      type: "landlord-selected";
      seat: Seat;
      bottomCards: readonly CardId[];
    }>;

export type GameErrorCode =
  | "invalid-deck"
  | "command-not-allowed"
  | "not-current-bidder";

export type GameError = Readonly<{
  code: GameErrorCode;
}>;

export type GameTransitionResult =
  | Readonly<{
      ok: true;
      state: GameState;
      events: readonly GameEvent[];
    }>
  | Readonly<{
      ok: false;
      state: GameState;
      error: GameError;
    }>;

export const INITIAL_GAME_STATE: AwaitingDealState = Object.freeze({
  phase: "awaiting-deal",
});

function failure(state: GameState, code: GameErrorCode): GameTransitionResult {
  return Object.freeze({
    ok: false,
    state,
    error: Object.freeze({ code }),
  });
}

function freezeDeep<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    freezeDeep(nested);
  }
  return Object.freeze(value);
}

function success(
  state: GameState,
  events: readonly GameEvent[],
): GameTransitionResult {
  return freezeDeep({ ok: true, state, events: [...events] } as const);
}

function copyHands(hands: Hands): Record<Seat, CardId[]> {
  return {
    human: [...hands.human],
    "ai-one": [...hands["ai-one"]],
    "ai-two": [...hands["ai-two"]],
  };
}

function isCanonicalDeck(deck: readonly CardId[]): boolean {
  return (
    deck.length === CARD_COUNT &&
    deck.every(
      (cardId) => Number.isInteger(cardId) && cardId >= 0 && cardId < CARD_COUNT,
    ) &&
    new Set(deck).size === CARD_COUNT
  );
}

export function transition(
  state: GameState,
  command: GameCommand,
): GameTransitionResult {
  if (command.type === "bid") {
    if (state.phase !== "bidding") {
      return failure(state, "command-not-allowed");
    }
    if (command.seat !== state.currentSeat) {
      return failure(state, "not-current-bidder");
    }
    if (command.decision === "decline") {
      if (command.seat === "ai-two") {
        return success(
          INITIAL_GAME_STATE,
          [
            { type: "bid-declined", seat: command.seat },
            { type: "redeal-requested" },
          ],
        );
      }
      const nextSeat: Seat = command.seat === "human" ? "ai-one" : "ai-two";
      return success(
        {
          ...state,
          hands: copyHands(state.hands),
          bottomCards: [...state.bottomCards],
          currentSeat: nextSeat,
          declinedSeats: [...state.declinedSeats, command.seat],
        },
        [{ type: "bid-declined", seat: command.seat }],
      );
    }

    const nextHands = copyHands(state.hands);
    const landlordHand = [
      ...state.hands[command.seat],
      ...state.bottomCards,
    ].sort(compareCardIds);
    nextHands[command.seat] = landlordHand;
    const nextState: ReadyToPlayState = {
      phase: "ready-to-play",
      hands: nextHands,
      bottomCards: [...state.bottomCards],
      landlord: command.seat,
      currentSeat: command.seat,
    };
    return success(
      nextState,
      [
        {
          type: "landlord-selected",
          seat: command.seat,
          bottomCards: nextState.bottomCards,
        },
      ],
    );
  }

  if (state.phase !== "awaiting-deal") {
    return failure(state, "command-not-allowed");
  }
  if (!isCanonicalDeck(command.deck)) {
    return failure(state, "invalid-deck");
  }

  const mutableHands: Record<Seat, CardId[]> = {
    human: [],
    "ai-one": [],
    "ai-two": [],
  };

  for (let index = 0; index < 51; index += 1) {
    const cardId = command.deck[index];
    const seat = SEAT_ORDER[index % SEAT_ORDER.length];
    if (cardId !== undefined && seat !== undefined) {
      mutableHands[seat].push(cardId);
    }
  }

  const nextState: BiddingState = {
    phase: "bidding",
    hands: {
      human: mutableHands.human.sort(compareCardIds),
      "ai-one": mutableHands["ai-one"].sort(compareCardIds),
      "ai-two": mutableHands["ai-two"].sort(compareCardIds),
    },
    bottomCards: command.deck.slice(51).sort(compareCardIds),
    currentSeat: "human",
    declinedSeats: [],
  };

  return success(nextState, [{ type: "deal-completed" }]);
}
