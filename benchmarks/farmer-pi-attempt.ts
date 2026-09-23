/**
 * Farmer Policy Iteration Factory v1 — the attempt state machine.
 *
 * Two words the Factory keeps strictly apart, because collapsing them is how a
 * pipeline starts lying about what it has proved:
 *
 *   - a **generation** is a champion. It advances only on a formal PROMOTE, and
 *     the chain it names is one layer deeper than the champion it came from.
 *   - an **attempt** is one candidate-training run. Most attempts fail, and a
 *     failed attempt is never called a generation — `π2 attempt-004 FAIL` is
 *     not `π3`.
 *
 * This module is a pure function of the attempt's recorded state. It reads no
 * clock, no file and no random source, so a guard can drive every transition,
 * including the ones that only happen after a rejection, without dealing a
 * single card.
 *
 * ## The order is the experiment
 *
 * The steps below run in a fixed order, and the two that matter most are the
 * ones that produce *knowledge* rather than work:
 *
 *   - `stage1` runs before `plan-formal`, and `plan-formal` is the only place
 *     the formal sample size comes from. Choosing N after seeing the formal
 *     outcomes would be a second look at the same data wearing a planning hat.
 *   - `offline` gates `stage1`, and `stage1` gates `formal`. Each stage is
 *     strictly cheaper than the one it admits, so a hopeless candidate costs
 *     minutes rather than hours.
 */
import type { FactoryProtocol } from "./farmer-pi-protocol.js";

/** The five ways the Factory stops, plus the one that just pauses it. */
export type StopReason =
  | "DOUBLE_REJECT"
  | "ATTEMPT_LIMIT"
  | "INTEGRITY_STOP"
  | "RESOURCE_STOP"
  | "MANUAL_STOP"
  | "PAUSED_DEADLINE";

export type AttemptKind = "base" | "retry";

export type AttemptPhase =
  | "PLANNED"
  | "CORPUS"
  | "TRAIN"
  | "CALIBRATE"
  | "OFFLINE"
  | "STAGE1"
  | "FORMAL_PLAN"
  | "FORMAL"
  | "DECIDED";

export type AttemptPhaseOutcome = "PROMOTE" | "REJECT";

export type AttemptRecord = Readonly<{
  attemptId: string;
  attemptNumber: number;
  kind: AttemptKind;
  parentChampionId: string;
  /** The protocol hash this attempt registered under. */
  protocolHash: string;
  /** Pool id and range, by purpose. Resolved from the ledger at registration. */
  pools: Readonly<Record<string, Readonly<{ poolId: string; start: number; end: number }>>>;
  phase: AttemptPhase;
  /** Corpus purposes finished, in order. */
  corpusDone: readonly string[];
  /** Calibration's frozen threshold, once chosen. */
  threshold: number | null;
  stage1: Readonly<{ deals: number; mean: number; variance: number; proceed: boolean }> | null;
  formalPlan: Readonly<{ required: number; n: number; powerCapped: boolean }> | null;
  /** The N the formal stage actually ran, fixed before any formal outcome. */
  formalN: number | null;
  /** Reason the attempt stopped short, if it did. */
  stopReason: StopReason | null;
  outcome: AttemptPhaseOutcome | null;
  startedAt: string;
  updatedAt: string;
}>;

/** What the runner should do next. Every branch is a decision, not a suggestion. */
export type AttemptStep =
  | Readonly<{ kind: "corpus"; purpose: string }>
  | Readonly<{ kind: "train" }>
  | Readonly<{ kind: "calibrate" }>
  | Readonly<{ kind: "offline" }>
  | Readonly<{ kind: "stage1" }>
  | Readonly<{ kind: "plan-formal" }>
  | Readonly<{ kind: "formal"; n: number }>
  | Readonly<{ kind: "decide" }>
  | Readonly<{ kind: "stop"; reason: StopReason }>
  | Readonly<{ kind: "done"; outcome: AttemptPhaseOutcome }>;

/**
 * The corpus purposes an attempt generates, in order.
 *
 * A retry generates a *fresh* half of its training data under a name of its
 * own — `train-fresh` — so that the six thousand groups it inherited from the
 * rejected base attempt can never be confused with the six thousand it
 * generated itself. They are different distributions of the same champion, and
 * the archive records which is which.
 */
