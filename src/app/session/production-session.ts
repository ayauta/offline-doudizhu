import {
  CASUAL_AI_STRATEGY,
  createPlayerView,
  rankCasualPlayActions,
  runAiTurn,
} from "../../core/ai/index.js";
import { getCard, type CardId } from "../../core/cards/index.js";
import {
  INITIAL_GAME_STATE,
  SEAT_ORDER,
  transition,
  type BidDecision,
  type GameEvent,
  type GameResult,
  type GameState,
  type Seat,
} from "../../core/game/index.js";
import {
  generateLegalActions,
  validatePlay,
  type PlayPatternKind,
} from "../../core/rules/index.js";

const AI_BEAT_MS = 520;
const TRICK_CLEAR_MS = 400;
const RESULT_REVEAL_MS = 580;
const REDEAL_NOTICE_MS = 600;
const HAND_RANK_ORDER = [
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
  "small-joker",
  "big-joker",
] as const;

export interface DeckSource {
  readonly nextDeck: () => readonly CardId[];
}

export interface PresentationScheduler {
  readonly schedule: (delayMs: number, callback: () => void) => () => void;
}

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

type SeatRecord<Value> = Readonly<Record<Seat, Value>>;

export type HomeView = Readonly<{
  screen: "home";
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
  exitConfirmation: boolean;
  result: GameResult | null;
  lowCardSeats: readonly Seat[];
}>;

export type ProductionView = HomeView | MatchView;

export type ProductionIntent =
  | Readonly<{ type: "start-game" }>
  | Readonly<{ type: "bid"; decision: BidDecision }>
  | Readonly<{
      type: "selection-change";
      changes: readonly Readonly<{ cardId: CardId; selected: boolean }>[];
    }>
  | Readonly<{ type: "selection-complete" }>
  | Readonly<{ type: "hint" }>
  | Readonly<{ type: "play" }>
  | Readonly<{ type: "pass" }>
  | Readonly<{ type: "request-exit" }>
  | Readonly<{ type: "cancel-exit" }>
  | Readonly<{ type: "confirm-exit" }>
  | Readonly<{ type: "restart" }>;

