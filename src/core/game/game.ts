import { CARD_COUNT, compareCardIds, type CardId } from "../cards/index.js";
import {
  validatePlay,
  type ClassifiedPlay,
  type PlayValidationErrorCode,
} from "../rules/index.js";

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

export type PlayHistoryEntry =
  | Readonly<{
      type: "play";
      seat: Seat;
      play: ClassifiedPlay;
    }>
  | Readonly<{
      type: "pass";
      seat: Seat;
    }>;

export type PlayingState = Readonly<{
  phase: "playing";
  hands: Hands;
  bottomCards: readonly CardId[];
  landlord: Seat;
  currentSeat: Seat;
  currentPlay: ClassifiedPlay | null;
  lastPlaySeat: Seat | null;
  consecutivePasses: 0 | 1;
  history: readonly PlayHistoryEntry[];
}>;

export type FinishedState = Readonly<{
  phase: "finished";
  hands: Hands;
  bottomCards: readonly CardId[];
  landlord: Seat;
  winner: Seat;
  history: readonly PlayHistoryEntry[];
}>;

export type GameState =
  | AwaitingDealState
  | BiddingState
  | ReadyToPlayState
  | PlayingState
  | FinishedState;

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
    }>
  | Readonly<{
      type: "play";
      seat: Seat;
      cards: readonly CardId[];
    }>
  | Readonly<{
      type: "pass";
      seat: Seat;
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
    }>
  | Readonly<{
      type: "cards-played";
      seat: Seat;
      play: ClassifiedPlay;
      remainingCardCount: number;
    }>
  | Readonly<{
      type: "player-passed";
      seat: Seat;
    }>
  | Readonly<{
      type: "trick-cleared";
      leader: Seat;
    }>
  | Readonly<{
      type: "game-finished";
      winner: Seat;
    }>;

export type GameErrorCode =
  | "invalid-deck"
  | "command-not-allowed"
  | "not-current-bidder"
  | "not-current-player"
  | PlayValidationErrorCode;

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

function nextSeat(seat: Seat): Seat {
  const index = SEAT_ORDER.indexOf(seat);
  return SEAT_ORDER[(index + 1) % SEAT_ORDER.length] ?? "human";
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
  if (command.type === "pass") {
    if (state.phase !== "ready-to-play" && state.phase !== "playing") {
      return failure(state, "command-not-allowed");
    }
    if (command.seat !== state.currentSeat) {
      return failure(state, "not-current-player");
    }
    const validation = validatePlay(
      {
        hand: state.hands[command.seat],
        currentPlay: state.phase === "playing" ? state.currentPlay : null,
      },
      { type: "pass" },
    );
    if (!validation.ok) {
      return failure(state, validation.error.code);
    }
    if (state.phase !== "playing") {
      return failure(state, "command-not-allowed");
    }

    if (state.consecutivePasses === 1) {
      if (state.lastPlaySeat === null) {
        return failure(state, "command-not-allowed");
      }
      const leader = state.lastPlaySeat;
      const nextState: PlayingState = {
        ...state,
        hands: copyHands(state.hands),
        bottomCards: [...state.bottomCards],
        currentSeat: leader,
        currentPlay: null,
        lastPlaySeat: null,
        consecutivePasses: 0,
        history: [...state.history, { type: "pass", seat: command.seat }],
      };
      return success(nextState, [
        { type: "player-passed", seat: command.seat },
        { type: "trick-cleared", leader },
      ]);
    }

    const nextState: PlayingState = {
      ...state,
      hands: copyHands(state.hands),
      bottomCards: [...state.bottomCards],
      currentSeat: nextSeat(command.seat),
      consecutivePasses: 1,
      history: [...state.history, { type: "pass", seat: command.seat }],
    };
    return success(nextState, [
      { type: "player-passed", seat: command.seat },
    ]);
  }

  if (command.type === "play") {
    if (state.phase !== "ready-to-play" && state.phase !== "playing") {
      return failure(state, "command-not-allowed");
    }
    if (command.seat !== state.currentSeat) {
      return failure(state, "not-current-player");
    }

    const validation = validatePlay(
      {
        hand: state.hands[command.seat],
        currentPlay: state.phase === "playing" ? state.currentPlay : null,
      },
      { type: "play", cards: command.cards },
    );
    if (!validation.ok || validation.action.type !== "play") {
      return failure(
        state,
        validation.ok ? "command-not-allowed" : validation.error.code,
      );
    }

    const playedCards = new Set(validation.action.play.cards);
    const nextHands = copyHands(state.hands);
    nextHands[command.seat] = nextHands[command.seat].filter(
      (cardId) => !playedCards.has(cardId),
    );
    const history: readonly PlayHistoryEntry[] = [
      ...(state.phase === "playing" ? state.history : []),
      { type: "play", seat: command.seat, play: validation.action.play },
    ];
    const cardsPlayedEvent: GameEvent = {
      type: "cards-played",
      seat: command.seat,
      play: validation.action.play,
      remainingCardCount: nextHands[command.seat].length,
    };
    if (nextHands[command.seat].length === 0) {
      const nextState: FinishedState = {
        phase: "finished",
        hands: nextHands,
        bottomCards: [...state.bottomCards],
        landlord: state.landlord,
        winner: command.seat,
        history,
      };
      return success(nextState, [
        cardsPlayedEvent,
        { type: "game-finished", winner: command.seat },
      ]);
    }

    const nextState: PlayingState = {
      phase: "playing",
      hands: nextHands,
      bottomCards: [...state.bottomCards],
      landlord: state.landlord,
      currentSeat: nextSeat(command.seat),
      currentPlay: validation.action.play,
      lastPlaySeat: command.seat,
      consecutivePasses: 0,
      history,
    };
    return success(nextState, [cardsPlayedEvent]);
  }

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
