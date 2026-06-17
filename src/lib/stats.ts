/**
 * Pure statistics for the ratings engine. No I/O — unit-testable in isolation.
 *
 * The headline product is a source's credibility score, so it must be statistically honest:
 * a 5-tip hot streak must NOT look like Warren Buffett. We rank by the Wilson lower confidence
 * bound on the hit rate, which shrinks hard for small samples — so confidence, not luck, ranks.
 */

export interface WilsonBounds {
  point: number; // observed proportion 0..1
  lower: number; // lower CI bound 0..1
  upper: number; // upper CI bound 0..1
}

/**
 * Wilson score interval for a binomial proportion. z=1.96 ≈ 95% CI.
 * n=0 → all zeros. The lower bound is what we rank by: 5/5 → ~0.57, 100/130 → ~0.69,
 * so an established source outranks a perfect tiny sample.
 */
export function wilson(successes: number, n: number, z = 1.96): WilsonBounds {
  if (n <= 0) return { point: 0, lower: 0, upper: 0 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const margin = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return {
    point: p,
    lower: Math.max(0, centre - margin),
    upper: Math.min(1, centre + margin),
  };
}

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1));
}

/** Conviction → integer weight for the conviction-weighted leaderboard. Unknown ≈ low. */
export function convictionWeight(conviction: string | null | undefined): number {
  if (conviction === 'high') return 3;
  if (conviction === 'medium') return 2;
  return 1; // low or unknown
}

/** Weighted arithmetic mean. Falls back to 0 when the weights sum to 0. */
export function weightedMean(xs: number[], ws: number[]): number {
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += xs[i] * ws[i];
    den += ws[i];
  }
  return den === 0 ? 0 : num / den;
}
