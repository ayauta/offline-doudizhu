/**
 * Research scaffolding — Spec 054 divergence diagnosis.
 *
 * Plays the shipped fixed-landlord schedule, and at every strong-seat decision
 * asks both arms. The game itself always follows the shipped arm, so the sample
 * is the positions the shipped AI actually reaches; the candidate's answer is
 * only ever an annotation on that position.
 *
 * Delete with the rest of `benchmarks/diagnosis/` once the diagnosis is done.
 */

import { getCard, type CardId } from "../../src/core/cards/index.js";
import { estimateBasicHandTurns } from "../../src/core/ai/enhanced.js";
import { createPlayerView } from "../../src/core/ai/index.js";
import type { AiDecisionContext, AiStrategy, PlayingPlayerView } from "../../src/core/ai/index.js";
import { currentPlaySeat } from "../../src/core/ai/state-evaluator.js";
import { ENHANCED_AI_SEARCH, decideEnhancedAi } from "../../src/app/ai/decision-handler.js";
import type { AiDecisionRuntime } from "../../src/app/ai/decision-handler.js";
import type { EnhancedAiType } from "../../src/app/ports/ai-decision-service.js";
import { transition, type GameCommand, type Seat } from "../../src/core/game/index.js";
import { generateLegalActions } from "../../src/core/rules/index.js";
import {
  armSchedule,
  createMeasuredStrategy,
  createRecorder,
  dealDeck,
  report,
  scheduleFor,
  startWithLandlord,
  type GameOutcome,
  type Profile,
} from "../ai-tournament.js";
import { generateShadowTree, type ShadowTree } from "./shadow-tree.js";

/**
 * `playGame` builds its own strategies from the profile map and ignores any
 * passed in, so the diagnosis needs its own driver. This mirrors that loop
 * exactly and only changes where the strategies come from -- and records every
 * command, so a diverging decision can be rebuilt by replaying the prefix.
 */
function playWithStrategies(
  deck: readonly CardId[],
  landlord: Seat,
  profiles: Readonly<Record<Seat, Profile>>,
  strategies: Readonly<Record<Seat, AiStrategy>>,
  log: DecisionLog,
): GameOutcome {
  // `startWithLandlord` bids the landlord through, so the recorded prefix starts
  // from a playing state and the replayed prefix matches what was observed.
  let state = startWithLandlord(deck, landlord);
  for (let commandCount = 0; commandCount < 256; commandCount += 1) {
    if (state.phase === "finished") {
      return Object.freeze({ winner: state.winner, commandCount });
    }
    if (state.phase !== "ready-to-play" && state.phase !== "playing") {
      throw new Error(`Unexpected diagnosis phase: ${state.phase}`);
    }
    const seat = state.currentSeat;
    const view = createPlayerView(state, seat);
    if (view === null || view.phase === "bidding") {
      throw new Error("Diagnosis expected a playing view.");
    }
    const context: AiDecisionContext = Object.freeze({
      kind: "play",
      view,
      legalActions: generateLegalActions({
        hand: view.hand,
        currentPlay: view.currentPlay,
      }),
    });
    const strategy = strategies[seat];
    if (strategy === undefined) {
      throw new Error(`Diagnosis has no strategy for seat ${seat}.`);
    }
    const command = strategy.chooseCommand(context);
    const result = transition(state, command);
    if (!result.ok) {
      throw new Error(`Illegal ${profiles[seat] ?? "unknown"} command: ${result.error.code}`);
    }
    log.commands.push(command);
    state = result.state;
  }
  throw new Error("Diagnosis game exceeded 256 commands.");
}

/**
 * A clock that never reaches its deadline, so every sampled decision is the
 * untruncated one. `shouldContinue` is the play path's only clock consumer, so
 * this removes wall-clock truncation and changes nothing else.
 */
export const UNBOUNDED: AiDecisionRuntime = Object.freeze({
  deadline: Number.MAX_SAFE_INTEGER,
  now: () => 0,
});

type PlayAction = { readonly type: "play"; readonly play: { readonly cards: readonly number[] } };

