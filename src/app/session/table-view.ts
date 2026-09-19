import { getCard, type CardId } from "../../core/cards/index.js";
import {
  SEAT_ORDER,
  type BidDecision,
  type GameResult,
  type GameState,
  type Seat,
} from "../../core/game/index.js";
import {
  generateLegalActions,
  rankStrength,
  validatePlay,
  type PlayPatternKind,
} from "../../core/rules/index.js";
import type { AiType } from "../settings/ai-settings.js";

export type ProductionControl =
  | "bid-decline"
  | "bid-call"
  | "pass"
  | "hint"
  | "play"
  | "home"
  | "restart";

export type SelectionError =
  | "unsupported-selection"
  | "does-not-beat"
  | "retry-selection";

export type MatchFeedback = "all-pass" | "no-response";
export type SeatRole = "landlord" | "farmer";

export type PublicTableAction =
  | Readonly<{
      type: "pass";
    }>
  | Readonly<{
      type: "play";
      cards: readonly CardId[];
      pattern: PlayPatternKind;
      leading: boolean;
      weight: "normal" | "impact";
    }>;

export type SeatRecord<Value> = Readonly<Record<Seat, Value>>;

export type HomeView = Readonly<{
  screen: "home";
  aiType: AiType;
}>;

export type MatchView = Readonly<{
  screen: "match";
  stage: "bidding" | "playing" | "result";
  humanHand: readonly CardId[];
  selectedCardIds: readonly CardId[];
  bottomCardCount: 3;
  bottomCards: readonly CardId[] | null;
  currentSeat: Seat | null;
  landlord: Seat | null;
  roles: SeatRecord<SeatRole | null>;
  remainingCardCounts: SeatRecord<number>;
  biddingActions: SeatRecord<BidDecision | null>;
  tableActions: SeatRecord<PublicTableAction | null>;
  controls: readonly ProductionControl[];
  playEnabled: boolean;
  selectionError: SelectionError | null;
  feedback: MatchFeedback | null;
  aiFallbackNotice: boolean;
  exitConfirmation: boolean;
  result: GameResult | null;
  lowCardSeats: readonly Seat[];
}>;

export type ProductionView = HomeView | MatchView;

// Everything the view depends on, and nothing else. The session owns these values
// and hands over a snapshot; this module turns a snapshot into the read-only view
// without reading a clock, a scheduler, or any mutable binding of its own.
export type TableViewSnapshot = Readonly<{
  state: GameState;
  aiType: AiType;
  inMatch: boolean;
  resultVisible: boolean;
  selectionChecked: boolean;
  selected: ReadonlySet<CardId>;
  bottomCards: readonly CardId[] | null;
  selectionError: SelectionError | null;
  feedback: MatchFeedback | null;
  aiFallbackNotice: boolean;
  exitConfirmation: boolean;
  pendingClear: boolean;
  pendingRedeal: boolean;
  pendingResult: boolean;
  biddingActions: SeatRecord<BidDecision | null>;
  tableActions: SeatRecord<PublicTableAction | null>;
  lowCardSeats: ReadonlySet<Seat>;
}>;

function freezeDeep<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    freezeDeep(nested);
  }
  return Object.freeze(value);
}

export function sortHandForDisplay(cards: readonly CardId[]): CardId[] {
  return [...cards].sort((left, right) => {
    const leftCard = getCard(left);
    const rightCard = getCard(right);
    const rankDifference = rankStrength(rightCard.rank) - rankStrength(leftCard.rank);
    // Canonical standard-card IDs ascend clubs, diamonds, hearts, spades;
    // descending IDs therefore define the stable display order inside a rank.
    return rankDifference === 0 ? right - left : rankDifference;
  });
}

export function isImpactPattern(pattern: PlayPatternKind): boolean {
  return pattern === "bomb" || pattern === "rocket";
}

function copyTableAction(action: PublicTableAction | null): PublicTableAction | null {
  if (action === null || action.type === "pass") {
    return action;
  }
  return {
    ...action,
    cards: [...action.cards],
  };
}

// The play this seat has to beat, or null when it may lead freely. The session
// asks the same question when it validates a hint or a play, so it is exported
// rather than re-derived there.
export function activeCurrentPlay(state: GameState) {
  return state.phase === "playing" ? state.currentPlay : null;
}

function isHumanTurn(state: GameState): boolean {
  return (
    (state.phase === "ready-to-play" || state.phase === "playing") &&
    state.currentSeat === "human"
  );
}

function currentHand(state: GameState): readonly CardId[] | null {
  return state.phase === "awaiting-deal" ? null : state.hands.human;
}

