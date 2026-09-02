import type { CardId } from "../cards/index.js";
import {
  transition,
  type GameCommand,
  type GameError,
  type GameEvent,
  type GameState,
  type PlayHistoryEntry,
  type Seat,
} from "../game/index.js";
import {
  generateLegalActions,
  type ClassifiedPlay,
  type ValidatedPlayAction,
} from "../rules/index.js";

export type RemainingCardCounts = Readonly<Record<Seat, number>>;

export type BiddingPlayerView = Readonly<{
  phase: "bidding";
  seat: Seat;
  hand: readonly CardId[];
  currentSeat: Seat;
  declinedSeats: readonly Seat[];
  remainingCardCounts: RemainingCardCounts;
}>;

export type PlayingPlayerView = Readonly<{
  phase: "ready-to-play" | "playing";
  seat: Seat;
  hand: readonly CardId[];
  currentSeat: Seat;
  landlord: Seat;
  bottomCards: readonly CardId[];
  remainingCardCounts: RemainingCardCounts;
  currentPlay: ClassifiedPlay | null;
  history: readonly PlayHistoryEntry[];
}>;

export type PlayerView = BiddingPlayerView | PlayingPlayerView;

export type AiDecisionContext =
  | Readonly<{
      kind: "bid";
      view: BiddingPlayerView;
    }>
  | Readonly<{
      kind: "play";
      view: PlayingPlayerView;
      legalActions: readonly ValidatedPlayAction[];
    }>;

export interface AiStrategy {
  chooseCommand(context: AiDecisionContext): GameCommand;
}

export type AiTurnError =
  | Readonly<{ code: "not-ai-turn" }>
  | Readonly<{ code: "illegal-ai-command"; gameError: GameError }>
  | Readonly<{ code: "strategy-failed" }>;

export type AiTurnResult =
  | Readonly<{
      ok: true;
      command: GameCommand;
      state: GameState;
      events: readonly GameEvent[];
    }>
  | Readonly<{
      ok: false;
      state: GameState;
      error: AiTurnError;
    }>;

export const BASELINE_AI_STRATEGY: AiStrategy = Object.freeze({
  chooseCommand(context: AiDecisionContext): GameCommand {
    if (context.kind === "bid") {
      return Object.freeze({
        type: "bid",
        seat: context.view.seat,
        decision: "call",
      });
    }

    const action = context.legalActions[0];
    if (action === undefined || action.type === "pass") {
      return Object.freeze({ type: "pass", seat: context.view.seat });
    }
    return Object.freeze({
      type: "play",
      seat: context.view.seat,
      cards: Object.freeze([...action.play.cards]),
    });
  },
});

function remainingCardCounts(state: Extract<GameState, { readonly hands: unknown }>): RemainingCardCounts {
  return Object.freeze({
    human: state.hands.human.length,
    "ai-one": state.hands["ai-one"].length,
    "ai-two": state.hands["ai-two"].length,
  });
}

function copyPlay(play: ClassifiedPlay): ClassifiedPlay {
  return Object.freeze({
    cards: Object.freeze([...play.cards]),
    pattern: Object.freeze({ ...play.pattern }),
  });
}

function copyHistory(history: readonly PlayHistoryEntry[]): readonly PlayHistoryEntry[] {
  return Object.freeze(
    history.map((entry): PlayHistoryEntry =>
      entry.type === "pass"
        ? Object.freeze({ type: "pass", seat: entry.seat })
        : Object.freeze({
            type: "play",
            seat: entry.seat,
            play: copyPlay(entry.play),
          }),
    ),
  );
}

function cloneCommand(command: GameCommand): GameCommand {
  switch (command.type) {
    case "deal":
      return Object.freeze({
        type: "deal",
        deck: Object.freeze([...command.deck]),
      });
    case "bid":
      return Object.freeze({
        type: "bid",
        seat: command.seat,
        decision: command.decision,
      });
    case "play":
      return Object.freeze({
        type: "play",
        seat: command.seat,
        cards: Object.freeze([...command.cards]),
      });
    case "pass":
      return Object.freeze({ type: "pass", seat: command.seat });
    case "restart":
      return Object.freeze({ type: "restart" });
  }

  throw new TypeError("Strategy returned an unknown command.");
}

function aiFailure(state: GameState, error: AiTurnError): AiTurnResult {
  return Object.freeze({ ok: false, state, error: Object.freeze(error) });
}

export function createPlayerView(state: GameState, seat: Seat): PlayerView | null {
  if (state.phase === "bidding") {
    return Object.freeze({
      phase: "bidding",
      seat,
      hand: Object.freeze([...state.hands[seat]]),
      currentSeat: state.currentSeat,
      declinedSeats: Object.freeze([...state.declinedSeats]),
      remainingCardCounts: remainingCardCounts(state),
    });
  }

  if (state.phase !== "ready-to-play" && state.phase !== "playing") {
    return null;
  }

  return Object.freeze({
    phase: state.phase,
    seat,
    hand: Object.freeze([...state.hands[seat]]),
    currentSeat: state.currentSeat,
    landlord: state.landlord,
    bottomCards: Object.freeze([...state.bottomCards]),
    remainingCardCounts: remainingCardCounts(state),
    currentPlay:
      state.phase === "playing" && state.currentPlay !== null
        ? copyPlay(state.currentPlay)
        : null,
    history: state.phase === "playing" ? copyHistory(state.history) : Object.freeze([]),
  });
}

export function runAiTurn(state: GameState, strategy: AiStrategy): AiTurnResult {
  if (
    (state.phase !== "bidding" &&
      state.phase !== "ready-to-play" &&
      state.phase !== "playing") ||
    state.currentSeat === "human"
  ) {
    return aiFailure(state, { code: "not-ai-turn" });
  }

  const view = createPlayerView(state, state.currentSeat);
  if (view === null) {
    return aiFailure(state, { code: "not-ai-turn" });
  }

  let context: AiDecisionContext;
  if (state.phase === "bidding") {
    if (view.phase !== "bidding") {
      return aiFailure(state, { code: "strategy-failed" });
    }
    context = Object.freeze({ kind: "bid", view });
  } else {
    if (view.phase === "bidding") {
      return aiFailure(state, { code: "strategy-failed" });
    }
    context = Object.freeze({
      kind: "play",
      view,
      legalActions: generateLegalActions({
        hand: view.hand,
        currentPlay: view.currentPlay,
      }),
    });
  }

  try {
    const command = cloneCommand(strategy.chooseCommand(context));
    const result = transition(state, command);
    if (!result.ok) {
      return aiFailure(state, {
        code: "illegal-ai-command",
        gameError: result.error,
      });
    }
    return Object.freeze({
      ok: true,
      command,
      state: result.state,
      events: result.events,
    });
  } catch {
    return aiFailure(state, { code: "strategy-failed" });
  }
}