export interface ProductionSession {
  readonly dispatch: (intent: ProductionIntent) => void;
  readonly dispose: () => void;
  readonly getView: () => ProductionView;
  readonly subscribe: (listener: () => void) => () => void;
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

function emptySeatRecord<Value>(value: Value): Record<Seat, Value> {
  return {
    human: value,
    "ai-one": value,
    "ai-two": value,
  };
}

function sortHandForDisplay(cards: readonly CardId[]): CardId[] {
  return [...cards].sort((left, right) => {
    const leftCard = getCard(left);
    const rightCard = getCard(right);
    const rankDifference = HAND_RANK_ORDER.indexOf(rightCard.rank) - HAND_RANK_ORDER.indexOf(leftCard.rank);
    // Canonical standard-card IDs ascend clubs, diamonds, hearts, spades;
    // descending IDs therefore define the stable display order inside a rank.
    return rankDifference === 0 ? right - left : rankDifference;
  });
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

function isImpactPattern(pattern: PlayPatternKind): boolean {
  return pattern === "bomb" || pattern === "rocket";
}

function hasHands(
  state: GameState,
): state is Extract<GameState, { readonly hands: unknown }> {
  return state.phase !== "awaiting-deal";
}

function activeCurrentPlay(state: GameState) {
  return state.phase === "playing" ? state.currentPlay : null;
}

export function createProductionSession(options: Readonly<{
  deckSource: DeckSource;
  scheduler: PresentationScheduler;
}>): ProductionSession {
  let state: GameState = INITIAL_GAME_STATE;
  let inMatch = false;
  let disposed = false;
  let resultVisible = false;
  let exitConfirmation = false;
  let feedback: MatchFeedback | null = null;
  let selectionError: SelectionError | null = null;
  let selectionChecked = false;
  let hintIndex = 0;
  let humanHand: readonly CardId[] = [];
  let remainingCardCounts: Record<Seat, number> = emptySeatRecord(0);
  let bottomCards: readonly CardId[] | null = null;
  let biddingActions: Record<Seat, BidDecision | null> = emptySeatRecord(null);
  let tableActions: Record<Seat, PublicTableAction | null> = emptySeatRecord(null);
  let selected = new Set<CardId>();
  const lowCardSeats = new Set<Seat>();
  const listeners = new Set<() => void>();
  const scheduledCancels = new Set<() => void>();
  let pendingAiCancel: (() => void) | null = null;
  let pendingClear = false;
  let pendingResult = false;
  let pendingRedeal = false;
  let view: ProductionView = Object.freeze({ screen: "home" });

  function syncPublicCountsAndHand(): void {
    if (!hasHands(state)) {
      return;
    }
    humanHand = sortHandForDisplay(state.hands.human);
    remainingCardCounts = {
      human: state.hands.human.length,
      "ai-one": state.hands["ai-one"].length,
      "ai-two": state.hands["ai-two"].length,
    };
  }

  function roles(): Record<Seat, SeatRole | null> {
    const landlord = "landlord" in state ? state.landlord : null;
    if (landlord === null) {
      return emptySeatRecord(null);
    }
    return {
      human: landlord === "human" ? "landlord" : "farmer",
      "ai-one": landlord === "ai-one" ? "landlord" : "farmer",
      "ai-two": landlord === "ai-two" ? "landlord" : "farmer",
    };
  }

  function legalHumanActions() {
    if (
      (state.phase !== "ready-to-play" && state.phase !== "playing") ||
      state.currentSeat !== "human"
    ) {
      return Object.freeze([]);
    }
    return generateLegalActions({
      hand: state.hands.human,
      currentPlay: activeCurrentPlay(state),
    });
  }

  function selectionIsLegal(): boolean {
    if (!selectionChecked || selected.size === 0) {
      return false;
    }
    if (
      (state.phase !== "ready-to-play" && state.phase !== "playing") ||
      state.currentSeat !== "human"
    ) {
      return false;
    }
    return validatePlay(
      {
        hand: state.hands.human,
        currentPlay: activeCurrentPlay(state),
      },
      { type: "play", cards: [...selected] },
    ).ok;
  }

  function controls(): readonly ProductionControl[] {
    if (exitConfirmation || pendingClear || pendingRedeal || pendingResult) {
      return [];
    }
    if (state.phase === "finished") {
      return resultVisible ? ["home", "restart"] : [];
    }
    if (state.phase === "bidding" && state.currentSeat === "human") {
      return ["bid-decline", "bid-call"];
    }
    if (
      (state.phase !== "ready-to-play" && state.phase !== "playing") ||
      state.currentSeat !== "human"
    ) {
      return [];
    }
    const legalActions = legalHumanActions();
    const hasPlay = legalActions.some((action) => action.type === "play");
    if (!hasPlay) {
      return ["pass"];
    }
    return activeCurrentPlay(state) === null
      ? ["hint", "play"]
      : ["pass", "hint", "play"];
  }

  function buildView(): ProductionView {
    if (!inMatch) {
      return freezeDeep({ screen: "home" } as const);
    }

    const stage: MatchView["stage"] =
      state.phase === "bidding" || state.phase === "awaiting-deal"
        ? "bidding"
        : state.phase === "finished" && resultVisible
          ? "result"
          : "playing";
    const currentSeat =
      state.phase === "bidding" ||
      state.phase === "ready-to-play" ||
      state.phase === "playing"
        ? state.currentSeat
        : null;
    const landlord = "landlord" in state ? state.landlord : null;
    const visibleControls = controls();
    const noResponse =
      stage === "playing" &&
      currentSeat === "human" &&
      visibleControls.length === 1 &&
      visibleControls[0] === "pass";

    return freezeDeep({
      screen: "match",
      stage,
      humanHand: [...humanHand],
      selectedCardIds: humanHand.filter((cardId) => selected.has(cardId)),
      bottomCardCount: 3,
      bottomCards: bottomCards === null ? null : [...bottomCards],
      currentSeat,
      landlord,
      roles: roles(),
      remainingCardCounts: { ...remainingCardCounts },
      biddingActions: { ...biddingActions },
      tableActions: {
        human: copyTableAction(tableActions.human),
        "ai-one": copyTableAction(tableActions["ai-one"]),
        "ai-two": copyTableAction(tableActions["ai-two"]),
      },
      controls: [...visibleControls],
      playEnabled: visibleControls.includes("play") && selectionIsLegal(),
      selectionError,
      feedback: noResponse ? "no-response" : feedback,
      exitConfirmation,
      result: resultVisible && state.phase === "finished" ? { ...state.result } : null,
      lowCardSeats: SEAT_ORDER.filter((seat) => lowCardSeats.has(seat)),
    } as const);
  }

  function publish(): void {
    view = buildView();
    for (const listener of listeners) {
      listener();
    }
  }

  function schedule(delayMs: number, callback: () => void): () => void {
    let active = true;
    let cancelInner: () => void = () => undefined;
    const cancel = () => {
      if (!active) {
        return;
      }
      active = false;
      scheduledCancels.delete(cancel);
      cancelInner();
    };
    cancelInner = options.scheduler.schedule(delayMs, () => {
      if (!active || disposed) {
        return;
      }
      active = false;
      scheduledCancels.delete(cancel);
      callback();
    });
    scheduledCancels.add(cancel);
    return cancel;
  }

  function cancelScheduledWork(): void {
    for (const cancel of [...scheduledCancels]) {
      cancel();
    }
    scheduledCancels.clear();
    pendingAiCancel = null;
  }

  function resetTransientMatchState(): void {
    resultVisible = false;
    exitConfirmation = false;
    feedback = null;
    selectionError = null;
    selectionChecked = false;
    hintIndex = 0;
    selected = new Set();
    humanHand = [];
    remainingCardCounts = emptySeatRecord(0);
    bottomCards = null;
    biddingActions = emptySeatRecord(null);
    tableActions = emptySeatRecord(null);
    lowCardSeats.clear();
    pendingClear = false;
    pendingResult = false;
    pendingRedeal = false;
  }

  function dealNext(): void {
    const dealt = transition(INITIAL_GAME_STATE, {
      type: "deal",
      deck: options.deckSource.nextDeck(),
    });
    if (!dealt.ok || dealt.state.phase !== "bidding") {
      throw new Error("Deck source returned an invalid production deal.");
    }
    state = dealt.state;
    feedback = null;
    selectionError = null;
    selectionChecked = false;
    hintIndex = 0;
    selected.clear();
    bottomCards = null;
    biddingActions = emptySeatRecord(null);
    tableActions = emptySeatRecord(null);
    lowCardSeats.clear();
    pendingRedeal = false;
    syncPublicCountsAndHand();
    publish();
  }

  function scheduleTrickClear(): void {
    if (!pendingClear || exitConfirmation) {
      return;
    }
    schedule(TRICK_CLEAR_MS, () => {
      pendingClear = false;
      tableActions = emptySeatRecord(null);
      hintIndex = 0;
      publish();
    });
  }

  function scheduleResultReveal(): void {
    if (!pendingResult || exitConfirmation) {
      return;
    }
    schedule(RESULT_REVEAL_MS, () => {
      pendingResult = false;
      resultVisible = true;
      publish();
    });
  }

  function scheduleRedeal(): void {
    if (!pendingRedeal || exitConfirmation) {
      return;
    }
    schedule(REDEAL_NOTICE_MS, dealNext);
  }

  function updateLeadingAction(leadingSeat: Seat): void {
    for (const seat of SEAT_ORDER) {
      const action = tableActions[seat];
      if (action?.type === "play") {
        tableActions[seat] = { ...action, leading: seat === leadingSeat };
      }
    }
  }

  function processEvents(events: readonly GameEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case "deal-completed":
        case "game-restarted":
          break;
        case "bid-declined":
          biddingActions[event.seat] = "decline";
          break;
        case "landlord-selected":
          biddingActions = emptySeatRecord(null);
          bottomCards = [...event.bottomCards];
          break;
        case "cards-played":
          updateLeadingAction(event.seat);
          tableActions[event.seat] = {
            type: "play",
            cards: [...event.play.cards],
            pattern: event.play.pattern.kind,
            leading: true,
            weight: isImpactPattern(event.play.pattern.kind) ? "impact" : "normal",
          };
          if (
            event.remainingCardCount >= 1 &&
            event.remainingCardCount <= 2 &&
            event.seat !== "human"
          ) {
            lowCardSeats.add(event.seat);
          } else if (event.remainingCardCount === 0) {
            lowCardSeats.delete(event.seat);
          }
          selectionError = null;
          selectionChecked = false;
          selected.clear();
          hintIndex = 0;
          break;
        case "player-passed":
          tableActions[event.seat] = { type: "pass" };
          hintIndex = 0;
          break;
        case "trick-cleared":
          pendingClear = true;
          break;
        case "game-finished":
          pendingResult = true;
          break;
        case "redeal-requested":
          feedback = "all-pass";
          pendingRedeal = true;
          bottomCards = null;
          break;
      }
    }
  }

