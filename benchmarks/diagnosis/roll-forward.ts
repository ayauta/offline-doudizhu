/**
 * Research scaffolding — Spec 054 paired roll-forward.
 *
 * For a divergence, play each arm's chosen action from the frozen decision, then
 * continue to the end with the real shipped handler. Both branches start from
 * the same deal, the same command prefix, and a fixed seed, so the comparison is
 * a paired / crossover observation -- NOT an independent one. The two branches
 * share the deal, the position, and the hidden information.
 *
 * Running both continuations is deliberate: if the shipped continuation favours
 * the shipped action ("it knows how to follow up its own move"), the crossed
 * cells measure that incumbent bias instead of hiding it.
 *
 * The position is rebuilt by replaying the recorded command prefix from the deal
 * rather than stored as a view, because a `PlayingPlayerView` does not carry the
 * other seats' hands and a full state cannot be reconstructed from public
 * information alone.
 *
 * Delete with the rest of `benchmarks/diagnosis/`.
 */

import type { AiDecisionContext, AiStrategy, PlayerView } from "../../src/core/ai/index.js";
import { createPlayerView } from "../../src/core/ai/index.js";
import { transition } from "../../src/core/game/index.js";
import type { GameCommand, GameState, Seat } from "../../src/core/game/index.js";
import { asCardId } from "../../src/core/cards/index.js";
import { startWithLandlord } from "../ai-tournament.js";
import { generateLegalActions } from "../../src/core/rules/index.js";
import { decideEnhancedAi } from "../../src/app/ai/decision-handler.js";
import type { EnhancedAiType } from "../../src/app/ports/ai-decision-service.js";
import { UNBOUNDED } from "./harvest.js";
import type { DecisionSnapshot, ProbeRecord } from "./harvest.js";

/**
 * Replays `prefix` from the same starting point the harvest used, so the
 * recorded commands line up. `startWithLandlord` bids the landlord through;
 * the prefix holds only the playing commands that followed.
 */
export function replayToDecision(
  snapshot: DecisionSnapshot,
  prefix: readonly GameCommand[],
): GameState {
  let state = startWithLandlord(snapshot.deck, snapshot.landlord);
  for (const command of prefix) {
    const result = transition(state, command);
    if (!result.ok) {
      throw new Error(`Roll-forward prefix is illegal: ${result.error.code}`);
    }
    state = result.state;
  }
  return state;
}

/** Checks a rebuilt state matches the frozen public view, so a prefix cannot silently drift. */
export function matchesSnapshot(state: GameState, snapshot: DecisionSnapshot): boolean {
  const view: PlayerView | null = createPlayerView(state, snapshot.seat);
  if (view === null || view.phase === "bidding") {
    return false;
  }
  if (view.seat !== snapshot.seat || view.landlord !== snapshot.landlord) {
    return false;
  }
  const hand = [...view.hand].sort((left, right) => left - right).join(",");
  const expected = [...snapshot.hand].sort((left, right) => left - right).join(",");
  if (hand !== expected) {
    return false;
  }
  const legal = generateLegalActions({ hand: view.hand, currentPlay: view.currentPlay })
    .map((action) => action.type === "play"
      ? [...action.play.cards].sort((left, right) => left - right).join(",")
      : "pass")
    .sort()
    .join("|");
  return legal === [...snapshot.legalActionKeys].sort().join("|");
}

function continuationFor(
  strategies: Readonly<Record<Seat, AiStrategy>>,
  seat: Seat,
): AiStrategy {
  const strategy = strategies[seat];
  if (strategy === undefined) {
    throw new Error(`Roll-forward has no strategy for seat ${seat}.`);
  }
  return strategy;
}

function continuationStrategy(profile: EnhancedAiType, seed: number): AiStrategy {
  let decisionIndex = 0;
  return Object.freeze({
    chooseCommand(context: AiDecisionContext) {
      const outcome = decideEnhancedAi(
        {
          requestId: decisionIndex,
          aiType: profile,
          context,
          seed: (seed + decisionIndex * 7919) >>> 0,
        },
        UNBOUNDED,
      );
      decisionIndex += 1;
      if (!outcome.ok) {
        throw new Error(`Continuation decision failed: ${outcome.reason}`);
      }
      return outcome.command;
    },
  });
}

/**
 * Plays one branch to the end: the forced root action, then the continuation
 * policy for every seat afterwards. Returns the winning seat.
 */
