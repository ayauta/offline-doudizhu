/**
 * Tournament machinery for the AI strength benchmark.
 *
 * The one rule this file exists to enforce: measure what ships. Every enhanced
 * level is played by calling the real `decideEnhancedAi` with the real
 * `ENHANCED_AI_BUDGET_MS`, imported — never retyped. The previous benchmark
 * carried its own stand-in strategies and drifted from the product because of
 * it (it ran master at 4 sampled worlds while production runs 32).
 *
 * Nothing here imports from or writes to `src/`; this is dev tooling.
 */

import {
  CASUAL_AI_STRATEGY,
  createPlayerView,
  type AiDecisionContext,
  type AiStrategy,
} from "../src/core/ai/index.js";
import { rankScoredPlayActions } from "../src/core/ai/enhanced.js";
import {
  createDeck,
  shuffle,
  type CardId,
  type RandomSource,
} from "../src/core/cards/index.js";
import {
  INITIAL_GAME_STATE,
  SEAT_ORDER,
  transition,
  type GameCommand,
  type GameState,
  type Seat,
} from "../src/core/game/index.js";
import { generateLegalActions } from "../src/core/rules/index.js";
import {
  ENHANCED_AI_BUDGET_MS,
  decideEnhancedAi,
} from "../src/app/ai/decision-handler.js";
import type { EnhancedAiType } from "../src/app/ports/ai-decision-service.js";
import { ENHANCED_AI_RESPONSE_WINDOW_MS } from "../src/app/ai/enhanced-ai-turn.js";

export type Profile = "casual" | "default" | "expert" | "master";

export const PROFILES: readonly Profile[] = Object.freeze([
  "casual",
  "default",
  "expert",
  "master",
]);

export type TrialKind = "bid" | "play";

export type UnboundedComparison = Readonly<{
  polls: number;
  elapsedMs: number;
  agrees: boolean;
}>;

export type DecisionRecord = Readonly<{
  profile: Profile;
  kind: TrialKind;
  elapsedMs: number;
  /** null for the default level, which is synchronous and has no budget. */
  budgetMs: number | null;
  /** Times the runtime clock was read — i.e. how often the budget was checked. */
  polls: number;
  /** True when the level's own budget check fired: work was cut short. */
  reachedDeadline: boolean;
  legalActionCount: number;
  /**
   * Master only: whether the sampled rollout overturned the action its own root
   * ranking led with. This is the direct measure of whether the search earns its
   * keep, separate from whether it is budget-limited.
   */
  rootLeaderDiffers: boolean | null;
  /** Present only on the sampled decisions re-run without a deadline. */
  unbounded: UnboundedComparison | null;
}>;

export type Recorder = Readonly<{
  records: DecisionRecord[];
  /** Serialized commands in play order, or null when command logging is off. */
  commands: string[] | null;
  push: (record: DecisionRecord) => void;
  forProfile: (profile: Profile, kind?: TrialKind) => DecisionRecord[];
}>;

export type BenchmarkConfig = Readonly<{
  deals: number;
  seedBase: number;
  secondsCap: number;
  probeDeals: number;
  controlDeals: number;
  unboundedEvery: number;
  strict: boolean;
  /**
   * Strict-mode ceiling on the share of a level's decisions whose own budget
   * cuts its work short. Provisional until the first measured baseline; it is
   * machine-dependent, so it only ever applies under AI_BENCH_STRICT=1.
   */
  truncationCeiling: number;
  pairs: readonly (readonly [Profile, Profile])[] | null;
}>;

export const ALL_PAIRS: ReadonlyArray<readonly [Profile, Profile]> = Object.freeze([
  Object.freeze(["casual", "default"] as const),
  Object.freeze(["default", "expert"] as const),
  Object.freeze(["expert", "master"] as const),
]);

export const CONTROL_PAIR: readonly [Profile, Profile] = Object.freeze(["casual", "master"]);