export function corpusPurposes(kind: AttemptKind): readonly string[] {
  return Object.freeze(kind === "base"
    ? ["train", "calibration", "offline"]
    : ["train-fresh", "calibration", "offline"]);
}

export function nextCorpusPurpose(attempt: AttemptRecord): string | null {
  for (const purpose of corpusPurposes(attempt.kind)) {
    if (!attempt.corpusDone.includes(purpose)) {
      return purpose;
    }
  }
  return null;
}

/**
 * The deals the protocol says a purpose's pool holds.
 *
 * Checked against the ledger's allocated range rather than trusted: a pool
 * whose size drifted from the protocol is a configuration error, and finding it
 * at registration costs a second where finding it after a stage costs the
 * stage.
 */
export function protocolDealsForPurpose(
  purpose: string,
  kind: AttemptKind,
  protocol: FactoryProtocol,
): number {
  const entry = protocol.attempt;
  switch (purpose) {
    case "train": return entry.trainDeals;
    case "train-fresh": return kind === "retry" ? entry.retryTrainFreshDeals : entry.trainDeals;
    case "calibration":
      return kind === "retry" ? entry.retryCalibrationDeals : entry.calibrationDeals;
    case "offline": return kind === "retry" ? entry.retryOfflineDeals : entry.offlineDeals;
    case "stage1": return entry.stage1Deals;
    case "formal": return entry.formalReserveDeals;
    default:
      throw new Error(`Unknown corpus purpose "${purpose}".`);
  }
}

/**
 * The next step.
 *
 * The rejection paths are the interesting ones. An attempt whose calibration
 * found no threshold above zero is `SCREEN_REJECT` and goes straight to
 * `decide` — it never reaches the offline screen, never mind Stage 1. An
 * attempt whose offline screen fails likewise never reaches Stage 1. And Stage
 * 1's `farmer Δ <= 0` is a REJECT by the preregistered rule, not a step that
 * gets another try.
 */
export function nextAttemptStep(
  attempt: AttemptRecord,
  protocol: FactoryProtocol,
): AttemptStep {
  if (attempt.stopReason !== null) {
    return Object.freeze({ kind: "stop", reason: attempt.stopReason });
  }
  if (attempt.outcome !== null) {
    return Object.freeze({ kind: "done", outcome: attempt.outcome });
  }
  for (const [purpose, pool] of Object.entries(attempt.pools)) {
    const expected = protocolDealsForPurpose(purpose, attempt.kind, protocol);
    const actual = pool.end - pool.start + 1;
    if (actual !== expected) {
      throw new Error(
        `${attempt.attemptId}'s ${purpose} pool holds ${actual} deals; the protocol says ${expected}.`,
      );
    }
  }
  switch (attempt.phase) {
    case "PLANNED":
    case "CORPUS": {
      const purpose = nextCorpusPurpose(attempt);
      if (purpose !== null) {
        return Object.freeze({ kind: "corpus", purpose });
      }
      return Object.freeze({ kind: "train" });
    }
    case "TRAIN":
      return Object.freeze({ kind: "calibrate" });
    case "CALIBRATE": {
      // No threshold cleared the support floors and the lower bound. The
      // preregistered answer is SCREEN_REJECT, and it is decided here rather
      // than by the runner remembering to check.
      if (attempt.threshold === null) {
        return Object.freeze({ kind: "decide" });
      }
      return Object.freeze({ kind: "offline" });
    }
    case "OFFLINE":
      return Object.freeze({ kind: "stage1" });
    case "STAGE1": {
      if (attempt.stage1 === null || !attempt.stage1.proceed) {
        return Object.freeze({ kind: "decide" });
      }
      return Object.freeze({ kind: "plan-formal" });
    }
    case "FORMAL_PLAN": {
      if (attempt.formalPlan === null || attempt.formalN === null) {
        throw new Error(`${attempt.attemptId} is at FORMAL_PLAN with no plan or no N.`);
      }
      return Object.freeze({ kind: "formal", n: attempt.formalN });
    }
    case "FORMAL":
      return Object.freeze({ kind: "decide" });
    case "DECIDED":
      throw new Error(`${attempt.attemptId} is DECIDED but has no outcome.`);
  }
}

