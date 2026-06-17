/**
 * Security-master population. The seed has only ~9 rows; real tips name hundreds of tickers, so
 * resolution would abstain on almost everything. We (a) bulk-seed an exchange from EODHD's
 * symbol list, and (b) lazily add a single ticker on a confident miss. Both upsert idempotently.
 *
 * Stored `exchange` for bulk/lazy rows is the EODHD code ('US' | 'AU'), which prices.ts maps
 * straight to the EODHD symbol suffix. The original XNAS/XASX seeds keep working (PK on id).
 */
import type { Env, Security } from '../types.js';
import { nowISO, logOps } from './db.js';

const KEEP_TYPES = new Set(['Common Stock', 'ETF', 'Preferred Stock', 'Fund']);

interface EodhdSymbol {
  Code: string;
  Name: string;
  Currency?: string;
  Type?: string;
  Isin?: string | null;
}

function toRow(s: EodhdSymbol, exchange: string): Security & { sector: null } {
  return {
    id: `${s.Code}.${exchange}`,
    ticker: s.Code,
    exchange,
    isin: s.Isin || null,
    name: s.Name || s.Code,
    sec_type: s.Type === 'ETF' ? 'etf' : s.Type === 'Fund' ? 'fund' : 'share',
    domicile: exchange === 'AU' ? 'AU' : exchange === 'US' ? 'US' : null,
    currency: s.Currency || null,
    is_active: 1,
    sector: null,
  };
}

/** Bulk-seed one EODHD exchange (e.g. 'AU', 'US') into securities. Chunked, idempotent. */
export async function seedExchange(env: Env, exchange: string, max = 20000): Promise<{ fetched: number; inserted: number }> {
  if (!env.EODHD_API_KEY) throw new Error('EODHD_API_KEY not set');
  const url = `https://eodhd.com/api/exchange-symbol-list/${encodeURIComponent(exchange)}?api_token=${env.EODHD_API_KEY}&fmt=json`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`EODHD symbol-list ${exchange} ${resp.status}`);
  const all = (await resp.json()) as EodhdSymbol[];
  const rows = (Array.isArray(all) ? all : [])
    .filter((s) => s.Code && (!s.Type || KEEP_TYPES.has(s.Type)))
    .slice(0, max)
    .map((s) => toRow(s, exchange));

  const now = nowISO();
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO securities (id, ticker, exchange, isin, name, sec_type, domicile, currency, sector, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  );
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    await env.DB.batch(chunk.map((r) => stmt.bind(r.id, r.ticker, r.exchange, r.isin, r.name, r.sec_type, r.domicile, r.currency, r.sector, now)));
    inserted += chunk.length;
  }
  await logOps(env, 'cron', { job: 'seedExchange', exchange, fetched: all.length, considered: rows.length });
  return { fetched: Array.isArray(all) ? all.length : 0, inserted };
}

/**
 * Lazy single-ticker lookup on a resolution miss. Returns a confirmed Security (and inserts it)
 * only on a UNIQUE, exact-code match; otherwise null (caller abstains). Bounded by one EODHD call.
 */
export async function resolveViaEodhd(env: Env, ticker: string, exchangeHint?: string | null): Promise<Security | null> {
  if (!env.EODHD_API_KEY) return null;
  if (!/^[A-Z0-9.\-]{1,8}$/.test(ticker)) return null;
  const url = `https://eodhd.com/api/search/${encodeURIComponent(ticker)}?api_token=${env.EODHD_API_KEY}&fmt=json&limit=20`;
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const hits = (await resp.json()) as Array<{ Code: string; Exchange: string; Name: string; Currency?: string; Type?: string; ISIN?: string | null }>;
  if (!Array.isArray(hits)) return null;

  // exact code match only; map EODHD Exchange → our 'US'/'AU' bucket.
  let exact = hits.filter((h) => h.Code?.toUpperCase() === ticker.toUpperCase()).map((h) => ({ ...h, market: marketOf(h.Exchange) })).filter((h) => h.market);
  if (exchangeHint) {
    const hinted = exact.filter((h) => h.market === exchangeHint.toUpperCase());
    if (hinted.length) exact = hinted;
  }
  if (exact.length !== 1) return null; // 0 or ambiguous → abstain

  const h = exact[0];
  const row = toRow({ Code: h.Code, Name: h.Name, Currency: h.Currency, Type: h.Type, Isin: h.ISIN ?? null }, h.market!);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO securities (id, ticker, exchange, isin, name, sec_type, domicile, currency, sector, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?)`,
  ).bind(row.id, row.ticker, row.exchange, row.isin, row.name, row.sec_type, row.domicile, row.currency, nowISO()).run();
  return env.DB.prepare(
    'SELECT id, ticker, exchange, isin, name, sec_type, domicile, currency, is_active FROM securities WHERE id = ?',
  ).bind(row.id).first<Security>();
}

/** Map an EODHD exchange code to our market bucket. */
function marketOf(eodhdExchange: string | undefined): string | null {
  if (!eodhdExchange) return null;
  const e = eodhdExchange.toUpperCase();
  if (['US', 'NASDAQ', 'NYSE', 'NYSE ARCA', 'BATS', 'AMEX', 'NYSE MKT', 'OTCMKTS', 'PINK'].includes(e)) return 'US';
  if (['AU', 'ASX'].includes(e)) return 'AU';
  if (['LSE', 'LON'].includes(e)) return 'LSE';
  if (['TO', 'TSX', 'V', 'TSXV'].includes(e)) return 'TO';
  return null;
}
