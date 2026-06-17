/**
 * Entity resolution — the ONLY writer of a tip's security_id.
 *
 * The LLM proposes a ticker/exchange/name; this maps it to a unique canonical security via a
 * deterministic D1 lookup. If it can't confirm a UNIQUE match, it ABSTAINS (returns null) so the
 * tip never reaches the trade path. No model is in the binding decision — money depends on it.
 */
import type { Env, ExtractedTip, Security } from '../types.js';
import { resolveViaEodhd } from './securities.js';

export interface ResolveResult {
  security: Security | null;
  reason: string;
}

// Map an LLM market hint to the exchange codes we store (legacy MIC seeds + EODHD-code rows).
const HINT_TO_EXCHANGES: Record<string, string[]> = {
  US: ['XNAS', 'XNYS', 'ARCX', 'BATS', 'US'],
  AU: ['XASX', 'AU'],
  UK: ['XLON', 'LSE'],
  GB: ['XLON', 'LSE'],
  CA: ['TO'],
};

export async function resolveSecurity(env: Env, tip: ExtractedTip, allowLazy = true): Promise<ResolveResult> {
  const ticker = tip.proposed_ticker?.replace(/^\$/, '').toUpperCase().trim();
  const hintExchanges = tip.exchange_hint ? HINT_TO_EXCHANGES[tip.exchange_hint.toUpperCase()] : undefined;

  // 1. Ticker match against the security master.
  if (ticker) {
    let rows = await byTicker(env, ticker);
    if (rows.length > 1 && hintExchanges) {
      const narrowed = rows.filter((r) => hintExchanges.includes(r.exchange));
      if (narrowed.length > 0) rows = narrowed;
    }
    if (rows.length === 1) return { security: rows[0], reason: 'ticker_unique' };
    if (rows.length > 1) return { security: null, reason: 'ticker_ambiguous_dual_listing' };
    // ticker not found → fall through to alias
  }

  // 2. Alias match (company name or cashtag). Confirm only if it maps to ONE security.
  const aliasKey = (tip.company_name ?? ticker ?? '').toLowerCase().trim();
  if (aliasKey) {
    const ids = await byAlias(env, aliasKey);
    if (ids.length === 1) {
      const sec = await byId(env, ids[0]);
      if (sec) return { security: sec, reason: 'alias_unique' };
    }
    if (ids.length > 1) return { security: null, reason: 'alias_ambiguous' };
  }

  // 3. Lazy: not in the master yet — ask EODHD for a unique exact match, insert, resolve.
  // Gated by allowLazy (a per-message budget) so one spammy item can't fan out EODHD calls.
  if (ticker && allowLazy) {
    const sec = await resolveViaEodhd(env, ticker, tip.exchange_hint);
    if (sec) return { security: sec, reason: 'eodhd_lazy' };
  }

  return { security: null, reason: ticker || aliasKey ? 'not_in_master' : 'no_identifier' };
}

const COLS = 'id, ticker, exchange, isin, name, sec_type, domicile, currency, is_active';

async function byTicker(env: Env, ticker: string): Promise<Security[]> {
  const res = await env.DB.prepare(`SELECT ${COLS} FROM securities WHERE ticker = ?`).bind(ticker).all<Security>();
  return res.results ?? [];
}

async function byAlias(env: Env, alias: string): Promise<string[]> {
  const res = await env.DB.prepare('SELECT DISTINCT security_id FROM security_aliases WHERE alias = ?')
    .bind(alias)
    .all<{ security_id: string }>();
  return (res.results ?? []).map((r) => r.security_id);
}

async function byId(env: Env, id: string): Promise<Security | null> {
  return env.DB.prepare(`SELECT ${COLS} FROM securities WHERE id = ?`).bind(id).first<Security>();
}
