/**
 * Gate A v1 selector semantics and the statistics that decide on a threshold.
 *
 * This lives in the repository, and is unit-tested, for one reason: the spec
 * freezes the selector and the evaluation rules, and "the script we ran" is not
 * a frozen artifact. Python fits the model and predicts scores; every decision
 * after that — which candidate wins, when to override, how a group's outcome is
 * reduced to one number, what a threshold's lower bound is, and which of
 * PASS/FAIL/INCONCLUSIVE/NO-GO applies — happens here.
 *
 * Nothing in this file reads a file, calls a clock or knows what a shard is.
 */
import type { CfLabel, CfSnapshot } from "./cf-dataset.js";

/** The six finite thresholds the spec permits, plus `Infinity` for never-override. */
export const CF_THRESHOLD_GRID: readonly number[] = Object.freeze([0, 0.01, 0.02, 0.04, 0.08, 0.16]);
export const CF_NEVER_OVERRIDE = Number.POSITIVE_INFINITY;

/** Minimum engineering effect, Gate A v1. */
export const CF_MU_MIN = 0.005;
/** Supporting-deal floors (spec §20). */
export const CF_MIN_OVERRIDE_DEALS = 200;
export const CF_MIN_SELECTED_NONZERO_DEALS = 50;
/** Six finite thresholds share one alpha; the reserve test gets the other half. */
export const CF_CALIBRATION_FAMILIES = CF_THRESHOLD_GRID.length;
export const CF_CALIBRATION_ALPHA = 0.05;
/** Two-sided 97.5% interval, because at most two formal tests may be run. */
export const CF_HELDOUT_TAIL = 0.9875;

export type CfScoredCandidate = Readonly<{
  /** The production candidate order — the frozen tie-break. */
  candidateOrder: number;
  /** Model output for `f(o, a, a0)`. */
  score: number;
  /** The candidate's true counterfactual label. */
  label: CfLabel;
}>;

export type CfScoredRoot = Readonly<{
  snapshotId: string;
  groupId: string;
  candidates: readonly CfScoredCandidate[];
}>;

export type CfOverrideChoice = Readonly<{
  snapshotId: string;
  groupId: string;
  /** Whether the selector left the production action alone. */
  overrode: boolean;
  /** The chosen candidate's label, or 0 when the production action was kept. */
  z: CfLabel;
  /** The winning score, before the threshold comparison. */
  winningScore: number | null;
}>;

/**
 * One root's decision.
 *
 * `a* = argmax score`, ties broken by the frozen production candidate order.
 * `root.candidates` is required to arrive in that order (which is what
 * `cfScoredRootFromSnapshot` produces), so the first strict maximum is the
 * lowest candidate order and no sort is needed. The override is a **strict** `>`.
 */
export function cfChooseOverride(
  root: CfScoredRoot,
  threshold: number,
): CfOverrideChoice {
  let best: CfScoredCandidate | null = null;
  for (const candidate of root.candidates) {
    if (best === null || candidate.score > best.score) {
      best = candidate;
    }
  }
  if (best === null) {
    throw new Error(`Scored root ${root.snapshotId} has no candidates.`);
  }
  const overrode = best.score > threshold;
  return Object.freeze({
    snapshotId: root.snapshotId,
    groupId: root.groupId,
    overrode,
    z: overrode ? best.label : 0,
    winningScore: best.score,
  });
}

export type CfThresholdOutcome = Readonly<{
  threshold: number;
  /** One entry per registered group, in group order. Groups with no roots score 0. */
  perGroup: readonly number[];
  groups: number;
  /** Distinct initial deal groups where an override fired at all. */
  overrideDeals: number;
  /** Distinct deals where the *selected* override carried a non-zero label. */
  selectedNonzeroDeals: number;
  /** Overrides / sampled roots. */
  coverage: number;
  overrides: number;
  goodOverrides: number;
  badOverrides: number;
  /** (good − bad) / overrides, conditional on an override having happened. */
  conditional: number;
  mean: number;
  sd: number;
  se: number;
  /** One-sided conservative lower bound with the Bonferroni family correction. */
  lower: number;
}>;

