/**
 * Shared fixtures for the Phase 2 guards.
 *
 * These live in one place because the alternative is worse than duplication:
 * `redealHidden` is the fixture that decides whether the leakage guards are
 * testing anything at all. Two copies that quietly drift apart would leave one
 * guard file proving invariance against a re-deal that no longer re-deals.
 */
import {
  compareCardIds,
  createDeck,
  shuffle,
  type CardId,
} from "../../src/core/cards/index.js";
import {
  SEAT_ORDER,
  transition,
  type GameState,
  type PlayingState,
  type Seat,
} from "../../src/core/game/index.js";
import {
  generateLegalActions,
  type ValidatedPlayAction,
} from "../../src/core/rules/index.js";
import type { PlayingPlayerView } from "../../src/core/ai/index.js";
import { dealDeck, startWithLandlord } from "../../benchmarks/ai-tournament.js";
import {
  CF_CANDIDATE_LIMIT,
  cfPlayContext,
  cfPolicyCommand,
  type CfPolicyCounters,
  type CfSeatTiers,
} from "../../benchmarks/cf-dataset.js";
import { seededRandom } from "./harness.js";

/** The cheap, clock-free tier set; `master` is used only where it is the subject. */
export const LIGHT_TIERS: CfSeatTiers = Object.freeze({
  human: "default",
  "ai-one": "default",
  "ai-two": "default",
});

/** Master for one seat, default for the rest — the arm-B production schedule. */
export function studiedTiers(studiedSeat: Seat): CfSeatTiers {
  return Object.freeze({
    human: studiedSeat === "human" ? "master" : "default",
    "ai-one": studiedSeat === "ai-one" ? "master" : "default",
    "ai-two": studiedSeat === "ai-two" ? "master" : "default",
  });
}

export function zeroCounters(): CfPolicyCounters {
  return { human: 0, "ai-one": 0, "ai-two": 0 };
}

export function seatIndexOf(seat: Seat): number {
  return SEAT_ORDER.indexOf(seat);
}

export function advance(
  state: GameState,
  gameSeed: number,
  tiers: CfSeatTiers,
  counters: CfPolicyCounters,
  plies: number,
): GameState {
  let current = state;
  for (let ply = 0; ply < plies; ply += 1) {
    if (current.phase !== "playing" && current.phase !== "ready-to-play") {
      break;
    }
    const seat = current.currentSeat;
    const context = cfPlayContext(current, seat);
    const command = cfPolicyCommand(tiers, gameSeed, seat, context, counters[seat]);
    counters[seat] += 1;
    const result = transition(current, command);
    if (!result.ok) {
      throw new Error(`Guard setup played an illegal command: ${result.error.code}`);
    }
    current = result.state;
  }
  return current;
}

/** Walks a real game up to the studied farmer's first root decision. */
export function toFarmerRoot(
  dealSeed: number,
  gameSeed: number,
  landlord: Seat,
  studied: Seat,
  tiers: CfSeatTiers = LIGHT_TIERS,
): Readonly<{ state: GameState; counters: CfPolicyCounters }> {
  const counters = zeroCounters();
  let state: GameState = startWithLandlord(dealDeck(dealSeed), landlord);
  for (let ply = 0; ply < 64; ply += 1) {
    if (state.phase === "finished") {
      throw new Error("Guard setup exhausted the deal before the studied root.");
    }
    if (state.phase !== "playing" && state.phase !== "ready-to-play") {
      throw new Error(`Guard setup reached phase ${state.phase}.`);
    }
    if (state.currentSeat === studied) {
      return Object.freeze({ state, counters });
    }
    state = advance(state, gameSeed, tiers, counters, 1);
  }
  throw new Error("Guard setup never reached the studied seat.");
}

/**
 * Replaces the two hidden hands with a *different* deal of the same cards while
 * holding the studied seat's hand and every public fact fixed. The landlord
 * keeps the bottom cards it still holds and the table keeps the cards already
 * played, so the alternative world is one no public statement contradicts.
 */
export function redealHidden(state: PlayingState, studied: Seat, seed: number): PlayingState {
  const ours = new Set<CardId>(state.hands[studied]);
  const pinned = new Set<CardId>(state.bottomCards);
  const played = new Set<CardId>();
  for (const entry of state.history) {
    if (entry.type === "play") {
      for (const cardId of entry.play.cards) {
        played.add(cardId);
      }
    }
  }
  const pinnedHeld = state.bottomCards.filter((cardId) => !played.has(cardId));
  const pool = createDeck().filter(
    (cardId) => !ours.has(cardId) && !played.has(cardId) && !pinned.has(cardId),
  );
  const drawn = shuffle(pool, seededRandom(seed));
  const landlord = state.landlord;
  const partner = SEAT_ORDER.find((seat) => seat !== studied && seat !== landlord);
  if (partner === undefined) {
    throw new Error("Guard setup could not identify the partner seat.");
  }
  const landlordNeed = state.hands[landlord].length - pinnedHeld.length;
  const partnerNeed = state.hands[partner].length;
  if (landlordNeed < 0 || landlordNeed + partnerNeed !== drawn.length) {
    throw new Error("Guard setup could not re-deal the hidden cards.");
  }
  const landlordHand = [...pinnedHeld, ...drawn.slice(0, landlordNeed)].sort(compareCardIds);
  const partnerHand = drawn.slice(landlordNeed).sort(compareCardIds);
  return Object.freeze({
    ...state,
    hands: Object.freeze({
      ...state.hands,
      [landlord]: Object.freeze(landlordHand),
      [partner]: Object.freeze(partnerHand),
    }),
  });
}

export function twoActions(
  view: PlayingPlayerView,
): readonly [ValidatedPlayAction, ValidatedPlayAction] {
  const actions = generateLegalActions({ hand: view.hand, currentPlay: view.currentPlay });
  const first = actions[0];
  const second = actions[1] ?? actions[0];
  if (first === undefined || second === undefined) {
    throw new Error("Guard setup needs two legal actions.");
  }
  return [first, second];
}

/**
 * A root with a *wide* legal-action set. On a two-action root "the top three"
 * and "everything legal" are indistinguishable, so a candidate-rule check
 * written against an arbitrary root can pass on any rule at all.
 */
export function wideFarmerRoot(): Readonly<{
  state: GameState;
  counters: CfPolicyCounters;
  gameSeed: number;
  seat: Seat;
}> {
  for (let dealSeed = 50_001; dealSeed < 50_060; dealSeed += 1) {
    const gameSeed = dealSeed * 100 + 4;
    const seat: Seat = "ai-one";
    const { state, counters } = toFarmerRoot(dealSeed, gameSeed, "human", seat);
    if (state.phase !== "playing" && state.phase !== "ready-to-play") {
      continue;
    }
    const context = cfPlayContext(state, seat);
    if (context.legalActions.length > CF_CANDIDATE_LIMIT + 1) {
      return Object.freeze({ state, counters, gameSeed, seat });
    }
  }
  throw new Error("Guard setup found no root wide enough to test the candidate rule.");
}