/** The phase an attempt moves to after finishing `step`. */
export function phaseAfter(step: AttemptStep): AttemptPhase {
  switch (step.kind) {
    case "corpus": return "CORPUS";
    case "train": return "TRAIN";
    case "calibrate": return "CALIBRATE";
    case "offline": return "OFFLINE";
    case "stage1": return "STAGE1";
    case "plan-formal": return "FORMAL_PLAN";
    case "formal": return "FORMAL";
    case "decide": return "DECIDED";
    case "stop": return "DECIDED";
    case "done": return "DECIDED";
  }
}

// ---------------------------------------------------------------------------
// The Factory's own ledger of attempts
// ---------------------------------------------------------------------------

export type AttemptSummary = Readonly<{
  attemptId: string;
  kind: AttemptKind;
  parentChampionId: string;
  outcome: AttemptPhaseOutcome | null;
  stopReason: StopReason | null;
}>;

export type FactoryState = Readonly<{
  /** `ai-v1` at the start; the current research champion after a promotion. */
  championId: string;
  /** 1 for the starting champion. +1 per PROMOTE, never per attempt. */
  generation: number;
  attempts: readonly AttemptSummary[];
  startedAt: string;
  updatedAt: string;
}>;

export function attemptsUsed(factory: FactoryState): number {
  return factory.attempts.length;
}

/**
 * Whether the Factory may start another attempt, and of which kind.
 *
 * A retry is offered only to a champion whose *base* attempt was rejected and
 * which has not already spent its one retry. That is the whole of §22: the
 * retry is not a second opinion on a different candidate, it is the same
 * candidate with more data.
 */
export function nextAttemptKind(
  factory: FactoryState,
  protocol: FactoryProtocol,
): AttemptKind | null {
  if (factoryStopReason(factory, protocol) !== null) {
    return null;
  }
  const forChampion = factory.attempts.filter(
    (attempt) => attempt.parentChampionId === factory.championId,
  );
  const retries = forChampion.filter((attempt) => attempt.kind === "retry");
  const base = forChampion.find((attempt) => attempt.kind === "base");
  if (base !== undefined && base.outcome === "REJECT" && retries.length < protocol.retryPerChampion) {
    return "retry";
  }
  return "base";
}

/**
 * Why the Factory has stopped, or `null` while it may continue.
 *
 * Checked in the order the outcomes would arrive, and the attempt cap is
 * checked first because §41 says reaching it stops the Factory *regardless* of
 * what the tenth attempt found — including a promotion, which is saved and then
 * not followed by an eleventh.
 */
export function factoryStopReason(
  factory: FactoryState,
  protocol: FactoryProtocol,
): StopReason | null {
  const stopped = factory.attempts.find((attempt) => attempt.stopReason !== null);
  if (stopped !== undefined) {
    return stopped.stopReason;
  }
  if (attemptsUsed(factory) >= protocol.attemptCap) {
    return "ATTEMPT_LIMIT";
  }
  const forChampion = factory.attempts.filter(
    (attempt) => attempt.parentChampionId === factory.championId,
  );
  const retries = forChampion.filter((attempt) => attempt.kind === "retry");
  const base = forChampion.find((attempt) => attempt.kind === "base");
  // Two failures on one champion, and the direction is closed. This is reached
  // only once the allowed retry has itself been rejected, so a base rejection
  // on its own is not a stop.
  if (
    base !== undefined && base.outcome === "REJECT" &&
    retries.length >= protocol.retryPerChampion &&
    retries.every((attempt) => attempt.outcome === "REJECT")
  ) {
    return "DOUBLE_REJECT";
  }
  return null;
}

/**
 * Applies a decision to the Factory: a promotion advances the generation and
 * changes the champion, a rejection does neither.
 *
 * Note what a rejection does *not* do: it does not create a generation, does
 * not renumber anything, and does not enter the champion archive.
 */
export function applyOutcome(
  factory: FactoryState,
  attempt: AttemptSummary,
  generation: number,
  at: string,
): FactoryState {
  const attempts = Object.freeze([...factory.attempts, attempt]);
  if (attempt.outcome !== "PROMOTE") {
    return Object.freeze({ ...factory, attempts, updatedAt: at });
  }
  return Object.freeze({
    ...factory,
    attempts,
    championId: researchChampionFor(generation + 1),
    generation: generation + 1,
    updatedAt: at,
  });
}

export function researchChampionFor(generation: number): string {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error(`Generations start at 1; received ${generation}.`);
  }
  return generation === 1 ? "ai-v1" : `ai-v${generation}-research`;
}