export function playBranch(options: Readonly<{
  snapshot: DecisionSnapshot;
  prefix: readonly GameCommand[];
  rootCommand: GameCommand;
  continuationProfile: EnhancedAiType;
  seed: number;
}>): Seat {
  let state = replayToDecision(options.snapshot, options.prefix);
  const strategies: Record<Seat, AiStrategy> = {
    human: continuationStrategy(options.continuationProfile, options.seed + 1),
    "ai-one": continuationStrategy(options.continuationProfile, options.seed + 2),
    "ai-two": continuationStrategy(options.continuationProfile, options.seed + 3),
  };
  const rootSeat = options.snapshot.seat;
  let forceRoot = true;

  for (let commandCount = 0; commandCount < 256; commandCount += 1) {
    if (state.phase === "finished") {
      return state.winner;
    }
    if (state.phase !== "ready-to-play" && state.phase !== "playing") {
      throw new Error(`Roll-forward hit an unexpected phase: ${state.phase}`);
    }
    const seat = state.currentSeat;
    const view = createPlayerView(state, seat);
    if (view === null || view.phase === "bidding") {
      throw new Error("Roll-forward expected a playing view.");
    }
    const context = Object.freeze({
      kind: "play" as const,
      view,
      legalActions: generateLegalActions({ hand: view.hand, currentPlay: view.currentPlay }),
    });
    const useRoot = forceRoot && seat === rootSeat;
    const command = useRoot ? options.rootCommand : continuationFor(strategies, seat).chooseCommand(context);
    forceRoot = false;
    const result = transition(state, command);
    if (!result.ok) {
      throw new Error(`Roll-forward produced an illegal command: ${result.error.code}`);
    }
    state = result.state;
  }
  throw new Error("Roll-forward exceeded 256 commands.");
}

/** The acting seat's own side won, from its point of view. */
function sideWon(rootSeat: Seat, landlord: Seat, winner: Seat): boolean {
  return rootSeat === landlord ? winner === landlord : winner !== landlord;
}

function rootCommandFor(snapshot: DecisionSnapshot, cardsKey: string): GameCommand {
  if (cardsKey === "pass") {
    return Object.freeze({ type: "pass", seat: snapshot.seat });
  }
  const cards = cardsKey.split(",").map((value) => asCardId(Number(value)));
  return Object.freeze({ type: "play", seat: snapshot.seat, cards: Object.freeze(cards) });
}

export type CellOutcome = Readonly<{
  root: "shipped" | "candidate";
  continuation: EnhancedAiType;
  branches: number;
  wins: number;
}>;

export type DivergenceOutcome = Readonly<{
  record: ProbeRecord;
  cells: readonly CellOutcome[];
  /** False when the recorded prefix could not rebuild the observed position. */
  rebuilt: boolean;
}>;

export type RollForwardOptions = Readonly<{
  records: readonly ProbeRecord[];
  continuationProfiles: readonly EnhancedAiType[];
  seed: number;
  /** Soft cap in milliseconds; stops cleanly and reports how far it got. */
  secondsCap?: number;
}>;

export type RollForwardRun = Readonly<{
  attempted: number;
  completed: number;
  verified: number;
  elapsedMs: number;
  stoppedEarly: boolean;
  outcomes: readonly DivergenceOutcome[];
}>;

/**
 * Runs the crossover for every divergence. Each branch plays the forced root
 * action and then the continuation policy; the same continuation seed is reused
 * across cells so the only difference between them is the root action.
 */
export function rollForward(options: RollForwardOptions): RollForwardRun {
  const started = performance.now();
  const outcomes: DivergenceOutcome[] = [];
  let verified = 0;
  let stoppedEarly = false;

  for (const record of options.records) {
    if (options.secondsCap !== undefined && performance.now() - started > options.secondsCap) {
      stoppedEarly = true;
      break;
    }
    const snapshot = record.snapshot;
    const rebuilt = matchesSnapshot(replayToDecision(snapshot, snapshot.prefix), snapshot);
    if (rebuilt) {
      verified += 1;
    }
    const cells: CellOutcome[] = [];
    for (const [root, cardsKey] of [
      ["shipped", record.shippedChoice],
      ["candidate", record.candidateChoice],
    ] as const) {
      for (const continuation of options.continuationProfiles) {
        let wins = 0;
        for (const branchSeed of [0, 1, 2]) {
          const winner = playBranch({
            snapshot,
            prefix: snapshot.prefix,
            rootCommand: rootCommandFor(snapshot, cardsKey),
            continuationProfile: continuation,
            seed: options.seed + branchSeed,
          });
          if (sideWon(snapshot.seat, snapshot.landlord, winner)) {
            wins += 1;
          }
        }
        cells.push(
          Object.freeze({ root, continuation, branches: 3, wins }),
        );
      }
    }
    outcomes.push(Object.freeze({ record, cells: Object.freeze(cells), rebuilt }));
  }

  return Object.freeze({
    attempted: options.records.length,
    completed: outcomes.length,
    verified,
    elapsedMs: performance.now() - started,
    stoppedEarly,
    outcomes: Object.freeze(outcomes),
  });
}
