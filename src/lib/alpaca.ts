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

export function alpacaMode(env: Env): AlpacaMode {
  const m = (env.ALPACA_MODE || 'off').toLowerCase();
  return m === 'paper' || m === 'live' ? m : 'off';
}

interface AlpacaConfig {
  base: string;
  keyId: string;
  secret: string;
}

function config(env: Env): AlpacaConfig | null {
  const mode = alpacaMode(env);
  if (mode === 'off') return null;
  if (mode === 'live') {
    if (!env.ALPACA_KEY_ID || !env.ALPACA_SECRET_KEY) return null;
    return { base: 'https://api.alpaca.markets', keyId: env.ALPACA_KEY_ID, secret: env.ALPACA_SECRET_KEY };
  }
  if (!env.ALPACA_PAPER_KEY_ID || !env.ALPACA_PAPER_SECRET_KEY) return null;
  return { base: 'https://paper-api.alpaca.markets', keyId: env.ALPACA_PAPER_KEY_ID, secret: env.ALPACA_PAPER_SECRET_KEY };
}

/** Only US, long, real-currency securities are eligible for a real buy. */
export function eligibleForRealBuy(env: Env, sec: Security, direction: string): boolean {
  if (alpacaMode(env) === 'off') return false;
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
  const cfg = config(env);
  if (!cfg) return { ok: false, reason: 'alpaca_not_configured' };
  const notional = Math.max(1, Number(env.ALPACA_NOTIONAL_USD) || 5);

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

  if (resp.status === 422) {
    // duplicate client_order_id or non-tradable symbol — treat as a no-op, not a failure
    const body = await resp.text();
    return { ok: false, reason: `unprocessable:${body.slice(0, 80)}` };
  }
  if (!resp.ok) return { ok: false, reason: `alpaca_${resp.status}` };
  const data = (await resp.json()) as { id?: string; status?: string };
  return { ok: true, orderId: data.id, status: data.status };
}
