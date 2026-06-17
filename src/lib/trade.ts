/**
 * Position opening — turns a resolved tip into a tracked (paper) position.
 *
 * Runs from the daily Cron, NOT the ingest path: entry = the first bar AFTER detection, which
 * doesn't exist until the next session closes. We poll for resolved recommendation tips that have
 * no position yet and open one once the entry bar is available. v1 is paper-only; real Alpaca buys
 * arrive in Slice 3 (gated to US + affordable + confirmed).
 */
import type { Env, Security } from '../types.js';
import { uid, nowISO, logOps } from './db.js';
import { getEntryBar } from './prices.js';
import { submitBuy, eligibleForRealBuy, alpacaMode } from './alpaca.js';

const DIRECTIONAL = new Set(['buy', 'bullish', 'sell', 'bearish']);

interface PendingTip {
  id: string;
  security_id: string;
  direction: string;
  detected_at: string;
}

/** Open paper positions for resolved recommendation tips that don't have one yet. */
export async function openPendingPositions(env: Env, limit = 50): Promise<{ opened: number; pending: number }> {
  const res = await env.DB.prepare(
    `SELECT t.id, t.security_id, t.direction, t.detected_at
       FROM tips t
       LEFT JOIN positions p ON p.tip_id = t.id
      WHERE t.security_id IS NOT NULL
        AND p.id IS NULL
        AND t.status = 'resolved'
      LIMIT ?`,
  ).bind(limit).all<PendingTip>();

  const pending = res.results ?? [];
  let opened = 0;
  for (const tip of pending) {
    if (!DIRECTIONAL.has(tip.direction)) {
      // hold/none: nothing to track — mark closed so we don't re-scan it.
      await env.DB.prepare(`UPDATE tips SET status = 'closed' WHERE id = ?`).bind(tip.id).run();
      continue;
    }
    try {
      if (await openOne(env, tip)) opened++;
    } catch (err) {
      await logOps(env, 'error', { at: 'openPendingPositions', tip: tip.id, err: String(err) });
    }
  }
  return { opened, pending: pending.length };
}

async function openOne(env: Env, tip: PendingTip): Promise<boolean> {
  const sec = await env.DB.prepare(
    'SELECT id, ticker, exchange, isin, name, sec_type, domicile, currency, is_active FROM securities WHERE id = ?',
  ).bind(tip.security_id).first<Security>();
  if (!sec) return false;

  const entry = await getEntryBar(env, sec, tip.detected_at);
  if (!entry) return false; // next session hasn't closed yet — retry next run

  const market = sec.exchange === 'XASX' || sec.exchange === 'AU' ? 'AU' : 'US';
  // Insert the (synthetic-paper) position FIRST — it's the scoring record, entry per the EODHD rule.
  const ins = await env.DB.prepare(
    `INSERT OR IGNORE INTO positions
       (id, tip_id, security_id, mode, broker, benchmark_id, entry_rule, entry_at,
        entry_price_raw, entry_price_adj, quantity, status, idempotency_key, created_at)
     VALUES (?, ?, ?, 'paper', NULL, ?, 'next_open_after_detection', ?, ?, ?, 1, 'open', ?, ?)`,
  ).bind(uid(), tip.id, sec.id, market, entry.date, entry.raw, entry.adj, `pos:${tip.id}`, nowISO()).run();
  if (!ins.meta.changes) return false; // position already existed — never re-buy

  // Optionally place a real (disclosed, tiny) broker buy. Scoring still uses the EODHD entry above;
  // this is real exposure only. Gated: ALPACA_MODE != off, US, long. A broker error never fails the position.
  if (eligibleForRealBuy(env, sec, tip.direction)) {
    try {
      const r = await submitBuy(env, sec.ticker, tip.id); // client_order_id = tip.id → broker-side idempotency
      if (r.ok) {
        await env.DB.prepare(`UPDATE positions SET mode = 'real', broker = 'alpaca', broker_order_id = ? WHERE tip_id = ?`)
          .bind(r.orderId ?? null, tip.id).run();
        await logOps(env, 'trade', { tip: tip.id, ticker: sec.ticker, mode: alpacaMode(env), order: r.orderId });
      } else {
        await logOps(env, 'trade', { tip: tip.id, ticker: sec.ticker, real_skipped: r.reason });
      }
    } catch (err) {
      await logOps(env, 'error', { at: 'submitBuy', tip: tip.id, err: String(err) });
    }
  }

  await env.DB.prepare(`UPDATE tips SET status = 'tracking' WHERE id = ?`).bind(tip.id).run();
  return true;
}
