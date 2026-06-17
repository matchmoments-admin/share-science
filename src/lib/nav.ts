/**
 * Cumulative portfolio NAV — the "$1,000 invested across every tracked tip" equity curve.
 *
 * Stateless daily snapshot: nav_index = 1000 × (1 + equal-weighted mean of each position's latest
 * return). Derived purely from the positions ledger (already marked-to-market by valueOpenPositions)
 * — NO external price calls. One row per (scope, day), self-healing via INSERT OR REPLACE so a
 * missed day or a re-run just re-states that day. nav_index is an index normalised to a $1,000 base,
 * never a price — safe to publish while PUBLIC_PRICES=off.
 *
 * Constituents include BOTH open and closed positions (closed ones frozen at their final return) so
 * the curve keeps survivors AND losers — the same survivorship-integrity stance as the leaderboard.
 */
import type { Env } from '../types.js';
import { nowISO, dateOnly, logOps } from './db.js';

const NAV_BASE = 1000;

export async function snapshotNav(env: Env, todayISO = nowISO()): Promise<{ scope: string; as_of: string; nav_index: number; n: number } | null> {
  const asOf = dateOnly(todayISO);
  const row = await env.DB.prepare(
    `SELECT AVG(return_pct) AS avg_ret, COUNT(*) AS n FROM positions WHERE return_pct IS NOT NULL`,
  ).first<{ avg_ret: number | null; n: number }>();
  const n = row?.n ?? 0;
  if (n === 0 || row?.avg_ret === null || row?.avg_ret === undefined) {
    return null; // nothing valued yet — no snapshot
  }
  const avgRet = row.avg_ret;
  const navIndex = NAV_BASE * (1 + avgRet);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO portfolio_nav (scope, as_of, nav_index, return_pct, n_positions, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind('all', asOf, navIndex, avgRet, n, nowISO()).run();
  await logOps(env, 'cron', { job: 'snapshotNav', scope: 'all', as_of: asOf, nav_index: navIndex, n });
  return { scope: 'all', as_of: asOf, nav_index: navIndex, n };
}
