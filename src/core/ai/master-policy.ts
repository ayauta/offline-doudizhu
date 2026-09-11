import { createDeck, type CardId } from "../cards/index.js";
import { SEAT_ORDER, type PlayHistoryEntry, type Seat } from "../game/index.js";
import { generateLegalActions, type ClassifiedPlay, type ValidatedPlayAction } from "../rules/index.js";
import type { AiDecisionContext, PlayingPlayerView } from "./ai.js";
import { estimateBasicHandTurns } from "./hand-analyzer.js";
import { rankScoredPlayActions, type ScoredPlayAction } from "./scoring-policy.js";
import { currentPlaySeat, isSameSide } from "./state-evaluator.js";

type PlayContext = Extract<AiDecisionContext, { readonly kind: "play" }>;

export type PossibleWorld = Readonly<{
  hands: Readonly<Record<Seat, readonly CardId[]>>;
}>;

export type MasterSearchOptions = Readonly<{
  seed: number;
  maxWorlds: number;
  rolloutDepth: 2 | 3 | 4;
  rootAnalyzerNodes?: number;
  shouldContinue?: () => boolean;
}>;

type MutableSearchState = {
  hands: Record<Seat, CardId[]>;
  currentSeat: Seat;
  currentPlay: ClassifiedPlay | null;
  lastPlaySeat: Seat | null;
  consecutivePasses: 0 | 1;
  history: PlayHistoryEntry[];
  winner: Seat | null;
};

class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  nextUint(): number {
    this.state = (Math.imul(this.state, 1_664_525) + 1_013_904_223) >>> 0;
    return this.state;
  }

  next(): number {
    return this.nextUint() / 0x1_0000_0000;
  }
}

function shuffleCards(cards: readonly CardId[], random: SeededRandom): CardId[] {
  const result = [...cards];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random.next() * (index + 1));
    const current = result[index];
    const replacement = result[target];
    if (current !== undefined && replacement !== undefined) {
      result[index] = replacement;
      result[target] = current;
    }
  }
  return result;
}

function playedCards(view: PlayingPlayerView): Set<CardId> {
  const cards = new Set<CardId>();
  for (const entry of view.history) {
    if (entry.type === "play") {
      for (const cardId of entry.play.cards) {
        cards.add(cardId);
      }
    }
  }
  return cards;
}

function sampleWithRandom(view: PlayingPlayerView, random: SeededRandom): PossibleWorld {
  const unavailable = playedCards(view);
  for (const cardId of view.hand) {
    unavailable.add(cardId);
  }

  const fixed: Record<Seat, CardId[]> = {
    human: [],
    "ai-one": [],
    "ai-two": [],
  };
  fixed[view.seat] = [...view.hand];
  if (view.landlord !== view.seat) {
    for (const cardId of view.bottomCards) {
      if (!unavailable.has(cardId)) {
        fixed[view.landlord].push(cardId);
        unavailable.add(cardId);
      }
    }
  }

  const pool = shuffleCards(
    createDeck().filter((cardId) => !unavailable.has(cardId)),
    random,
  );
  let offset = 0;
  for (const seat of SEAT_ORDER) {
    if (seat === view.seat) {
      continue;
    }
    const needed = view.remainingCardCounts[seat] - fixed[seat].length;
    if (needed < 0 || offset + needed > pool.length) {
      throw new Error("Public remaining-card counts cannot form a possible world.");
    }
    fixed[seat].push(...pool.slice(offset, offset + needed));
    offset += needed;
  }
  return Object.freeze({
    hands: Object.freeze({
      human: Object.freeze([...fixed.human]),
      "ai-one": Object.freeze([...fixed["ai-one"]]),
      "ai-two": Object.freeze([...fixed["ai-two"]]),
    }),
  });
}

export function samplePossibleWorld(view: PlayingPlayerView, seed: number): PossibleWorld {
  return sampleWithRandom(view, new SeededRandom(seed));
}

function nextSeat(seat: Seat): Seat {
  const index = SEAT_ORDER.indexOf(seat);
  return SEAT_ORDER[(index + 1) % SEAT_ORDER.length] ?? "human";
}

function trailingPasses(view: PlayingPlayerView): 0 | 1 {
  if (view.currentPlay === null) {
    return 0;
  }
  return view.history.at(-1)?.type === "pass" ? 1 : 0;
}

function createSearchState(view: PlayingPlayerView, world: PossibleWorld): MutableSearchState {
  return {
    hands: {
      human: [...world.hands.human],
      "ai-one": [...world.hands["ai-one"]],
      "ai-two": [...world.hands["ai-two"]],
    },
    currentSeat: view.seat,
    currentPlay: view.currentPlay,
    lastPlaySeat: view.currentPlay === null ? null : currentPlaySeat(view),
    consecutivePasses: trailingPasses(view),
    history: [...view.history],
    winner: null,
  };
}

