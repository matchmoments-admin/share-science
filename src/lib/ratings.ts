/**
 * Ratings engine — full recompute of source_ratings from settled tip outcomes.
 *
 * One row per (source, horizon ∈ {30,90,365}). Confidence-adjusted: rank by the Wilson lower
 * bound, and ALWAYS rank established sources (n≥THRESHOLD) above provisional ones — so a small
 * perfect sample can never top an established track record (the Buffett property).
 */
import type { Env } from '../types.js';
import { nowISO, logOps } from './db.js';
import { wilson, mean, median, stdev, convictionWeight, weightedMean } from './stats.js';
import { primaryHorizon, type TipType } from './horizon.js';

const ESTABLISHED_MIN_TIPS = 20;

interface SettledRow {
  source_id: string;
  horizon_days: number;
  excess_pct: number;
  is_hit: number;
  tip_id: string;
  tip_type: string | null;
  horizon_days_target: number | null;
  conviction: string | null;
}

interface RatingRow {
  source_id: string;
  dimension: string;
  n_tips: number;
  n_hits: number;
  hit_rate: number;
  avg_excess_pct: number;
  median_excess_pct: number;
  stdev_excess_pct: number;
  rating_score: number;
  score_lower: number;
  score_upper: number;
  tier: 'established' | 'provisional';
  rank: number;
  best_tip_id: string | null;
  worst_tip_id: string | null;
}

/** Equal-weighted rating row for a group of settled tips under one dimension. */
function buildRow(source_id: string, dimension: string, rs: SettledRow[]): RatingRow {
  const excesses = rs.map((r) => r.excess_pct);
  const nHits = rs.reduce((a, r) => a + (r.is_hit ? 1 : 0), 0);
  const w = wilson(nHits, rs.length);
  const best = rs.reduce((a, b) => (b.excess_pct > a.excess_pct ? b : a));
  const worst = rs.reduce((a, b) => (b.excess_pct < a.excess_pct ? b : a));
  return {
    source_id,
    dimension,
    n_tips: rs.length,
    n_hits: nHits,
    hit_rate: nHits / rs.length,
    avg_excess_pct: mean(excesses),
    median_excess_pct: median(excesses),
    stdev_excess_pct: stdev(excesses),
    rating_score: 100 * (nHits / rs.length),
    score_lower: 100 * w.lower,
    score_upper: 100 * w.upper,
    tier: rs.length >= ESTABLISHED_MIN_TIPS ? 'established' : 'provisional',
    rank: 0, // assigned below
    best_tip_id: best.tip_id,
    worst_tip_id: worst.tip_id,
  };
}

/**
 * Conviction-weighted row: hit rate + avg alpha weighted by stated conviction (low/med/high = 1/2/3).
 * The CONFIDENCE interval (score_lower) stays on the RAW sample so weighting can't manufacture
 * statistical confidence — it only reflects that high-conviction calls count for more.
 */
function buildWeightedRow(source_id: string, dimension: string, rs: SettledRow[]): RatingRow {
  const excesses = rs.map((r) => r.excess_pct);
  const ws = rs.map((r) => convictionWeight(r.conviction));
  const wHitRate = weightedMean(rs.map((r) => (r.is_hit ? 1 : 0)), ws);
  const nHits = rs.reduce((a, r) => a + (r.is_hit ? 1 : 0), 0);
  const w = wilson(nHits, rs.length); // honest CI on raw n
  const best = rs.reduce((a, b) => (b.excess_pct > a.excess_pct ? b : a));
  const worst = rs.reduce((a, b) => (b.excess_pct < a.excess_pct ? b : a));
  return {
    source_id,
    dimension,
    n_tips: rs.length,
    n_hits: nHits,
    hit_rate: wHitRate,
    avg_excess_pct: weightedMean(excesses, ws),
    median_excess_pct: median(excesses),
    stdev_excess_pct: stdev(excesses),
    rating_score: 100 * wHitRate,
    score_lower: 100 * w.lower,
    score_upper: 100 * w.upper,
    tier: rs.length >= ESTABLISHED_MIN_TIPS ? 'established' : 'provisional',
    rank: 0,
    best_tip_id: best.tip_id,
    worst_tip_id: worst.tip_id,
  };
}