/** Sorted card ids of a validated action, for comparing arms and checking replay. */
export function actionCardsKey(action: { readonly type: string; readonly play?: { readonly cards: readonly CardId[] } }): string {
  if (action.type !== "play") {
    return "pass";
  }
  return [...(action.play?.cards ?? [])].sort((left, right) => left - right).join(",");
}

function freezeSnapshot(
  view: PlayingPlayerView,
  log: DecisionLog,
  legalActionKeys: readonly string[],
): DecisionSnapshot {
  const currentPlay = view.currentPlay;
  return Object.freeze({
    seat: view.seat,
    landlord: view.landlord,
    hand: Object.freeze([...view.hand]),
    bottomCards: Object.freeze([...view.bottomCards]),
    remainingCardCounts: view.remainingCardCounts,
    currentPlay: currentPlay === null
      ? null
      : Object.freeze({
          cards: Object.freeze([...currentPlay.cards]),
          kind: currentPlay.pattern.kind,
        }),
    currentPlaySeat: currentPlay === null ? null : lastPlaySeat(view),
    history: Object.freeze([...view.history]),
    deck: Object.freeze([...log.deck]),
    prefix: Object.freeze([...log.commands]),
    legalActionKeys: Object.freeze([...legalActionKeys]),
  });
}

/** The seat that made the play currently on the table. */
function lastPlaySeat(view: PlayingPlayerView): Seat | null {
  return currentPlaySeat(view);
}

/** Hands longer than this are not worth solving exhaustively during the probe. */
const ORACLE_HAND_LIMIT = 12;

const oracleCache = new Map<string, number>();

/**
 * Independent exhaustive minimum number of legal plays. Uses only the engine's
 * own action generator and never a production estimate as a pruning bound.
 */
function exactTurns(hand: readonly CardId[]): number {
  if (hand.length === 0) {
    return 0;
  }
  const key = Object.entries(describeHand(hand))
    .map(([rank, count]) => `${rank}:${String(count)}`)
    .sort()
    .join(",");
  const cached = oracleCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  let best = hand.length;
  for (const action of generateLegalActions({ hand, currentPlay: null })) {
    if (action.type !== "play") {
      continue;
    }
    if (action.play.cards.length === hand.length) {
      best = 1;
      break;
    }
    const used = new Set(action.play.cards);
    best = Math.min(best, 1 + exactTurns(hand.filter((card) => !used.has(card))));
    if (best === 1) {
      break;
    }
  }
  oracleCache.set(key, best);
  return best;
}

/** Rank counts of a hand, e.g. `{ "3": 3, "4": 3, "5": 1 }`. */
function describeHand(hand: readonly CardId[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const cardId of hand) {
    const { rank } = getCard(cardId);
    counts[rank] = (counts[rank] ?? 0) + 1;
  }
  return counts;
}

/** Sorted card ids, so two arms compare structurally rather than by identity. */
function actionKey(action: unknown): string {
  if (typeof action !== "object" || action === null || !("type" in action)) {
    return "unknown";
  }
  if (action.type !== "play") {
    return "pass";
  }
  const cards = (action as PlayAction).play.cards;
  return [...cards].sort((left, right) => left - right).join(",");
}

/**
 * Everything needed to replay this decision on its own, without rebuilding the
 * trajectory that reached it. Storing `{seed, deal, game}` instead would be
 * fragile: any earlier change in play shifts the position at this index.
 */
export type DecisionSnapshot = Readonly<{
  seat: Seat;
  landlord: Seat;
  hand: readonly CardId[];
  bottomCards: readonly CardId[];
  remainingCardCounts: Readonly<Record<Seat, number>>;
  currentPlay: { readonly cards: readonly CardId[]; readonly kind: string } | null;
  currentPlaySeat: Seat | null;
  history: readonly unknown[];
  /** The dealt deck, so the position can be rebuilt by replaying `prefix`. */
  deck: readonly CardId[];
  /** Every command played before this decision, in order. */
  prefix: readonly GameCommand[];
  /** Legal actions at this decision, for checking a rebuilt position matches. */
  legalActionKeys: readonly string[];
}>;

