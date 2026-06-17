/**
 * Outcome tracking — values open positions and snapshots horizon returns.
 *
 * Direction-aware ALPHA (excess vs the market benchmark) is the credibility metric: a buy "hits"
 * if it beat its benchmark; a sell "hits" if it underperformed. All return math uses adjusted
 * prices; the frozen unadjusted entry stays as evidence. Snapshots at 30/90/365d are computed at
 * the exact target date (back-fillable), and a position closes once its 365d snapshot lands.
 */
import type { Env, Security } from '../types.js';
import { nowISO, dateOnly, addDays, logOps } from './db.js';
import { getAdjCloseAsOf, getLatestAdjClose, type PriceCache } from './prices.js';
import { maxDrawdown, periodReturns, annualisedVol, sharpe } from './stats.js';

const HORIZONS = [30, 90, 365];
const SEC_COLS = 'id, ticker, exchange, isin, name, sec_type, domicile, currency, is_active';
// Bound per-run work (automation-safety rule): cap positions valued per invocation so a single
// cron stays well under the Workers subrequest limit; oldest-valued first so all get serviced.
const MAX_POSITIONS_PER_RUN = 150; // × a few cached EODHD calls each → well under the 1000 subrequest cap

interface OpenPosition {
  id: string;
  tip_id: string;
  security_id: string;
  benchmark_id: string | null;
  entry_at: string;
  entry_price_adj: number;
  direction: string;
  target_price_raw: number | null;
  target_hit_at: string | null;
}

export async function valueOpenPositions(env: Env, todayISO = nowISO()): Promise<{ valued: number; closed: number; open_remaining: number }> {
  const res = await env.DB.prepare(
    `SELECT p.id, p.tip_id, p.security_id, p.benchmark_id, p.entry_at, p.entry_price_adj, t.direction,
            t.target_price_raw, p.target_hit_at
       FROM positions p JOIN tips t ON t.id = p.tip_id
      WHERE p.status = 'open'
      ORDER BY p.last_valued_at ASC
      LIMIT ?`,
  ).bind(MAX_POSITIONS_PER_RUN).all<OpenPosition>();

  const cache: PriceCache = new Map(); // shared across all positions this run (benchmark etc.)
  let valued = 0;
  let closed = 0;
  for (const pos of res.results ?? []) {
    try {
      const didClose = await valueOne(env, pos, todayISO, cache);
      valued++;
      if (didClose) closed++;
    } catch (err) {
      await logOps(env, 'error', { at: 'valueOpenPositions', position: pos.id, err: String(err) });
    }
  }
  const remaining = await env.DB.prepare(`SELECT count(*) AS n FROM positions WHERE status = 'open'`).first<{ n: number }>();
  return { valued, closed, open_remaining: (remaining?.n ?? valued) - closed };
}