export async function recomputeRatings(env: Env): Promise<{ rows: number; dimensions: number }> {
  const RATING_ROW_CAP = 100_000;
  const res = await env.DB.prepare(
    // Deterministic order so that if the cap ever truncates, it cuts the SAME rows each run
    // (reproducible ranking) rather than an arbitrary subset. Full pagination is the eventual fix.
    `SELECT t.source_id, tr.horizon_days, tr.excess_pct, tr.is_hit, tr.tip_id,
            t.tip_type, t.horizon_days_target, t.conviction
       FROM tip_returns tr JOIN tips t ON t.id = tr.tip_id
      WHERE tr.is_hit IS NOT NULL AND tr.excess_pct IS NOT NULL
      ORDER BY tr.tip_id, tr.horizon_days
      LIMIT ?`,
  ).bind(RATING_ROW_CAP).all<SettledRow>();
  const settled = res.results ?? [];
  if (settled.length >= RATING_ROW_CAP) await logOps(env, 'error', { at: 'recomputeRatings', warn: 'row_cap_hit', cap: RATING_ROW_CAP });

  // Group by (source_id, horizon) for the standard horizon dimensions.
  const groups = new Map<string, SettledRow[]>();
  // Per tip: collect its settled rows so we can pick the one at its PRIMARY horizon.
  const byTip = new Map<string, SettledRow[]>();
  for (const r of settled) {
    const key = `${r.source_id}|${r.horizon_days}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
    (byTip.get(r.tip_id) ?? byTip.set(r.tip_id, []).get(r.tip_id)!).push(r);
  }

  const rows: RatingRow[] = [];
  // Standard horizon dimensions (unchanged, backward-compatible).
  for (const [key, rs] of groups) {
    const [source_id, horizonStr] = key.split('|');
    rows.push(buildRow(source_id, `horizon:${horizonStr}`, rs));
  }

  // PRIMARY dimension: score each tip on the window nearest its stated horizon (Slice 1).
  const primaryBySource = new Map<string, SettledRow[]>();
  for (const rs of byTip.values()) {
    const want = primaryHorizon(rs[0].tip_type as TipType | null, rs[0].horizon_days_target);
    const picked = rs.find((r) => r.horizon_days === want);
    if (!picked) continue; // the tip's primary window hasn't settled yet
    (primaryBySource.get(picked.source_id) ?? primaryBySource.set(picked.source_id, []).get(picked.source_id)!).push(picked);
  }
  for (const [source_id, rs] of primaryBySource) rows.push(buildRow(source_id, 'primary', rs));

  // CONVICTION-weighted dimension: weight the 90-day rows by stated conviction (Slice 5).
  const convBySource = new Map<string, SettledRow[]>();
  for (const r of settled) {
    if (r.horizon_days !== 90) continue;
    (convBySource.get(r.source_id) ?? convBySource.set(r.source_id, []).get(r.source_id)!).push(r);
  }
  for (const [source_id, rs] of convBySource) rows.push(buildWeightedRow(source_id, 'conviction:90', rs));

  // Rank within each dimension: established first, then by Wilson lower bound desc.
  const byDim = new Map<string, RatingRow[]>();
  for (const r of rows) (byDim.get(r.dimension) ?? byDim.set(r.dimension, []).get(r.dimension)!).push(r);
  for (const dimRows of byDim.values()) {
    dimRows.sort((a, b) => {
      const aEst = a.tier === 'established' ? 1 : 0;
      const bEst = b.tier === 'established' ? 1 : 0;
      if (aEst !== bEst) return bEst - aEst;
      return b.score_lower - a.score_lower;
    });
    dimRows.forEach((r, i) => (r.rank = i + 1));
  }

  // Full recompute: clear then batch-insert (bounded D1 round-trips).
  const now = nowISO();
  await env.DB.prepare('DELETE FROM source_ratings').run();
  const ins = env.DB.prepare(
    `INSERT INTO source_ratings
       (source_id, dimension, n_tips, n_hits, hit_rate, avg_excess_pct, median_excess_pct,
        stdev_excess_pct, rating_score, score_lower, score_upper, tier, rank,
        best_tip_id, worst_tip_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < rows.length; i += 100) {
    await env.DB.batch(rows.slice(i, i + 100).map((r) =>
      ins.bind(
        r.source_id, r.dimension, r.n_tips, r.n_hits, r.hit_rate, r.avg_excess_pct, r.median_excess_pct,
        r.stdev_excess_pct, r.rating_score, r.score_lower, r.score_upper, r.tier, r.rank,
        r.best_tip_id, r.worst_tip_id, now,
      )));
  }

  await logOps(env, 'cron', { job: 'recomputeRatings', rows: rows.length, dimensions: byDim.size });
  return { rows: rows.length, dimensions: byDim.size };
}