  function queueAiIfNeeded(): void {
    if (
      disposed ||
      exitConfirmation ||
      pendingAiCancel !== null ||
      state.phase === "awaiting-deal" ||
      state.phase === "finished" ||
      state.currentSeat === "human"
    ) {
      return;
    }

    const result = runAiTurn(state, CASUAL_AI_STRATEGY);
    if (!result.ok) {
      selectionError = "retry-selection";
      publish();
      return;
    }
    pendingAiCancel = schedule(AI_BEAT_MS, () => {
      pendingAiCancel = null;
      state = result.state;
      processEvents(result.events);
      syncPublicCountsAndHand();
      publish();
      if (pendingClear) {
        scheduleTrickClear();
      }
      if (pendingResult) {
        scheduleResultReveal();
        return;
      }
      if (pendingRedeal) {
        scheduleRedeal();
        return;
      }
      queueAiIfNeeded();
    });
  }

  function acceptHumanTransition(result: ReturnType<typeof transition>): void {
    if (!result.ok) {
      selectionError = "retry-selection";
      publish();
      return;
    }
    state = result.state;
    processEvents(result.events);
    syncPublicCountsAndHand();
    publish();
    if (pendingClear) {
      scheduleTrickClear();
    }
    if (pendingResult) {
      scheduleResultReveal();
      return;
    }
    if (pendingRedeal) {
      scheduleRedeal();
      return;
    }
    queueAiIfNeeded();
  }