function isProfile(value: string | undefined): value is Profile {
  return value !== undefined && (PROFILES as readonly string[]).includes(value);
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, received "${raw}".`);
  }
  return parsed;
}

export function readConfig(): BenchmarkConfig {
  const pairsRaw = process.env.AI_BENCH_PAIRS;
  const pairs = pairsRaw === undefined || pairsRaw === "all" || pairsRaw === ""
    ? null
    : pairsRaw.split(",").map((entry) => {
      const [weaker, stronger] = entry.split(":").map((part) => part.trim());
      if (!isProfile(weaker) || !isProfile(stronger)) {
        throw new Error(`AI_BENCH_PAIRS entry "${entry}" must look like casual:default.`);
      }
      return Object.freeze([weaker, stronger] as const);
    });
  return Object.freeze({
    deals: Math.max(1, envInt("AI_BENCH_DEALS", 20)),
    seedBase: envInt("AI_BENCH_SEED", 301),
    secondsCap: Math.max(1, envInt("AI_BENCH_SECONDS", 240)),
    probeDeals: Math.max(1, envInt("AI_BENCH_PROBE_DEALS", 4)),
    controlDeals: Math.max(1, envInt("AI_BENCH_CONTROL_DEALS", 10)),
    unboundedEvery: Math.max(1, envInt("AI_BENCH_UNBOUNDED_EVERY", 10)),
    strict: process.env.AI_BENCH_STRICT === "1",
    truncationCeiling: (() => {
      const raw = process.env.AI_BENCH_TRUNCATION_CEILING;
      if (raw === undefined || raw === "") {
        return 0.25;
      }
      const parsed = Number.parseFloat(raw);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        throw new Error(`AI_BENCH_TRUNCATION_CEILING must be a fraction in [0,1], received "${raw}".`);
      }
      return parsed;
    })(),
    pairs,
  });
}

export function isEnhanced(profile: Profile): profile is EnhancedAiType {
  return profile !== "default";
}

export function createRecorder(
  options: Readonly<{ logCommands?: boolean }> = {},
): Recorder {
  const records: DecisionRecord[] = [];
  const commands = options.logCommands === true ? [] : null;
  return Object.freeze({
    records,
    commands,
    push(record: DecisionRecord) {
      records.push(record);
    },
    forProfile(profile: Profile, kind?: TrialKind) {
      return records.filter(
        (record) => record.profile === profile && (kind === undefined || record.kind === kind),
      );
    },
  });
}

export function seededRandom(seed: number): RandomSource {
  let value = seed >>> 0;
  return {
    next() {
      value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
      return value / 0x1_0000_0000;
    },
  };
}

export function dealDeck(seed: number): readonly CardId[] {
  return shuffle(createDeck(), seededRandom(seed));
}

/**
 * Wraps the runtime clock. `shouldContinue` is the only consumer of `now()` on
 * the play path, so "the clock was read at or past the deadline" is exactly
 * "this level's own budget check fired". This measures truncation without
 * adding a single byte to the shipped worker bundle.
 */
function instrumentedRuntime(deadline: number, sink: { polls: number; reached: boolean }) {
  return {
    deadline,
    now: () => {
      const value = performance.now();
      sink.polls += 1;
      if (value >= deadline) {
        sink.reached = true;
      }
      return value;
    },
  };
}

/**
 * A strategy that records the shipped decision, and (on a sample of calls)
 * re-runs the identical frozen context with no deadline, so the cost of the
 * budget itself is visible.
 */
export function createMeasuredStrategy(
  profile: Profile,
  recorder: Recorder,
  options: Readonly<{ unboundedEvery: number; seed: number; designed?: boolean }>,
): AiStrategy {
  let decisionIndex = 0;

  return Object.freeze({
    chooseCommand(context: AiDecisionContext): GameCommand {
      decisionIndex += 1;
      const seed = (options.seed + decisionIndex * 7919) >>> 0;
      const legalActionCount = context.kind === "play" ? context.legalActions.length : 0;

      if (!isEnhanced(profile)) {
        const started = performance.now();
        const command = CASUAL_AI_STRATEGY.chooseCommand(context);
        recorder.commands?.push(JSON.stringify(command));
        recorder.push(Object.freeze({
          profile,
          kind: context.kind,
          elapsedMs: performance.now() - started,
          budgetMs: null,
          polls: 0,
          reachedDeadline: false,
          legalActionCount,
          rootLeaderDiffers: null,
          unbounded: null,
        }));
        return command;
      }

      const sink = { polls: 0, reached: false };
      const started = performance.now();
      const budgetMs = options.designed === true ? null : ENHANCED_AI_BUDGET_MS[profile];
      const outcome = decideEnhancedAi(
        Object.freeze({ requestId: decisionIndex, aiType: profile, context, seed }),
        instrumentedRuntime(
          budgetMs === null ? Number.POSITIVE_INFINITY : started + budgetMs,
          sink,
        ),
      );
      const elapsedMs = performance.now() - started;
      if (!outcome.ok) {
        throw new Error(`Enhanced ${profile} decision failed.`);
      }
      const command = outcome.command;
      recorder.commands?.push(JSON.stringify(command));

      let unbounded: UnboundedComparison | null = null;
      // Sample on the recorder's running count, not on this strategy's own
      // counter: a seat makes far fewer decisions per game than the sampling
      // interval, so a per-instance counter would sample almost never.
      if (budgetMs !== null && recorder.records.length % options.unboundedEvery === 0) {
        const unboundedSink = { polls: 0, reached: false };
        const unboundedStarted = performance.now();
        const unboundedOutcome = decideEnhancedAi(
          Object.freeze({ requestId: decisionIndex, aiType: profile, context, seed }),
          instrumentedRuntime(Number.POSITIVE_INFINITY, unboundedSink),
        );
        if (unboundedOutcome.ok) {
          unbounded = Object.freeze({
            polls: unboundedSink.polls,
            elapsedMs: performance.now() - unboundedStarted,
            agrees: commandsMatch(command, unboundedOutcome.command),
          });
        }
      }

      // Master's public contract is "the Expert shortlist plus a sampled shallow
      // rollout". Whether that rollout ever overturns the root leader is a
      // separate question from whether it has time to run, so measure it
      // directly: re-rank the same position with Expert alone.
      let rootLeaderDiffers: boolean | null = null;
      if (profile === "master" && context.kind === "play") {
        const leader = rankScoredPlayActions(context, "expert", { analyzerNodes: 220 })[0]?.action;
        if (leader !== undefined) {
          const leaderCommand: GameCommand = leader.type === "pass"
            ? Object.freeze({ type: "pass", seat: context.view.seat })
            : Object.freeze({
                type: "play",
                seat: context.view.seat,
                cards: Object.freeze([...leader.play.cards]),
              });
          rootLeaderDiffers = !commandsMatch(command, leaderCommand);
        }
      }

      recorder.push(Object.freeze({
        profile,
        kind: context.kind,
        elapsedMs,
        budgetMs,
        polls: sink.polls,
        reachedDeadline: sink.reached,
        legalActionCount,
        rootLeaderDiffers,
        unbounded,
      }));
      return command;
    },
  });
}

function commandsMatch(left: GameCommand, right: GameCommand): boolean {
  if (left.type !== right.type) {
    return false;
  }
  if (left.type === "pass" || right.type === "pass") {
    return true;
  }
  if (left.type !== "play" || right.type !== "play") {
    return false;
  }
  const leftCards = [...left.cards].sort();
  const rightCards = [...right.cards].sort();
  return leftCards.length === rightCards.length &&
    leftCards.every((card, index) => card === rightCards[index]);
}

/**
 * One strong seat per game, in two arms:
 *   Arm A — the strong level takes the landlord seat.
 *   Arm B — the strong level takes one farmer seat, rotating across deals so
 *           both farmer seats are covered.
 * The previous schedule played half its games with the strong level in two of
 * three seats, which the strong side wins almost regardless of level quality.
 */
export function armSchedule(
  dealIndex: number,
  gamesPerDeal = 3,
): ReadonlyArray<Readonly<{ landlord: Seat; strongSeat: Seat; arm: "A" | "B" }>> {
  const games: Array<Readonly<{ landlord: Seat; strongSeat: Seat; arm: "A" | "B" }>> = [];
  for (let game = 0; game < gamesPerDeal; game += 1) {
    const landlord = SEAT_ORDER[game % SEAT_ORDER.length];
    if (landlord === undefined) {
      continue;
    }
    games.push(Object.freeze({ landlord, strongSeat: landlord, arm: "A" as const }));
    const farmerOffset = 1 + (dealIndex % 2);
    const strongSeat = SEAT_ORDER[(game + farmerOffset) % SEAT_ORDER.length];
    if (strongSeat !== undefined && strongSeat !== landlord) {
      games.push(Object.freeze({ landlord, strongSeat, arm: "B" as const }));
    }
  }
  return Object.freeze(games);
}

export function startWithLandlord(deck: readonly CardId[], landlord: Seat): GameState {
  const dealt = transition(INITIAL_GAME_STATE, { type: "deal", deck });
  if (!dealt.ok || dealt.state.phase !== "bidding") {
    throw new Error("Benchmark deal failed.");
  }
  let state = dealt.state;
  for (const seat of SEAT_ORDER) {
    const bid = transition(state, {
      type: "bid",
      seat,
      decision: seat === landlord ? "call" : "decline",
    });
    if (!bid.ok) {
      throw new Error(`Benchmark bid failed: ${bid.error.code}`);
    }
    if (seat === landlord) {
      return bid.state;
    }
    if (bid.state.phase !== "bidding") {
      throw new Error("Benchmark bidding ended before its fixed landlord.");
    }
    state = bid.state;
  }
  throw new Error("Benchmark landlord was not selected.");
}

export type GameOutcome = Readonly<{ winner: Seat; commandCount: number }>;

export function playGame(
  deck: readonly CardId[],
  landlord: Seat,
  profiles: Readonly<Record<Seat, Profile>>,
  recorder: Recorder,
  options: Readonly<{ unboundedEvery: number; seed: number; designed?: boolean }>,
): GameOutcome {
  let state = startWithLandlord(deck, landlord);
  const shared = {
    unboundedEvery: options.unboundedEvery,
    designed: options.designed === true,
  };
  const strategies: Record<Seat, AiStrategy> = {
    human: createMeasuredStrategy(profiles.human, recorder, { ...shared, seed: options.seed + 1 }),
    "ai-one": createMeasuredStrategy(profiles["ai-one"], recorder, {
      ...shared,
      seed: options.seed + 2,
    }),
    "ai-two": createMeasuredStrategy(profiles["ai-two"], recorder, {
      ...shared,
      seed: options.seed + 3,
    }),
  };
  for (let commandCount = 0; commandCount < 256; commandCount += 1) {
    if (state.phase === "finished") {
      return Object.freeze({ winner: state.winner, commandCount });
    }
    if (state.phase !== "ready-to-play" && state.phase !== "playing") {
      throw new Error(`Unexpected benchmark phase: ${state.phase}`);
    }
    const seat = state.currentSeat;
    const view = createPlayerView(state, seat);
    if (view === null || view.phase === "bidding") {
      throw new Error("Benchmark expected a playing view.");
    }
    const context: AiDecisionContext = Object.freeze({
      kind: "play",
      view,
      legalActions: generateLegalActions({ hand: view.hand, currentPlay: view.currentPlay }),
    });
    const command = strategies[seat].chooseCommand(context);
    const result = transition(state, command);
    if (!result.ok) {
      throw new Error(`Illegal ${profiles[seat]} command: ${result.error.code}`);
    }
    state = result.state;
  }
  throw new Error("Benchmark game exceeded 256 commands.");
}

export function scheduleFor(
  stronger: Profile,
  weaker: Profile,
  strongSeat: Seat,
): Readonly<Record<Seat, Profile>> {
  const profiles: Record<Seat, Profile> = {
    human: weaker,
    "ai-one": weaker,
    "ai-two": weaker,
  };
  profiles[strongSeat] = stronger;
  return Object.freeze(profiles);
}

/**
 * The bid path never reads the clock — `decideEnhancedAi` handles `kind: "bid"`
 * before any deadline is consulted, so this is the one part of the turn that
 * has no budget guard at all. Measure it rather than assume it is cheap.
 */
export function measureBidDecisions(
  decks: readonly (readonly CardId[])[],
  recorder: Recorder,
  options: Readonly<{ unboundedEvery: number }>,
): void {
  for (let deckIndex = 0; deckIndex < decks.length; deckIndex += 1) {
    const deck = decks[deckIndex];
    if (deck === undefined) {
      continue;
    }
    const dealt = transition(INITIAL_GAME_STATE, { type: "deal", deck });
    if (!dealt.ok || dealt.state.phase !== "bidding") {
      continue;
    }
    for (let profileIndex = 0; profileIndex < PROFILES.length; profileIndex += 1) {
      const profile = PROFILES[profileIndex];
      if (profile === undefined) {
        continue;
      }
      const seat = dealt.state.currentSeat;
      const view = createPlayerView(dealt.state, seat);
      if (view === null || view.phase !== "bidding") {
        continue;
      }
      createMeasuredStrategy(profile, recorder, {
        unboundedEvery: options.unboundedEvery,
        seed: deckIndex * 31 + profileIndex,
      }).chooseCommand(Object.freeze({ kind: "bid", view }));
    }
  }
}

export function responseWindowMs(): number {
  return ENHANCED_AI_RESPONSE_WINDOW_MS;
}

/**
 * Worlds started by a master decision, derived from how often its budget was
 * checked. Structural assumption: one poll for the pre-flight check, one per
 * root-ranking candidate after the first, then one per world.
 * `assertPollStructure` guards it.
 */
export function masterWorldPolls(record: DecisionRecord): number | null {
  if (record.profile !== "master" || record.kind !== "play") {
    return null;
  }
  return record.polls - 1 - Math.max(0, record.legalActionCount - 1);
}

export type MasterRolloutSummary = Readonly<{
  /** Decisions whose pre-flight budget check expired before any world was built. */
  rolloutSkipped: number;
  /** Decisions whose root ranking was itself cut short. */
  rootTruncated: number;
  /** Sampled worlds that actually completed, over the decisions that built any. */
  completedWorlds: readonly number[];
  /** The shipped world cap, read from the decision path rather than assumed. */
  worldCap: number;
}>;

/**
 * How much of master's designed rollout the budget actually pays for.
 * `worldCap` is observed (the largest world count seen without a deadline), so
 * this reports the shipped cap rather than a number copied into the harness.
 */
export function summarizeMasterRollout(
  records: readonly DecisionRecord[],
  worldCap: number,
): MasterRolloutSummary {
  let rolloutSkipped = 0;
  let rootTruncated = 0;
  const completedWorlds: number[] = [];
  for (const record of records) {
    if (record.profile !== "master" || record.kind !== "play") {
      continue;
    }
    if (record.polls <= 1) {
      if (record.reachedDeadline) {
        // The pre-flight check expired: master answered from the Expert leader
        // without building a single world.
        rolloutSkipped += 1;
      } else {
        // No shortlist to roll out — the decision never entered the world loop.
        completedWorlds.push(0);
      }
      continue;
    }
    const rootPolls = Math.max(0, record.legalActionCount - 1);
    if (record.polls <= 1 + rootPolls) {
      rootTruncated += 1;
      continue;
    }
    const worldPolls = record.polls - 1 - rootPolls;
    completedWorlds.push(record.reachedDeadline ? worldPolls - 1 : worldPolls);
  }
  return Object.freeze({
    rolloutSkipped,
    rootTruncated,
    completedWorlds: Object.freeze(completedWorlds),
    worldCap,
  });
}

/** Largest world count observed on decisions that ran without a deadline. */
export function observedWorldCap(records: readonly DecisionRecord[]): number {
  let cap = 0;
  for (const record of records) {
    if (record.unbounded === null || record.profile !== "master" || record.kind !== "play") {
      continue;
    }
    const rootPolls = Math.max(0, record.legalActionCount - 1);
    cap = Math.max(cap, record.unbounded.polls - 1 - rootPolls);
  }
  return cap;
}

export function report(line: string): void {
  // Written straight to stdout so progress survives a hard kill; vitest's
  // console interception is also disabled for the same reason.
  process.stdout.write(`${line}\n`);
}

export type PairRun = Readonly<{
  stronger: Profile;
  weaker: Profile;
  requestedDeals: number;
  playedDeals: number;
  stoppedEarly: boolean;
  /** Wins out of 3 per deal, arm A (the strong level holds the landlord seat). */
  perDealA: readonly number[];
  /** Wins out of 3 per deal, arm B (the strong level holds one farmer seat). */
  perDealB: readonly number[];
  elapsedMs: number;
}>;

/**
 * Plays the deal-mirrored schedule for one adjacent pair. Every deal is played
 * six times: three with the strong level as landlord, three with it as one
 * farmer. Stops cleanly before starting a new deal once the soft wall-clock cap
 * is reached, so a truncated run still reports what it measured.
 */
export function runPairTournament(
  config: BenchmarkConfig,
  stronger: Profile,
  weaker: Profile,
  recorder: Recorder,
  options: Readonly<{ maxDeals?: number; quiet?: boolean }> = {},
): PairRun {
  const maxDeals = options.maxDeals ?? config.deals;
  const started = performance.now();
  const perDealA: number[] = [];
  const perDealB: number[] = [];
  let playedDeals = 0;
  let stoppedEarly = false;
  let winsA = 0;
  let winsB = 0;

  for (let dealIndex = 0; dealIndex < maxDeals; dealIndex += 1) {
    if ((performance.now() - started) / 1000 >= config.secondsCap) {
      stoppedEarly = true;
      break;
    }
    const dealSeed = config.seedBase + dealIndex;
    const deck = dealDeck(dealSeed);
    let dealWinsA = 0;
    let dealWinsB = 0;
    for (const slot of armSchedule(dealIndex)) {
      const profiles = scheduleFor(stronger, weaker, slot.strongSeat);
      const outcome = playGame(deck, slot.landlord, profiles, recorder, {
        unboundedEvery: config.unboundedEvery,
        seed: dealSeed * 100 + SEAT_ORDER.indexOf(slot.strongSeat) * 10 + SEAT_ORDER.indexOf(slot.landlord),
      });
      const strongIsLandlord = slot.strongSeat === slot.landlord;
      const strongerWon = strongIsLandlord
        ? outcome.winner === slot.landlord
        : outcome.winner !== slot.landlord;
      if (strongerWon) {
        if (slot.arm === "A") {
          dealWinsA += 1;
          winsA += 1;
        } else {
          dealWinsB += 1;
          winsB += 1;
        }
      }
    }
    perDealA.push(dealWinsA);
    perDealB.push(dealWinsB);
    playedDeals += 1;
    if (!options.quiet) {
      const games = playedDeals * 6;
      const wins = winsA + winsB;
      report(
        `[${stronger} vs ${weaker}] deal ${playedDeals}/${maxDeals} ` +
        `wins ${wins}/${games} (${((wins / games) * 100).toFixed(1)}%) ` +
        `elapsed ${((performance.now() - started) / 1000).toFixed(0)}s`,
      );
    }
  }

  return Object.freeze({
    stronger,
    weaker,
    requestedDeals: maxDeals,
    playedDeals,
    stoppedEarly,
    perDealA: Object.freeze(perDealA),
    perDealB: Object.freeze(perDealB),
    elapsedMs: performance.now() - started,
  });
}
