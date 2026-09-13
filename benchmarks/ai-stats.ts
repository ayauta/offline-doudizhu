/**
 * Statistics for the AI strength benchmark.
 *
 * Every function is total: the benchmark must still print a report when a run
 * stops early, so empty and single-element inputs return defined values instead
 * of throwing. Nothing here imports from `src/`.
 *
 * The unit of randomness in a deal-mirrored tournament is the DEAL, not the
 * game: within one deal every game is deterministic once the profiles and seeds
 * are fixed, so games inside a deal are a cluster. Confidence intervals are
 * therefore computed by resampling deals, not games.
 */

export type LatencySummary = Readonly<{
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}>;

export type PairSummary = Readonly<{
  deals: number;
  games: number;
  wins: number;
  rate: number;
  sd: number;
  ciLow: number;
  ciHigh: number;
  ciTLow: number;
  ciTHigh: number;
  requiredDeals: Readonly<Record<"0.05" | "0.10" | "0.15", number>>;
}>;

/** Lower-interpolated quantile, so p100 is the maximum and p0 the minimum. */
export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const clamped = Math.min(1, Math.max(0, fraction));
  const position = clamped * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] ?? 0;
  const high = sorted[upper] ?? low;
  if (lower === upper) {
    return low;
  }
  return low + (high - low) * (position - lower);
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total / values.length;
}

/** Sample standard deviation (n − 1). Zero for fewer than two values. */
export function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const average = mean(values);
  let sumSquares = 0;
  for (const value of values) {
    const deviation = value - average;
    sumSquares += deviation * deviation;
  }
  return Math.sqrt(sumSquares / (values.length - 1));
}

export function summarizeLatency(values: readonly number[]): LatencySummary {
  return Object.freeze({
    count: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: values.length === 0 ? 0 : Math.max(...values),
  });
}

/**
 * Wilson score interval — correct for proportions near 0 or 1, where the normal
 * approximation is not. Used for truncation rates, which are expected to be low.
 */
export function wilsonInterval(
  successes: number,
  trials: number,
  z = 1.96,
): Readonly<{ low: number; high: number }> {
  if (trials <= 0) {
    return Object.freeze({ low: 0, high: 0 });
  }
  const proportion = successes / trials;
  const zSquared = z * z;
  const denominator = 1 + zSquared / trials;
  const centre = proportion + zSquared / (2 * trials);
  const spread = z * Math.sqrt((proportion * (1 - proportion) + zSquared / (4 * trials)) / trials);
  return Object.freeze({
    low: Math.max(0, (centre - spread) / denominator),
    high: Math.min(1, (centre + spread) / denominator),
  });
}

/** Table of two-sided 95% Student-t quantiles, interpolated by degrees of freedom. */
const T95: ReadonlyArray<readonly [number, number]> = [
  [1, 12.706], [2, 4.303], [3, 3.182], [4, 2.776], [5, 2.571], [6, 2.447],
  [7, 2.365], [8, 2.306], [9, 2.262], [10, 2.228], [12, 2.179], [15, 2.131],
  [20, 2.086], [30, 2.042], [60, 2.0], [120, 1.98], [10000, 1.96],
];

export function t95(degreesOfFreedom: number): number {
  if (degreesOfFreedom < 1) {
    return T95[0]?.[1] ?? 1.96;
  }
  for (let index = 1; index < T95.length; index += 1) {
    const previous = T95[index - 1];
    const current = T95[index];
    if (previous === undefined || current === undefined) {
      break;
    }
    if (degreesOfFreedom <= current[0]) {
      const span = current[0] - previous[0];
      const position = (degreesOfFreedom - previous[0]) / span;
      return previous[1] + (current[1] - previous[1]) * position;
    }
  }
  return 1.96;
}

/** Normal-theory interval over per-deal rates; the bootstrap cross-check. */
export function tInterval(
  values: readonly number[],
): Readonly<{ low: number; high: number }> {
  if (values.length < 2) {
    const only = values[0] ?? 0;
    return Object.freeze({ low: only, high: only });
  }
  const halfWidth = t95(values.length - 1) * (standardDeviation(values) / Math.sqrt(values.length));
  const average = mean(values);
  return Object.freeze({ low: average - halfWidth, high: average + halfWidth });
}

/** Deterministic LCG, matching the seeding style used elsewhere in this repo. */
function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

/**
 * Percentile bootstrap over per-deal rates. Resampling deals (not games)
 * preserves the within-deal correlation that mirroring creates.
 */
export function clusterInterval(
  perDeal: readonly number[],
  options: Readonly<{ resamples?: number; seed?: number }> = {},
): Readonly<{ low: number; high: number }> {
  const resamples = options.resamples ?? 10_000;
  if (perDeal.length === 0) {
    return Object.freeze({ low: 0, high: 0 });
  }
  if (perDeal.length === 1) {
    const only = perDeal[0] ?? 0;
    return Object.freeze({ low: only, high: only });
  }
  const random = seededRandom(options.seed ?? 20_260_912);
  const averages = new Array<number>(resamples);
  for (let resample = 0; resample < resamples; resample += 1) {
    let total = 0;
    for (let draw = 0; draw < perDeal.length; draw += 1) {
      total += perDeal[Math.floor(random() * perDeal.length)] ?? 0;
    }
    averages[resample] = total / perDeal.length;
  }
  return Object.freeze({
    low: percentile(averages, 0.025),
    high: percentile(averages, 0.975),
  });
}

/**
 * Deals needed to detect `delta` in a pair's win rate, at 95% confidence and
 * 80% power, using the per-deal standard deviation. The 1.2 factor absorbs the
 * t-quantile and the non-normality of a bounded per-deal rate.
 */
export function requiredDeals(perDealSd: number, delta: number): number {
  if (delta <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  const zSum = (1.96 + 0.8416) ** 2;
  return Math.ceil((1.2 * zSum * (perDealSd / delta) ** 2) || 0);
}

/**
 * Summarize one adjacent-pair comparison from per-deal win counts.
 * `perDealWins[i]` is how many of `gamesPerDeal` games the stronger tier won.
 */
export function summarizePair(
  perDealWins: readonly number[],
  gamesPerDeal: number,
  seed = 20_260_912,
): PairSummary {
  const perDeal = perDealWins.map((wins) => (gamesPerDeal > 0 ? wins / gamesPerDeal : 0));
  const games = perDealWins.length * gamesPerDeal;
  let wins = 0;
  for (const value of perDealWins) {
    wins += value;
  }
  const sd = standardDeviation(perDeal);
  const ci = clusterInterval(perDeal, { seed });
  const ciT = tInterval(perDeal);
  return Object.freeze({
    deals: perDealWins.length,
    games,
    wins,
    rate: games > 0 ? wins / games : 0,
    sd,
    ciLow: ci.low,
    ciHigh: ci.high,
    ciTLow: ciT.low,
    ciTHigh: ciT.high,
    requiredDeals: Object.freeze({
      "0.05": requiredDeals(sd, 0.05),
      "0.10": requiredDeals(sd, 0.1),
      "0.15": requiredDeals(sd, 0.15),
    }),
  });
}

/**
 * Minimum sample for a quantile to be reported at all: below this the tail is
 * extrapolation rather than measurement, so the caller prints `n/a`.
 */
export function quantileIsReportable(count: number, fraction: number): boolean {
  return count * (1 - fraction) >= 10;
}

export function formatPercent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatMs(value: number, digits = 2): string {
  return `${value.toFixed(digits)}ms`;
}
