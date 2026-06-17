/**
 * Ratings engine — full recompute of source_ratings from settled tip outcomes.
 *
 * One row per (source, horizon ∈ {30,90,365}). Confidence-adjusted: rank by the Wilson lower
 * bound, and ALWAYS rank established sources (n≥THRESHOLD) above provisional ones — so a small
 * perfect sample can never top an established track record (the Buffett property).
 */
import type { Env } from '../types.js';
import { nowISO, logOps } from './db.js';
import { wilson, mean, median, stdev } from './stats.js';

const ESTABLISHED_MIN_TIPS = 20;

interface SettledRow {
  source_id: string;
  horizon_days: number;
  excess_pct: number;
  is_hit: number;
  tip_id: string;
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

export async function recomputeRatings(env: Env): Promise<{ rows: number; dimensions: number }> {
  const RATING_ROW_CAP = 100_000;
  const res = await env.DB.prepare(
    `SELECT t.source_id, tr.horizon_days, tr.excess_pct, tr.is_hit, tr.tip_id
       FROM tip_returns tr JOIN tips t ON t.id = tr.tip_id
      WHERE tr.is_hit IS NOT NULL AND tr.excess_pct IS NOT NULL
      LIMIT ?`,
  ).bind(RATING_ROW_CAP).all<SettledRow>();
  const settled = res.results ?? [];
  if (settled.length >= RATING_ROW_CAP) await logOps(env, 'error', { at: 'recomputeRatings', warn: 'row_cap_hit', cap: RATING_ROW_CAP });

  // Group by (source_id, horizon).
  const groups = new Map<string, SettledRow[]>();
  for (const r of settled) {
    const key = `${r.source_id}|${r.horizon_days}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }

  // Build a rating row per group.
  const rows: RatingRow[] = [];
  for (const [key, rs] of groups) {
    const [source_id, horizonStr] = key.split('|');
    const excesses = rs.map((r) => r.excess_pct);
    const nHits = rs.reduce((a, r) => a + (r.is_hit ? 1 : 0), 0);
    const w = wilson(nHits, rs.length);
    const best = rs.reduce((a, b) => (b.excess_pct > a.excess_pct ? b : a));
    const worst = rs.reduce((a, b) => (b.excess_pct < a.excess_pct ? b : a));
    rows.push({
      source_id,
      dimension: `horizon:${horizonStr}`,
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
    });
  }

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