/** Commands played so far in the current game, shared with the probe strategy. */
type DecisionLog = { commands: GameCommand[]; deck: readonly CardId[] };

export type ProbeRecord = Readonly<{
  dealIndex: number;
  gameIndex: number;
  arm: "A" | "B";
  seat: Seat;
  landlord: Seat;
  handSize: number;
  legalActionCount: number;
  snapshot: DecisionSnapshot;
  shippedChoice: string;
  candidateChoice: string;
  /** Rank counts of the acting hand, keyed by rank name; the estimator's input. */
  handCounts: Readonly<Record<string, number>>;
  /** The shipped estimate's answer, which is what the search starts from. */
  shippedEstimate: number;
  /** True when that starting bound is strictly below hand size, i.e. optimistic. */
  optimisticSeed: boolean;
  /** Candidate arm's `minimumTurns` for the same hand under the shipped budget. */
  candidateEstimate: number;
  /** Independent exhaustive minimum, or null when the hand is too large to solve. */
  trueTurns: number | null;
  /** True when the arms choose different card sets, or one plays and one passes. */
  diverges: boolean;
}>;

export type Bucket = Readonly<{ at: number; decisions: number; divergences: number }>;

export type ProbeRun = Readonly<{
  strongProfile: EnhancedAiType;
  seedBase: number;
  deals: number;
  decisions: number;
  divergences: number;
  recordsKept: number;
  byHandSize: readonly Bucket[];
  byLegalActionCount: readonly Bucket[];
  records: readonly ProbeRecord[];
}>;

export type HarvestOptions = Readonly<{
  seedBase: number;
  deals: number;
  /** Only the enhanced tiers are diagnosed; `default` has no analyzer to vary. */
  strongProfile: EnhancedAiType;
  /** Suppress the per-deal progress lines. */
  quiet?: boolean;
}>;

function bucketInto(
  records: readonly ProbeRecord[],
  pick: (record: ProbeRecord) => number,
): readonly Bucket[] {
  const buckets = new Map<number, { decisions: number; divergences: number }>();
  for (const record of records) {
    const at = pick(record);
    const bucket = buckets.get(at) ?? { decisions: 0, divergences: 0 };
    bucket.decisions += 1;
    if (record.diverges) {
      bucket.divergences += 1;
    }
    buckets.set(at, bucket);
  }
  return Object.freeze(
    [...buckets.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([at, bucket]) => Object.freeze({ at, ...bucket })),
  );
}

/**
 * The strong seat answers through the shipped handler, then the candidate arm
 * ranks the same frozen context. Only the shipped answer is ever played.
 */