function applyAction(state: MutableSearchState, action: ValidatedPlayAction): void {
  const seat = state.currentSeat;
  if (action.type === "pass") {
    state.history.push(Object.freeze({ type: "pass", seat }));
    if (state.consecutivePasses === 1 && state.lastPlaySeat !== null) {
      state.currentSeat = state.lastPlaySeat;
      state.currentPlay = null;
      state.lastPlaySeat = null;
      state.consecutivePasses = 0;
    } else {
      state.currentSeat = nextSeat(seat);
      state.consecutivePasses = 1;
    }
    return;
  }

  const played = new Set(action.play.cards);
  state.hands[seat] = state.hands[seat].filter((cardId) => !played.has(cardId));
  state.history.push(Object.freeze({ type: "play", seat, play: action.play }));
  if (state.hands[seat].length === 0) {
    state.winner = seat;
    return;
  }
  state.currentPlay = action.play;
  state.lastPlaySeat = seat;
  state.consecutivePasses = 0;
  state.currentSeat = nextSeat(seat);
}

function searchContext(
  rootView: PlayingPlayerView,
  state: MutableSearchState,
): PlayContext {
  const seat = state.currentSeat;
  const view: PlayingPlayerView = Object.freeze({
    phase: "playing",
    seat,
    hand: Object.freeze([...state.hands[seat]]),
    currentSeat: seat,
    landlord: rootView.landlord,
    bottomCards: rootView.bottomCards,
    remainingCardCounts: Object.freeze({
      human: state.hands.human.length,
      "ai-one": state.hands["ai-one"].length,
      "ai-two": state.hands["ai-two"].length,
    }),
    currentPlay: state.currentPlay,
    history: Object.freeze([...state.history]),
  });
  return Object.freeze({
    kind: "play",
    view,
    legalActions: generateLegalActions({ hand: view.hand, currentPlay: view.currentPlay }),
  });
}

function rootUtility(rootView: PlayingPlayerView, state: MutableSearchState): number {
  if (state.winner !== null) {
    return isSameSide(rootView.seat, state.winner, rootView.landlord) ? 10_000 : -10_000;
  }
  let friendlyTurns = 0;
  let enemyTurns = 0;
  let friendlyCards = 0;
  let enemyCards = 0;
  for (const seat of SEAT_ORDER) {
    const friendly = isSameSide(rootView.seat, seat, rootView.landlord);
    const turns = estimateBasicHandTurns(state.hands[seat]);
    if (friendly) {
      friendlyTurns += turns;
      friendlyCards += state.hands[seat].length;
    } else {
      enemyTurns += turns;
      enemyCards += state.hands[seat].length;
    }
  }
  return (enemyTurns - friendlyTurns) * 220 + (enemyCards - friendlyCards) * 24;
}

function rolloutCandidate(
  rootView: PlayingPlayerView,
  world: PossibleWorld,
  action: ValidatedPlayAction,
  depth: number,
): number {
  const state = createSearchState(rootView, world);
  applyAction(state, action);
  for (let ply = 0; ply < depth && state.winner === null; ply += 1) {
    const context = searchContext(rootView, state);
    const nextAction = rankScoredPlayActions(context, "expert", {
      analyzerNodes: 8,
    })[0]?.action;
    if (nextAction === undefined) {
      break;
    }
    applyAction(state, nextAction);
  }
  return rootUtility(rootView, state);
}

export function rankMasterPlayActions(
  context: PlayContext,
  options: MasterSearchOptions,
): readonly ScoredPlayAction[] {
  const expertOptions = {
    ...(options.rootAnalyzerNodes === undefined
      ? {}
      : { analyzerNodes: options.rootAnalyzerNodes }),
    ...(options.shouldContinue === undefined
      ? {}
      : { shouldContinue: options.shouldContinue }),
  };
  const expert = rankScoredPlayActions(
    context,
    "expert",
    expertOptions,
  );
  const candidates = expert.slice(0, Math.min(3, expert.length));
  if (candidates.length === 0) {
    return Object.freeze([]);
  }

  const totals = candidates.map(() => 0);
  const random = new SeededRandom(options.seed);
  let completedWorlds = 0;
  for (let worldIndex = 0; worldIndex < options.maxWorlds; worldIndex += 1) {
    if (options.shouldContinue?.() === false) {
      break;
    }
    let world: PossibleWorld;
    try {
      world = sampleWithRandom(context.view, new SeededRandom(random.nextUint()));
    } catch {
      break;
    }
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      const candidate = candidates[candidateIndex];
      if (candidate !== undefined) {
        totals[candidateIndex] = (totals[candidateIndex] ?? 0) +
          rolloutCandidate(context.view, world, candidate.action, options.rolloutDepth);
      }
    }
    completedWorlds += 1;
  }

  const ranked = candidates.map((candidate, index) => ({
    action: candidate.action,
    index,
    score: candidate.score +
      // Determinization is deliberately advisory: shallow sampled worlds are
      // noisy, so they may refine but should not casually overturn the stable
      // expert policy that produced this shortlist.
      (completedWorlds === 0 ? 0 : ((totals[index] ?? 0) / completedWorlds) * 0.2),
  }));
  ranked.sort((left, right) => right.score - left.score || left.index - right.index);
  return Object.freeze(ranked.map(({ action, score }) => Object.freeze({ action, score })));
}