  function validateSelection(): void {
    selectionChecked = true;
    if (selected.size === 0) {
      selectionError = null;
      publish();
      return;
    }
    if (
      (state.phase !== "ready-to-play" && state.phase !== "playing") ||
      state.currentSeat !== "human"
    ) {
      selectionError = "retry-selection";
      publish();
      return;
    }
    const result = validatePlay(
      {
        hand: state.hands.human,
        currentPlay: activeCurrentPlay(state),
      },
      { type: "play", cards: [...selected] },
    );
    if (result.ok) {
      selectionError = null;
    } else if (result.error.code === "play-does-not-beat-current") {
      selectionError = "does-not-beat";
    } else if (result.error.code === "card-not-in-hand") {
      selectionError = "retry-selection";
    } else {
      selectionError = "unsupported-selection";
    }
    publish();
  }

  function showHint(): void {
    if (
      (state.phase !== "ready-to-play" && state.phase !== "playing") ||
      state.currentSeat !== "human" ||
      exitConfirmation
    ) {
      return;
    }
    const playerView = createPlayerView(state, "human");
    if (playerView === null || playerView.phase === "bidding") {
      return;
    }
    const ranked = rankCasualPlayActions({
      kind: "play",
      view: playerView,
      legalActions: generateLegalActions({
        hand: playerView.hand,
        currentPlay: playerView.currentPlay,
      }),
    }).filter((action) => action.type === "play");
    if (ranked.length === 0) {
      return;
    }
    const action = ranked[hintIndex % ranked.length];
    if (action === undefined || action.type !== "play") {
      return;
    }
    selected = new Set(action.play.cards);
    selectionChecked = true;
    selectionError = null;
    hintIndex = (hintIndex + 1) % ranked.length;
    publish();
  }