/**
 * Reduces one threshold's choices to the group-level primary.
 *
 * Every registered group is in the denominator, including groups with no useful
 * root: dropping them would silently condition the estimate on the group having
 * had a choice, which is exactly the selection effect the group-level reduction
 * exists to avoid.
 */
export function cfThresholdOutcome(
  choices: readonly CfOverrideChoice[],
  registeredGroupIds: readonly string[],
  rootCounts: ReadonlyMap<string, number>,
  threshold: number,
  tQuantile: (probability: number, degreesOfFreedom: number) => number,
): CfThresholdOutcome {
  const byGroup = new Map<string, number[]>();
  const overrideGroups = new Set<string>();
  const nonzeroDeals = new Set<string>();
  let overrides = 0;
  let good = 0;
  let bad = 0;
  for (const choice of choices) {
    const list = byGroup.get(choice.groupId) ?? [];
    list.push(choice.z);
    byGroup.set(choice.groupId, list);
    if (choice.overrode) {
      overrides += 1;
      overrideGroups.add(choice.groupId);
      if (choice.z > 0) {
        good += 1;
        nonzeroDeals.add(choice.groupId);
      } else if (choice.z < 0) {
        bad += 1;
        nonzeroDeals.add(choice.groupId);
      }
    }
  }

  const perGroup = registeredGroupIds.map((groupId) => {
    const values = byGroup.get(groupId);
    if (values === undefined || values.length === 0) {
      return 0;
    }
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  });

  const n = perGroup.length;
  const mean = n === 0 ? 0 : perGroup.reduce((sum, value) => sum + value, 0) / n;
  const variance = n < 2
    ? 0
    : perGroup.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  const se = n === 0 ? 0 : sd / Math.sqrt(n);
  const degreesOfFreedom = Math.max(1, n - 1);
  const quantile = tQuantile(1 - CF_CALIBRATION_ALPHA / CF_CALIBRATION_FAMILIES, degreesOfFreedom);

  let roots = 0;
  for (const count of rootCounts.values()) {
    roots += count;
  }

  return Object.freeze({
    threshold,
    perGroup: Object.freeze(perGroup),
    groups: n,
    overrideDeals: overrideGroups.size,
    selectedNonzeroDeals: nonzeroDeals.size,
    coverage: roots === 0 ? 0 : overrides / roots,
    overrides,
    goodOverrides: good,
    badOverrides: bad,
    conditional: overrides === 0 ? 0 : (good - bad) / overrides,
    mean,
    sd,
    se,
    lower: mean - quantile * se,
  });
}

export type CfThresholdDecision = Readonly<{
  selected: number;
  reason: "selected" | "calibration-no-go";
  eligible: readonly number[];
  outcomes: readonly CfThresholdOutcome[];
}>;

/**
 * The frozen selection rule: among thresholds that clear both support floors,
 * take the largest conservative lower bound; an exact tie goes to the larger
 * threshold; and if the best lower bound is not above zero there is no
 * threshold at all and the phase stops here.
 */
export function cfSelectThreshold(
  outcomes: readonly CfThresholdOutcome[],
): CfThresholdDecision {
  const eligible = outcomes.filter((outcome) =>
    outcome.overrideDeals >= CF_MIN_OVERRIDE_DEALS &&
    outcome.selectedNonzeroDeals >= CF_MIN_SELECTED_NONZERO_DEALS);
  if (eligible.length === 0) {
    return Object.freeze({
      selected: CF_NEVER_OVERRIDE,
      reason: "calibration-no-go",
      eligible: Object.freeze([]),
      outcomes,
    });
  }
  let best = eligible[0];
  if (best === undefined) {
    throw new Error("unreachable");
  }
  for (const outcome of eligible) {
    if (outcome.lower > best.lower ||
      (outcome.lower === best.lower && outcome.threshold > best.threshold)) {
      best = outcome;
    }
  }
  if (!(best.lower > 0)) {
    return Object.freeze({
      selected: CF_NEVER_OVERRIDE,
      reason: "calibration-no-go",
      eligible: Object.freeze(eligible.map((outcome) => outcome.threshold)),
      outcomes,
    });
  }
  return Object.freeze({
    selected: best.threshold,
    reason: "selected",
    eligible: Object.freeze(eligible.map((outcome) => outcome.threshold)),
    outcomes,
  });
}

