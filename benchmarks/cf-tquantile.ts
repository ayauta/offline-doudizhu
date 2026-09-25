/**
 * Student-t quantiles, implemented here so the Gate A evaluation depends on no
 * external statistics library.
 *
 * The alternative was to import scipy. That would put a second language's
 * package into the frozen path of a preregistered decision, and the whole point
 * of freezing a rule is that the artifact that decides can be re-run and read
 * by anyone with the repository. The numbers are checked against published
 * critical values and against scipy once, in the tests.
 *
 * Method: the t CDF is expressed through the regularized incomplete beta, and
 * the quantile is found by bisection on a monotone function. Slow and obvious
 * beats fast and clever for something that runs a handful of times.
 */

function logGamma(value: number): number {
  // Lanczos approximation, g = 7, n = 9.
  const coefficients = [
    0.999_999_999_999_809_93,
    676.520_368_121_885_1,
    -1_259.139_216_722_402_8,
    771.323_428_777_653_1,
    -176.615_029_162_140_6,
    12.507_343_278_686_905,
    -0.138_571_095_265_720_12,
    9.984_369_578_019_572e-6,
    1.505_632_735_149_311_6e-7,
  ];
  if (value < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * value)) - logGamma(1 - value);
  }
  const shifted = value - 1;
  let series = coefficients[0] ?? 0;
  for (let index = 1; index < coefficients.length; index += 1) {
    series += (coefficients[index] ?? 0) / (shifted + index);
  }
  const t = shifted + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(series);
}

/** Continued fraction for the incomplete beta (Numerical Recipes, Lentz). */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const tiny = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < tiny) {
    d = tiny;
  }
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 500; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) {
      d = tiny;
    }
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) {
      c = tiny;
    }
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) {
      d = tiny;
    }
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) {
      c = tiny;
    }
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-15) {
      break;
    }
  }
  return h;
}

/** The regularized incomplete beta I_x(a, b). */
export function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) {
    return 0;
  }
  if (x >= 1) {
    return 1;
  }
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(a, b, x)) / a
    : 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** P(T <= t) for a Student-t with `df` degrees of freedom. */
export function tCdf(t: number, df: number): number {
  if (t === 0) {
    return 0.5;
  }
  const x = df / (df + t * t);
  const tail = 0.5 * incompleteBeta(df / 2, 0.5, x);
  return t > 0 ? 1 - tail : tail;
}

/**
 * The t quantile: the `probability` point of a Student-t with `df` degrees of
 * freedom. Bisection between -1e6 and 1e6, 200 iterations — far below the
 * floating-point resolution of the answer, and monotonicity makes it safe.
 */
export function tQuantile(probability: number, df: number): number {
  if (probability <= 0 || probability >= 1) {
    throw new RangeError(`tQuantile probability must be in (0,1), received ${probability}.`);
  }
  if (!(df > 0)) {
    throw new RangeError(`tQuantile degrees of freedom must be positive, received ${df}.`);
  }
  if (probability === 0.5) {
    return 0;
  }
  let low = -1e6;
  let high = 1e6;
  for (let step = 0; step < 200; step += 1) {
    const middle = (low + high) / 2;
    if (tCdf(middle, df) < probability) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return (low + high) / 2;
}