  function playSelected(): void {
    if (!selectionIsLegal()) {
      validateSelection();
      return;
    }
    acceptHumanTransition(
      transition(state, {
        type: "play",
        seat: "human",
        cards: [...selected],
      }),
    );
  }

  function pauseForExit(): void {
    if (!inMatch || state.phase === "finished" || exitConfirmation) {
      return;
    }
    cancelScheduledWork();
    exitConfirmation = true;
    publish();
  }

  function resumeAfterExit(): void {
    if (!exitConfirmation) {
      return;
    }
    exitConfirmation = false;
    publish();
    if (pendingClear) {
      scheduleTrickClear();
    }
    if (pendingResult) {
      scheduleResultReveal();
      return;
    }
    if (pendingRedeal) {
      scheduleRedeal();
      return;
    }
    queueAiIfNeeded();
  }

  function returnHome(): void {
    cancelScheduledWork();
    state = INITIAL_GAME_STATE;
    inMatch = false;
    resetTransientMatchState();
    publish();
  }

  function restart(): void {
    if (state.phase !== "finished" || !resultVisible) {
      return;
    }
    const restarted = transition(state, { type: "restart" });
    if (!restarted.ok) {
      return;
    }
    cancelScheduledWork();
    state = restarted.state;
    resetTransientMatchState();
    inMatch = true;
    dealNext();
  }

  function dispatch(intent: ProductionIntent): void {
    if (disposed) {
      return;
    }
    switch (intent.type) {
      case "start-game":
        if (!inMatch) {
          inMatch = true;
          resetTransientMatchState();
          dealNext();
        }
        return;
      case "bid":
        if (state.phase === "bidding" && state.currentSeat === "human" && !exitConfirmation) {
          acceptHumanTransition(
            transition(state, {
              type: "bid",
              seat: "human",
              decision: intent.decision,
            }),
          );
        }
        return;
      case "selection-change":
        if (
          (state.phase !== "ready-to-play" && state.phase !== "playing") ||
          state.currentSeat !== "human" ||
          exitConfirmation
        ) {
          return;
        }
        for (const change of intent.changes) {
          if (!state.hands.human.includes(change.cardId)) {
            continue;
          }
          if (change.selected) {
            selected.add(change.cardId);
          } else {
            selected.delete(change.cardId);
          }
        }
        selectionChecked = false;
        selectionError = null;
        hintIndex = 0;
        publish();
        return;
      case "selection-complete":
        validateSelection();
        return;
      case "hint":
        showHint();
        return;
      case "play":
        playSelected();
        return;
      case "pass":
        if (
          state.phase === "playing" &&
          state.currentSeat === "human" &&
          activeCurrentPlay(state) !== null &&
          !exitConfirmation
        ) {
          acceptHumanTransition(transition(state, { type: "pass", seat: "human" }));
        }
        return;
      case "request-exit":
        if (state.phase === "finished" && resultVisible) {
          returnHome();
        } else {
          pauseForExit();
        }
        return;
      case "cancel-exit":
        resumeAfterExit();
        return;
      case "confirm-exit":
        if (exitConfirmation) {
          returnHome();
        }
        return;
      case "restart":
        restart();
        return;
    }
  }

  return {
    dispatch,
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      cancelScheduledWork();
      listeners.clear();
    },
    getView() {
      return view;
    },
    subscribe(listener) {
      if (disposed) {
        return () => undefined;
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
