/**
 * Alpaca broker client — places the small REAL buys that give the published record skin-in-the-game.
 *
 * Safety by construction:
 *  - ALPACA_MODE gates everything: 'off' (default) → Alpaca is NEVER called; 'paper' → paper-api
 *    with ALPACA_PAPER_* keys; 'live' → api with ALPACA_* keys (requires a funded account + explicit
 *    opt-in). The unprefixed (live) keys are only ever read in 'live' mode.
 *  - Eligibility is narrow: US securities, long (buy/bullish) only, a fixed tiny notional.
 *  - Scoring is unaffected — leaderboard returns always use the EODHD entry-rule (see track.ts);
 *    the Alpaca order is disclosed real exposure, not the scoring basis.
 */
import type { Env, Security } from '../types.js';

export type AlpacaMode = 'off' | 'paper' | 'live';

function normMode(m: string | null | undefined): AlpacaMode | null {
  const v = (m || '').toLowerCase();
  return v === 'off' || v === 'paper' || v === 'live' ? v : null;
}

/**
 * Effective broker mode. A KV override (`alpaca:mode`, set from the admin console) takes precedence
 * over env.ALPACA_MODE so the operator can change mode without a redeploy. On any KV read error we
 * fall back to the deployed env baseline (the safe, intended default) — never silently escalate.
 */
export async function alpacaMode(env: Env): Promise<AlpacaMode> {
  let override: AlpacaMode | null = null;
  try { override = normMode(await env.KV.get('alpaca:mode')); } catch { override = null; }
  return override ?? normMode(env.ALPACA_MODE) ?? 'off';
}

/**
 * Kill-switch. Returns true (HALT real trading) when KV `trading:enabled` is explicitly '0', OR
 * when KV cannot be read — fail CLOSED: if we can't confirm trading is enabled, we don't trade.
 */
export async function tradingPaused(env: Env): Promise<boolean> {
  try { return (await env.KV.get('trading:enabled')) === '0'; }
  catch { return true; }
}

/** Per-order notional, clamped to [1, $50]. The hard $50 ceiling can't be raised by config. */
export const MAX_NOTIONAL_USD = 50;
export function notionalUsd(env: Env): number {
  return Math.max(1, Math.min(MAX_NOTIONAL_USD, Number(env.ALPACA_NOTIONAL_USD) || 5));
}

interface AlpacaConfig {
  base: string;
  keyId: string;
  secret: string;
}

async function config(env: Env): Promise<AlpacaConfig | null> {
  const mode = await alpacaMode(env);
  if (mode === 'off') return null;
  if (mode === 'live') {
    if (!env.ALPACA_KEY_ID || !env.ALPACA_SECRET_KEY) return null;
    return { base: 'https://api.alpaca.markets', keyId: env.ALPACA_KEY_ID, secret: env.ALPACA_SECRET_KEY };
  }
  if (!env.ALPACA_PAPER_KEY_ID || !env.ALPACA_PAPER_SECRET_KEY) return null;
  return { base: 'https://paper-api.alpaca.markets', keyId: env.ALPACA_PAPER_KEY_ID, secret: env.ALPACA_PAPER_SECRET_KEY };
}

/**
 * Eligible for a real buy: trading not paused (fail-closed), mode != off, US security, long view.
 * NOTE: only governs whether a trade_intent is PROPOSED. Real execution additionally requires an
 * operator-'approved' intent (live) — see executeApprovedTrades in trade.ts.
 */
export async function eligibleForRealBuy(env: Env, sec: Security, direction: string): Promise<boolean> {
  if (await tradingPaused(env)) return false;
  if ((await alpacaMode(env)) === 'off') return false;
  const usExchanges = ['US', 'XNAS', 'XNYS', 'ARCX', 'BATS'];
  if (!usExchanges.includes(sec.exchange)) return false;
  return direction === 'buy' || direction === 'bullish';
}

export interface OrderResult {
  ok: boolean;
  orderId?: string;
  status?: string;
  reason?: string;
}

/** Submit a notional market BUY (fractional). Idempotency via client_order_id = the tip id. */
export async function submitBuy(env: Env, symbol: string, clientOrderId: string): Promise<OrderResult> {
  const cfg = await config(env);
  if (!cfg) return { ok: false, reason: 'alpaca_not_configured' };
  const notional = notionalUsd(env);

  const resp = await fetch(`${cfg.base}/v2/orders`, {
    method: 'POST',
    headers: {
      'APCA-API-KEY-ID': cfg.keyId,
      'APCA-API-SECRET-KEY': cfg.secret,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      symbol,
      notional: notional.toFixed(2),
      side: 'buy',
      type: 'market',
      time_in_force: 'day',
      client_order_id: clientOrderId, // Alpaca rejects duplicates → broker-side idempotency
    }),
  });

  if (resp.status === 429) return { ok: false, reason: 'rate_limited' }; // leave as paper, retry never re-buys
  if (resp.status === 422) {
    const body = await resp.text();
    // duplicate client_order_id ⇒ the order was already placed earlier; idempotent success
    if (/client_order_id/i.test(body)) return { ok: true, reason: 'duplicate' };
    return { ok: false, reason: `unprocessable:${body.slice(0, 80)}` }; // not tradable / no funds
  }
  if (!resp.ok) return { ok: false, reason: `alpaca_${resp.status}` };
  const data = (await resp.json()) as { id?: string; status?: string };
  return { ok: true, orderId: data.id, status: data.status };
}