export type CfGateStatus = "pass" | "fail" | "inconclusive";

export type CfGateVerdict = Readonly<{
  status: CfGateStatus;
  mean: number;
  lower: number;
  upper: number;
  overrideDeals: number;
  selectedNonzeroDeals: number;
  integrityValid: boolean;
  reasons: readonly string[];
}>;

/**
 * The held-out rule, written now and run later. Kept here — not in a notebook —
 * so that the thing being frozen at calibration time is the same code that will
 * be run against the sealed split.
 */
export function cfHeldoutVerdict(
  perGroup: readonly number[],
  overrideDeals: number,
  selectedNonzeroDeals: number,
  integrityValid: boolean,
  tQuantile: (probability: number, degreesOfFreedom: number) => number,
): CfGateVerdict {
  const n = perGroup.length;
  const mean = n === 0 ? 0 : perGroup.reduce((sum, value) => sum + value, 0) / n;
  const variance = n < 2
    ? 0
    : perGroup.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1);
  const se = n === 0 ? 0 : Math.sqrt(variance) / Math.sqrt(n);
  const quantile = tQuantile(CF_HELDOUT_TAIL, Math.max(1, n - 1));
  const lower = mean - quantile * se;
  const upper = mean + quantile * se;

  const reasons: string[] = [];
  if (!integrityValid) {
    reasons.push("integrity gate failed");
  }
  if (mean < CF_MU_MIN) {
    reasons.push(`mu_hat ${mean.toFixed(5)} < ${CF_MU_MIN}`);
  }
  if (!(lower > 0)) {
    reasons.push(`lower bound ${lower.toFixed(5)} is not above 0`);
  }
  if (overrideDeals < CF_MIN_OVERRIDE_DEALS) {
    reasons.push(`override deals ${overrideDeals} < ${CF_MIN_OVERRIDE_DEALS}`);
  }
  if (selectedNonzeroDeals < CF_MIN_SELECTED_NONZERO_DEALS) {
    reasons.push(`selected nonzero deals ${selectedNonzeroDeals} < ${CF_MIN_SELECTED_NONZERO_DEALS}`);
  }

  const status: CfGateStatus = reasons.length === 0
    ? "pass"
    : upper < CF_MU_MIN
      ? "fail"
      : "inconclusive";
  return Object.freeze({
    status,
    mean,
    lower,
    upper,
    overrideDeals,
    selectedNonzeroDeals,
    integrityValid,
    reasons: Object.freeze(reasons),
  });
}

/**
 * The training rows a scored root must cover: every non-a0 candidate, in the
 * frozen production candidate order, which is also the tie-break order.
 */
export function cfScoredRootFromSnapshot(
  snapshot: CfSnapshot,
  scoreOf: (snapshotId: string, candidateOrder: number) => number,
): CfScoredRoot {
  const candidates = snapshot.candidates.flatMap((_candidate, index) => {
    if (index === snapshot.productionIndex) {
      return [];
    }
    const label = snapshot.labels[index];
    if (label === undefined) {
      throw new Error(`Snapshot ${snapshot.meta.snapshotId} is missing a label.`);
    }
    return [Object.freeze({
      candidateOrder: index,
      score: scoreOf(snapshot.meta.snapshotId, index),
      label,
    })];
  });
  return Object.freeze({
    snapshotId: snapshot.meta.snapshotId,
    groupId: snapshot.meta.groupId,
    candidates: Object.freeze(candidates),
  });
}

/** Stable row identity, used to join a score back to the row that produced it. */
export function cfRowId(snapshotId: string, candidateOrder: number): string {
  return `${snapshotId}#${candidateOrder}`;
}
