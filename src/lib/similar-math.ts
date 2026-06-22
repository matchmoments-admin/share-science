/**
 * Pure similarity math — no I/O, no imports — so it's unit-testable as a leaf module (like stats.ts /
 * series.ts). similar.ts wires these to D1/EODHD. Keeping the math here keeps the goldens honest.
 */
export const FEATURES = ['mcap_log', 'pe', 'pb', 'ps', 'margin', 'roe', 'growth', 'de', 'beta'] as const;
export type Feature = (typeof FEATURES)[number];

export interface FundRow {
  id: string;
  ticker: string;
  sector: string;
  mcap_log: number | null;
  pe: number | null;
  pb: number | null;
  ps: number | null;
  margin: number | null;
  roe: number | null;
  growth: number | null;
  de: number | null;
  beta: number | null;
}

export interface Peer { peer_id: string; score: number }

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = clamp(Math.floor(q * (sorted.length - 1)), 0, sorted.length - 1);
  return sorted[i];
}

/** Per-feature winsorized z-scores within one sector group; missing → 0 (the sector mean). */
export function zScoreGroup(members: FundRow[]): Map<string, Map<Feature, number>> {
  const out = new Map<string, Map<Feature, number>>();
  for (const m of members) out.set(m.id, new Map());
  for (const f of FEATURES) {
    const vals = members.map((m) => m[f]).filter((v): v is number => v !== null && Number.isFinite(v));
    if (vals.length < 2) continue; // not enough to standardise → leave all at 0
    const sorted = [...vals].sort((a, b) => a - b);
    const lo = quantile(sorted, 0.05);
    const hi = quantile(sorted, 0.95);
    const wins = vals.map((v) => clamp(v, lo, hi));
    const mean = wins.reduce((a, b) => a + b, 0) / wins.length;
    const variance = wins.reduce((a, b) => a + (b - mean) ** 2, 0) / wins.length;
    const std = Math.sqrt(variance);
    for (const m of members) {
      const raw = m[f];
      if (raw === null || !Number.isFinite(raw) || std === 0) continue; // stays 0
      out.get(m.id)!.set(f, clamp((clamp(raw, lo, hi) - mean) / std, -3, 3));
    }
  }
  return out;
}

/** Cosine over the feature z-vectors; 0 for a zero/degenerate vector (never NaN). */
export function cosine(a: Map<Feature, number>, b: Map<Feature, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const f of FEATURES) {
    const x = a.get(f) ?? 0;
    const y = b.get(f) ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Pearson correlation over the dates common to both return maps; null if too little overlap. */
export function correlation(a: Map<string, number>, b: Map<string, number>, minOverlap: number): number | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [d, x] of a) {
    const y = b.get(d);
    if (y !== undefined) { xs.push(x); ys.push(y); }
  }
  const n = xs.length;
  if (n < minOverlap) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx === 0 || vy === 0) return null;
  return cov / Math.sqrt(vx * vy);
}