async function valueOne(env: Env, pos: OpenPosition, todayISO: string, cache: PriceCache): Promise<boolean> {
  const sec = await secById(env, pos.security_id);
  if (!sec) return false;
  const bench = pos.benchmark_id ? await benchSecurity(env, pos.benchmark_id) : null;

  // Current valuation (latest available close).
  const latest = await getLatestAdjClose(env, sec, todayISO, cache);
  if (latest) {
    const ret = latest.adj / pos.entry_price_adj - 1;
    const benchRet = bench ? await benchReturn(env, bench, pos.entry_at, latest.date, cache) : null;
    const excess = benchRet === null ? null : ret - benchRet;
    await env.DB.prepare(
      `INSERT OR REPLACE INTO valuations (position_id, as_of, price_adj, return_pct, excess_pct)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(pos.id, latest.date, latest.adj, ret, excess).run();
    await env.DB.prepare(
      `UPDATE positions SET return_pct = ?, bench_return_pct = ?, excess_return_pct = ?, last_valued_at = ? WHERE id = ?`,
    ).bind(ret, benchRet, excess, nowISO(), pos.id).run();

    // Time-to-target: first session the RAW price crosses the stated (raw) target. Idempotent —
    // only set while still NULL. Reuses the `latest` bar already fetched (no extra price call).
    if (pos.target_price_raw && !pos.target_hit_at && targetCrossed(pos.direction, latest.raw, pos.target_price_raw)) {
      const days = daysBetween(pos.entry_at, latest.date);
      await env.DB.prepare(
        'UPDATE positions SET target_hit_at = ?, days_to_target = ? WHERE id = ? AND target_hit_at IS NULL',
      ).bind(latest.date, days, pos.id).run();
    }
  }

  // Horizon snapshots (exact target date, idempotent).
  for (const h of HORIZONS) {
    const target = addDays(pos.entry_at, h);
    if (dateOnly(todayISO) < target) continue; // horizon not reached yet
    const existing = await env.DB.prepare('SELECT 1 FROM tip_returns WHERE tip_id = ? AND horizon_days = ?')
      .bind(pos.tip_id, h).first();
    if (existing) continue;

    const at = await getAdjCloseAsOf(env, sec, target, cache);
    if (!at) continue;
    const ret = at.adj / pos.entry_price_adj - 1;
    const benchRet = bench ? await benchReturn(env, bench, pos.entry_at, at.date, cache) : null;
    const excess = benchRet === null ? null : ret - benchRet;
    const isHit = excess === null ? null : hit(pos.direction, excess) ? 1 : 0;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO tip_returns (tip_id, horizon_days, return_pct, excess_pct, is_hit, as_of)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(pos.tip_id, h, ret, excess, isHit, at.date).run();

    if (h === 365) {
      await env.DB.prepare(
        `UPDATE positions SET status = 'closed', exit_at = ?, exit_price_adj = ?, eval_horizon_days = 365, is_hit = ? WHERE id = ?`,
      ).bind(at.date, at.adj, isHit, pos.id).run();
      await env.DB.prepare(`UPDATE tips SET status = 'closed' WHERE id = ?`).bind(pos.tip_id).run();
      return true;
    }
  }
  return false;
}

const MAX_RISK_POSITIONS_PER_RUN = 150; // bound per run; pure D1 reads, no external calls

/**
 * Recompute per-position risk metrics (max drawdown, annualised volatility, Sharpe-proxy) from the
 * already-persisted valuations time series — NO external price calls. Bounded + idempotent: each
 * position is recomputed at most once per day (risk_metrics_as_of guard), oldest first.
 */
export async function recomputeRiskMetrics(env: Env, todayISO = nowISO()): Promise<{ computed: number }> {
  const today = dateOnly(todayISO);
  const res = await env.DB.prepare(
    `SELECT id FROM positions
      WHERE return_pct IS NOT NULL AND (risk_metrics_as_of IS NULL OR risk_metrics_as_of < ?)
      ORDER BY risk_metrics_as_of ASC LIMIT ?`,
  ).bind(today, MAX_RISK_POSITIONS_PER_RUN).all<{ id: string }>();

  let computed = 0;
  for (const { id } of res.results ?? []) {
    try {
      const vals = (await env.DB.prepare(
        'SELECT return_pct, excess_pct FROM valuations WHERE position_id = ? ORDER BY as_of ASC',
      ).bind(id).all<{ return_pct: number | null; excess_pct: number | null }>()).results ?? [];
      const cumRet = vals.map((v) => v.return_pct).filter((r): r is number => r !== null);
      const cumExc = vals.map((v) => v.excess_pct).filter((e): e is number => e !== null);
      const dd = cumRet.length ? maxDrawdown(cumRet) : null;
      const vol = cumRet.length > 1 ? annualisedVol(periodReturns(cumRet)) : null;
      const shp = cumExc.length > 1 ? sharpe(periodReturns(cumExc)) : null;
      await env.DB.prepare(
        'UPDATE positions SET max_drawdown_pct = ?, volatility_pct = ?, sharpe_proxy = ?, risk_metrics_as_of = ? WHERE id = ?',
      ).bind(dd, vol, shp, today, id).run();
      computed++;
    } catch (err) {
      await logOps(env, 'error', { at: 'recomputeRiskMetrics', position: id, err: String(err) });
    }
  }
  return { computed };
}

/** Direction-aware hit: long views want positive alpha; short views want negative. */
function hit(direction: string, excess: number): boolean {
  if (direction === 'sell' || direction === 'bearish') return excess < 0;
  return excess > 0; // buy / bullish
}

/** Direction-aware target cross: a buy reaches its target at/above it; a sell at/below it. */
function targetCrossed(direction: string, price: number, target: number): boolean {
  if (direction === 'sell' || direction === 'bearish') return price <= target;
  return price >= target; // buy / bullish
}

/** Whole calendar days between two ISO dates (date-only). */
function daysBetween(fromISO: string, toISO: string): number {
  const a = Date.parse(`${dateOnly(fromISO)}T00:00:00Z`);
  const b = Date.parse(`${dateOnly(toISO)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

async function benchReturn(env: Env, bench: Security, entryAt: string, asOf: string, cache: PriceCache): Promise<number | null> {
  const start = await getAdjCloseAsOf(env, bench, entryAt, cache);
  const end = await getAdjCloseAsOf(env, bench, asOf, cache);
  if (!start || !end || !start.adj) return null;
  return end.adj / start.adj - 1;
}

async function secById(env: Env, id: string): Promise<Security | null> {
  return env.DB.prepare(`SELECT ${SEC_COLS} FROM securities WHERE id = ?`).bind(id).first<Security>();
}

async function benchSecurity(env: Env, benchId: string): Promise<Security | null> {
  const row = await env.DB.prepare('SELECT security_id FROM benchmarks WHERE id = ?').bind(benchId).first<{ security_id: string | null }>();
  if (!row?.security_id) return null;
  return secById(env, row.security_id);
}
