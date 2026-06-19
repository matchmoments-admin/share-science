/**
 * Position opening — turns a resolved tip into a tracked (paper) position.
 *
 * Runs from the daily Cron, NOT the ingest path: entry = the first bar AFTER detection, which
 * doesn't exist until the next session closes. We poll for resolved recommendation tips that have
 * no position yet and open one once the entry bar is available. v1 is paper-only; real Alpaca buys
 * arrive in Slice 3 (gated to US + affordable + confirmed).
 */
import type { Env } from '../types.js';
import type { Security } from '../types.js';
import { uid, nowISO, dateOnly, logOps } from './db.js';
import { getEntryBar, EodhdAccountError } from './prices.js';
import { submitBuy, eligibleForRealBuy, alpacaMode, tradingPaused, notionalUsd } from './alpaca.js';
import { tradeCaps, capDecision } from './tradecaps.js';

const DIRECTIONAL = new Set(['buy', 'bullish', 'sell', 'bearish']);

interface PendingTip {
  id: string;
  security_id: string;
  direction: string;
  detected_at: string;
  confidence: number | null;
}

// A correctly-resolved but low-confidence tip still gets a paper position (scoring record) but is
// NOT auto-proposed for any (paper or live) broker order — keeps weak extractions out of the money path.
const MIN_TRADE_CONFIDENCE = 0.5;

/** Open paper positions for resolved recommendation tips that don't have one yet. */
export async function openPendingPositions(env: Env, limit = 50): Promise<{ opened: number; pending: number }> {
  const res = await env.DB.prepare(
    `SELECT t.id, t.security_id, t.direction, t.detected_at, t.confidence
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
      // Account-level EODHD failure (over-quota/auth) hits every entry-bar lookup — stop the run
      // instead of hammering each pending tip with the same failure.
      if (err instanceof EodhdAccountError) {
        await logOps(env, 'error', { at: 'openPendingPositions', err: 'market_data_unavailable', status: err.status, skipped: pending.length - opened });
        break;
      }
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

  // Real exposure is GATED behind a trade_intent — NO broker call happens here. If eligible, record
  // an intent: in paper it auto-approves (simulated, one-click), in live it stays 'proposed' until an
  // operator approves it. executeApprovedTrades is the ONLY place a real order is ever placed.
  if (await eligibleForRealBuy(env, sec, tip.direction)) {
    if ((tip.confidence ?? 0) < MIN_TRADE_CONFIDENCE) {
      // Correctly resolved but weak extraction — score on paper, but keep it out of the money path.
      await logOps(env, 'trade', { tip: tip.id, ticker: sec.ticker, intent: 'skipped_low_confidence', confidence: tip.confidence });
    } else {
      const mode = await alpacaMode(env); // 'paper' | 'live' (off already excluded by eligibility)
      const status = mode === 'paper' ? 'approved' : 'proposed';
      await env.DB.prepare(
        `INSERT OR IGNORE INTO trade_intents
           (id, tip_id, security_id, ticker, notional_cents, mode, status, approved_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(uid(), tip.id, sec.id, sec.ticker, Math.round(notionalUsd(env) * 100), mode, status,
        status === 'approved' ? nowISO() : null, nowISO()).run();
      await logOps(env, 'trade', { tip: tip.id, ticker: sec.ticker, intent: status, mode });
    }
  }

  await env.DB.prepare(`UPDATE tips SET status = 'tracking' WHERE id = ?`).bind(tip.id).run();
  return true;
}


/**
 * The ONLY caller of submitBuy. Drains 'approved' trade_intents oldest-first, places the real order,
 * and records the outcome. Safe by construction:
 *  - fail-closed kill-switch (bails if trading paused, re-checked per item),
 *  - compare-and-swap claim (approved→executing) so a double-click / overlapping cron sweep can
 *    NEVER double-execute the same intent,
 *  - code-defaulted daily-count + open-notional caps re-checked before each order,
 *  - per-item try/catch (one failure is logged + retryable, never aborts the run),
 *  - bounded LIMIT (≤20 Alpaca calls/run), observable via ops_events.
 * Runs on Approve, and as a sweep on the hourly + daily crons (for any approved-but-unexecuted intent).
 */