function createProbeStrategy(
  strongSeat: Seat,
  strongProfile: EnhancedAiType,
  shadow: ShadowTree,
  decisionSeed: number,
  log: DecisionLog,
  sink: (record: ProbeRecord) => void,
): AiStrategy {
  let decisionIndex = 0;
  return Object.freeze({
    chooseCommand(context: AiDecisionContext): ReturnType<AiStrategy["chooseCommand"]> {
      const shipped = decideEnhancedAi(
        {
          requestId: decisionIndex,
          aiType: strongProfile,
          context,
          seed: (decisionSeed + decisionIndex * 7919) >>> 0,
        },
        UNBOUNDED,
      );
      decisionIndex += 1;
      if (context.kind !== "play" || context.view.seat !== strongSeat) {
        if (!shipped.ok) {
          throw new Error(`Shipped arm refused a decision: ${shipped.reason}`);
        }
        return shipped.command;
      }

      const candidate = shadow.rankScoredPlayActions(context, "expert", {
        analyzerNodes: ENHANCED_AI_SEARCH.rootAnalyzerNodes,
      });
      const shippedChoice = shipped.ok && shipped.command.type === "play"
        ? actionKey({ type: "play", play: { cards: shipped.command.cards } })
        : "pass";
      const candidateChoice = actionKey(candidate[0]?.action);
      const legalActionKeys = context.legalActions.map((action) =>
        action.type === "play" ? actionCardsKey({ type: "play", play: { cards: action.play.cards } }) : "pass",
      );
      const shippedEstimate = estimateBasicHandTurns(context.view.hand);
      // Mirror the shipped allowance exactly: one fresh analyzer per candidate,
      // each with floor(rootAnalyzerNodes / legalActions), because a shared node
      // counter makes later candidates depend on generator order.
      const nodesPerAction = Math.max(
        1,
        Math.floor(ENHANCED_AI_SEARCH.rootAnalyzerNodes / Math.max(1, context.legalActions.length)),
      );
      const candidateEstimate = shadow
        .createHandAnalyzer({ maxNodes: nodesPerAction })
        .analyze(context.view.hand).minimumTurns;
      const trueTurns = context.view.hand.length <= ORACLE_HAND_LIMIT
        ? exactTurns(context.view.hand)
        : null;
      sink({
        dealIndex: -1,
        gameIndex: -1,
        arm: "A",
        seat: context.view.seat,
        landlord: context.view.landlord,
        handSize: context.view.hand.length,
        legalActionCount: context.legalActions.length,
        snapshot: freezeSnapshot(context.view, log, legalActionKeys),
        shippedChoice,
        candidateChoice,
        handCounts: describeHand(context.view.hand),
        shippedEstimate,
        optimisticSeed: shippedEstimate < context.view.hand.length,
        candidateEstimate,
        trueTurns,
        diverges: shippedChoice !== candidateChoice,
      });
      if (!shipped.ok) {
        throw new Error(`Shipped arm refused a decision: ${shipped.reason}`);
      }
      return shipped.command;
    },
  });
}

export async function runProbe(options: HarvestOptions): Promise<ProbeRun> {
  const shadow = await generateShadowTree();
  const records: ProbeRecord[] = [];
  let decisions = 0;
  let divergences = 0;

  for (let dealIndex = 0; dealIndex < options.deals; dealIndex += 1) {
    const dealSeed = options.seedBase + dealIndex;
    const deck = dealDeck(dealSeed);
    const games = armSchedule(dealIndex);

    for (let gameIndex = 0; gameIndex < games.length; gameIndex += 1) {
      const game = games[gameIndex];
      if (game === undefined) {
        continue;
      }
      const seatSeed = dealSeed * 100 + gameIndex * 10 + 1;
      const profiles = scheduleFor(options.strongProfile, "default", game.strongSeat);
      const recorder = createRecorder();
      const strategies: Record<Seat, AiStrategy> = {
        human: createMeasuredStrategy(profiles.human, recorder, { unboundedEvery: 0, seed: seatSeed + 1, designed: true }),
        "ai-one": createMeasuredStrategy(profiles["ai-one"], recorder, { unboundedEvery: 0, seed: seatSeed + 2, designed: true }),
        "ai-two": createMeasuredStrategy(profiles["ai-two"], recorder, { unboundedEvery: 0, seed: seatSeed + 3, designed: true }),
      };
      const log: DecisionLog = { commands: [], deck };
      strategies[game.strongSeat] = createProbeStrategy(
        game.strongSeat,
        options.strongProfile,
        shadow,
        seatSeed,
        log,
        (record) => {
          decisions += 1;
          if (record.diverges) {
            divergences += 1;
          }
          records.push(Object.freeze({ ...record, dealIndex, gameIndex, arm: game.arm }));
        },
      );
      playWithStrategies(deck, game.landlord, profiles, strategies, log);
    }

    if (!options.quiet && dealIndex % 5 === 0) {
      report(`[probe] deal ${String(dealIndex + 1)}/${String(options.deals)} decisions ${String(decisions)} divergences ${String(divergences)}`);
    }
  }

  return Object.freeze({
    strongProfile: options.strongProfile,
    seedBase: options.seedBase,
    deals: options.deals,
    decisions,
    divergences,
    recordsKept: records.length,
    byHandSize: bucketInto(records, (record) => record.handSize),
    byLegalActionCount: bucketInto(records, (record) => record.legalActionCount),
    records: Object.freeze(records),
  });
}