export function selectionIsLegal(
  state: GameState,
  selected: ReadonlySet<CardId>,
  selectionChecked: boolean,
): boolean {
  const hand = currentHand(state);
  if (hand === null || !selectionChecked || selected.size === 0 || !isHumanTurn(state)) {
    return false;
  }
  return validatePlay(
    { hand, currentPlay: activeCurrentPlay(state) },
    { type: "play", cards: [...selected] },
  ).ok;
}

function roles(state: GameState): SeatRecord<SeatRole | null> {
  const landlord = "landlord" in state ? state.landlord : null;
  if (landlord === null) {
    return { human: null, "ai-one": null, "ai-two": null };
  }
  return {
    human: landlord === "human" ? "landlord" : "farmer",
    "ai-one": landlord === "ai-one" ? "landlord" : "farmer",
    "ai-two": landlord === "ai-two" ? "landlord" : "farmer",
  };
}

function controls(snapshot: TableViewSnapshot): readonly ProductionControl[] {
  const { state } = snapshot;
  if (
    snapshot.exitConfirmation ||
    snapshot.pendingClear ||
    snapshot.pendingRedeal ||
    snapshot.pendingResult
  ) {
    return [];
  }
  if (state.phase === "finished") {
    return snapshot.resultVisible ? ["home", "restart"] : [];
  }
  if (state.phase === "bidding" && state.currentSeat === "human") {
    return ["bid-decline", "bid-call"];
  }
  const hand = currentHand(state);
  if (hand === null || !isHumanTurn(state)) {
    return [];
  }
  const hasPlay = generateLegalActions({
    hand,
    currentPlay: activeCurrentPlay(state),
  }).some((action) => action.type === "play");
  if (!hasPlay) {
    return ["pass"];
  }
  return activeCurrentPlay(state) === null
    ? ["hint", "play"]
    : ["pass", "hint", "play"];
}

export function deriveView(snapshot: TableViewSnapshot): ProductionView {
  const { state } = snapshot;
  if (!snapshot.inMatch) {
    return freezeDeep({ screen: "home", aiType: snapshot.aiType } as const);
  }

  const hands = state.phase === "awaiting-deal" ? null : state.hands;
  const humanHand = hands === null ? [] : sortHandForDisplay(hands.human);
  const remainingCardCounts: SeatRecord<number> = hands === null
    ? { human: 0, "ai-one": 0, "ai-two": 0 }
    : {
        human: hands.human.length,
        "ai-one": hands["ai-one"].length,
        "ai-two": hands["ai-two"].length,
      };

  const stage: MatchView["stage"] =
    state.phase === "bidding" || state.phase === "awaiting-deal"
      ? "bidding"
      : state.phase === "finished" && snapshot.resultVisible
        ? "result"
        : "playing";
  const currentSeat =
    state.phase === "bidding" ||
    state.phase === "ready-to-play" ||
    state.phase === "playing"
      ? state.currentSeat
      : null;
  const landlord = "landlord" in state ? state.landlord : null;
  const visibleControls = controls(snapshot);
  const noResponse =
    stage === "playing" &&
    currentSeat === "human" &&
    visibleControls.length === 1 &&
    visibleControls[0] === "pass";

  return freezeDeep({
    screen: "match",
    stage,
    humanHand,
    selectedCardIds: humanHand.filter((cardId) => snapshot.selected.has(cardId)),
    bottomCardCount: 3,
    bottomCards: snapshot.bottomCards === null ? null : [...snapshot.bottomCards],
    currentSeat,
    landlord,
    roles: roles(state),
    remainingCardCounts,
    biddingActions: { ...snapshot.biddingActions },
    tableActions: {
      human: copyTableAction(snapshot.tableActions.human),
      "ai-one": copyTableAction(snapshot.tableActions["ai-one"]),
      "ai-two": copyTableAction(snapshot.tableActions["ai-two"]),
    },
    controls: [...visibleControls],
    playEnabled: visibleControls.includes("play") &&
      selectionIsLegal(state, snapshot.selected, snapshot.selectionChecked),
    selectionError: snapshot.selectionError,
    feedback: noResponse ? "no-response" : snapshot.feedback,
    aiFallbackNotice: snapshot.aiFallbackNotice,
    exitConfirmation: snapshot.exitConfirmation,
    result: snapshot.resultVisible && state.phase === "finished" ? { ...state.result } : null,
    lowCardSeats: SEAT_ORDER.filter((seat) => snapshot.lowCardSeats.has(seat)),
  } as const);
}