/** Live-only exposure tally (caps govern REAL money; paper is simulated and uncapped). */
async function liveTally(env: Env): Promise<{ execToday: number; openCents: number }> {
  const today = dateOnly(nowISO());
  const a = await env.DB.prepare(
    `SELECT COUNT(*) n FROM trade_intents WHERE status='executed' AND mode='live' AND substr(executed_at,1,10)=?`,
  ).bind(today).first<{ n: number }>();
  const b = await env.DB.prepare(
    `SELECT COALESCE(SUM(ti.notional_cents),0) c FROM trade_intents ti JOIN positions p ON p.tip_id=ti.tip_id
      WHERE ti.status='executed' AND ti.mode='live' AND p.status='open'`,
  ).first<{ c: number }>();
  return { execToday: a?.n ?? 0, openCents: b?.c ?? 0 };
}

export async function executeApprovedTrades(env: Env, limit = 20): Promise<{ executed: number; failed: number; deferred: number }> {
  if (await tradingPaused(env)) return { executed: 0, failed: 0, deferred: 0 };
  const caps = tradeCaps(env);

  // Reclaim zombies: an intent claimed 'executing' but never finalized (worker eviction mid-order).
  // Mark stale ones 'failed' (visible + reviewable) so they're never stuck invisibly. 10-min cutoff.
  const staleCut = new Date(Date.now() - 10 * 60_000).toISOString();
  await env.DB.prepare(`UPDATE trade_intents SET status='failed', reason='stale_executing' WHERE status='executing' AND executed_at < ?`)
    .bind(staleCut).run();

  const intents = (await env.DB.prepare(
    `SELECT id, tip_id, ticker, notional_cents, mode FROM trade_intents WHERE status='approved' ORDER BY created_at ASC LIMIT ?`,
  ).bind(limit).all<{ id: string; tip_id: string; ticker: string; notional_cents: number; mode: string }>()).results ?? [];

  let executed = 0, failed = 0, deferred = 0;
  for (const it of intents) {
    try {
      // Caps apply to REAL (live) money only. Re-read the live tally per item to narrow the
      // cross-run race window (the residual race is bounded by the $50/order ceiling).
      if (it.mode === 'live') {
        const t = await liveTally(env);
        const cap = capDecision(t.execToday, t.openCents, it.notional_cents, caps);
        if (cap !== 'ok') { deferred++; await logOps(env, 'trade', { tip: it.tip_id, deferred: cap }); continue; }
      }
      if (await tradingPaused(env)) { deferred++; break; } // halt mid-sweep if paused
      // CAS claim — only one caller can move approved→executing (prevents double-execution).
      const claim = await env.DB.prepare(
        `UPDATE trade_intents SET status='executing', executed_at=? WHERE id=? AND status='approved'`,
      ).bind(nowISO(), it.id).run();
      if (!claim.meta.changes) continue; // already claimed by a concurrent run
      const r = await submitBuy(env, it.ticker, it.tip_id); // idempotent via client_order_id=tip_id
      if (r.ok) {
        await env.DB.prepare(`UPDATE trade_intents SET status='executed', broker_order_id=?, reason=? WHERE id=?`)
          .bind(r.orderId ?? null, r.reason ?? null, it.id).run();
        await env.DB.prepare(`UPDATE positions SET mode='real', broker='alpaca', broker_order_id=?, real_buy_status='placed' WHERE tip_id=?`)
          .bind(r.orderId ?? null, it.tip_id).run();
        await logOps(env, 'trade', { tip: it.tip_id, ticker: it.ticker, executed: true, mode: it.mode, order: r.orderId });
        executed++;
      } else {
        await env.DB.prepare(`UPDATE trade_intents SET status='failed', reason=? WHERE id=?`).bind(r.reason ?? 'unknown', it.id).run();
        // Don't clobber a position already marked 'placed' (defensive — intents are UNIQUE(tip_id)).
        await env.DB.prepare(`UPDATE positions SET real_buy_status='failed' WHERE tip_id=? AND (real_buy_status IS NULL OR real_buy_status <> 'placed')`).bind(it.tip_id).run();
        await logOps(env, 'trade', { tip: it.tip_id, ticker: it.ticker, failed: r.reason });
        failed++;
      }
    } catch (err) {
      // Claimed-but-threw → mark failed (retryable), never leave stuck in 'executing'.
      await env.DB.prepare(`UPDATE trade_intents SET status='failed', reason=? WHERE id=? AND status='executing'`)
        .bind(String(err).slice(0, 120), it.id).run();
      await logOps(env, 'error', { at: 'executeApprovedTrades', tip: it.tip_id, err: String(err) });
      failed++;
    }
  }
  if (executed || failed || deferred) await logOps(env, 'trade', { job: 'executeApprovedTrades', executed, failed, deferred });
  return { executed, failed, deferred };
}
