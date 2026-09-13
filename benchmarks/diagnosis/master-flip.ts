/**
 * Research scaffolding — measures how often the winning-distance aggregation
 * changes master's chosen move.
 *
 * Reimplements only the pieces the aggregation touches: the rollout and the
 * blend. Everything else calls the real exported functions, so the stub differs
 * from production in exactly one respect — it sums a camp's distances instead of
 * taking the shortest. That makes it both the flip measurement and the evidence
 * that a guard on the aggregation can fail.
 *
 * Delete with the rest of `benchmarks/diagnosis/`.
 */

import { ENHANCED_AI_SEARCH } from "../../src/app/ai/decision-handler.js";
import type { CardId } from "../../src/core/cards/index.js";
import { SEAT_ORDER, type PlayHistoryEntry, type Seat } from "../../src/core/game/index.js";
import { generateLegalActions, type ClassifiedPlay, type ValidatedPlayAction } from "../../src/core/rules/index.js";
import type { AiDecisionContext, PlayingPlayerView } from "../../src/core/ai/index.js";
import { estimateBasicHandTurns } from "../../src/core/ai/hand-analyzer.js";
import { rankScoredPlayActions } from "../../src/core/ai/scoring-policy.js";
import { currentPlaySeat, isSameSide } from "../../src/core/ai/state-evaluator.js";
import { samplePossibleWorld } from "../../src/core/ai/master-policy.js";

type PlayContext = Extract<AiDecisionContext, { readonly kind: "play" }>;

type Mutable = {
  hands: Record<Seat, CardId[]>;
  currentSeat: Seat;
  currentPlay: ClassifiedPlay | null;
  lastPlaySeat: Seat | null;
  consecutivePasses: 0 | 1;
  history: PlayHistoryEntry[];
  winner: Seat | null;
};

/** Same LCG the shipped master uses, so worlds are drawn identically. */
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

function nextSeat(seat: Seat): Seat {
  return SEAT_ORDER[(SEAT_ORDER.indexOf(seat) + 1) % SEAT_ORDER.length] ?? "human";
}

function applyAction(state: Mutable, action: ValidatedPlayAction): void {
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
  state.hands[seat] = state.hands[seat].filter((card) => !played.has(card));
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

function searchContext(rootView: PlayingPlayerView, state: Mutable): PlayContext {
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

/**
 * The only difference from production: a camp's distance is the SUM of its
 * seats' remaining plays rather than the SHORTEST.
 */
function sumUtility(rootView: PlayingPlayerView, state: Mutable): number {
  if (state.winner !== null) {
    return isSameSide(rootView.seat, state.winner, rootView.landlord) ? 10_000 : -10_000;
  }
  let friendlyTurns = 0;
  let enemyTurns = 0;
  let friendlyCards = 0;
  let enemyCards = 0;
  for (const seat of SEAT_ORDER) {
    const turns = estimateBasicHandTurns(state.hands[seat]);
    if (isSameSide(rootView.seat, seat, rootView.landlord)) {
      friendlyTurns += turns;
      friendlyCards += state.hands[seat].length;
    } else {
      enemyTurns += turns;
      enemyCards += state.hands[seat].length;
    }
  }
  return (enemyTurns - friendlyTurns) * 220 + (enemyCards - friendlyCards) * 24;
}

// Read from the shipped sizing: this stub exists to differ from production in
// exactly one respect, and retyped rollout options quietly made it two.
const MAX_WORLDS = ENHANCED_AI_SEARCH.maxWorlds;
const ROLLOUT_DEPTH = ENHANCED_AI_SEARCH.rolloutDepth;
const ROOT_NODES = ENHANCED_AI_SEARCH.rootAnalyzerNodes;
const SHORTLIST = 3;

function startState(rootView: PlayingPlayerView, worldHands: Record<Seat, readonly CardId[]>): Mutable {
  return {
    hands: {
      human: [...worldHands.human],
      "ai-one": [...worldHands["ai-one"]],
      "ai-two": [...worldHands["ai-two"]],
    },
    currentSeat: rootView.seat,
    currentPlay: rootView.currentPlay,
    lastPlaySeat: rootView.currentPlay === null ? null : currentPlaySeat(rootView),
    consecutivePasses: rootView.currentPlay !== null && rootView.history.at(-1)?.type === "pass" ? 1 : 0,
    history: [...rootView.history],
    winner: null,
  };
}

function rollout(rootView: PlayingPlayerView, world: ReturnType<typeof samplePossibleWorld>, action: ValidatedPlayAction): number {
  const state = startState(rootView, world.hands);
  applyAction(state, action);
  for (let ply = 0; ply < ROLLOUT_DEPTH && state.winner === null; ply += 1) {
    const context = searchContext(rootView, state);
    const next = rankScoredPlayActions(context, "expert", { analyzerNodes: 8 })[0]?.action;
    if (next === undefined) {
      break;
    }
    applyAction(state, next);
  }
  return sumUtility(rootView, state);
}

/** The shipped ranking with the sum aggregation; the stub the guard compares against. */
export function rankWithSumUtility(context: PlayContext, seed: number): readonly { action: ValidatedPlayAction | undefined; score: number }[] {
  const expert = rankScoredPlayActions(context, "expert", { analyzerNodes: ROOT_NODES });
  const candidates = expert.slice(0, Math.min(SHORTLIST, expert.length));
  if (candidates.length === 0) {
    return Object.freeze([]);
  }
  const totals = candidates.map(() => 0);
  const random = new SeededRandom(seed);
  let completed = 0;
  for (let worldIndex = 0; worldIndex < MAX_WORLDS; worldIndex += 1) {
    const world = samplePossibleWorld(context.view, random.nextUint());
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (candidate !== undefined) {
        totals[index] = (totals[index] ?? 0) + rollout(context.view, world, candidate.action);
      }
    }
    completed += 1;
  }
  const ranked = candidates.map((candidate, index) => ({
    action: candidate.action,
    score: candidate.score + (completed === 0 ? 0 : ((totals[index] ?? 0) / completed) * 0.2),
  }));
  ranked.sort((left, right) => right.score - left.score);
  return Object.freeze(ranked);
}
