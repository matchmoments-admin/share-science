/**
 * EODHD market-data client (EOD only — no real-time, no exchange license needed).
 *
 * Returns adjusted prices for return math + raw prices for frozen evidence. The price feed IS the
 * trading calendar: "first bar strictly after detection" naturally skips weekends/holidays.
 * Guardrail: these raw prices are for internal computation — never serve them publicly while
 * PUBLIC_PRICES=off (assertNoRawPrices enforces that on the way out).
 */
import type { Env, Security } from '../types.js';
import { dateOnly } from './db.js';

interface EodBar {
  date: string; // YYYY-MM-DD
  open: number;
  close: number;
  adjusted_close: number;
}

export interface Bar {
  date: string;
  raw: number; // unadjusted (open for entry, close for valuations)
  adj: number; // adjusted
}

const EXCHANGE_SUFFIX: Record<string, string> = {
  XNAS: 'US', XNYS: 'US', ARCX: 'US', BATS: 'US',
  XASX: 'AU', XLON: 'LSE',
  // EODHD-code exchanges (bulk/lazy-seeded securities store these directly):
  US: 'US', AU: 'AU', LSE: 'LSE', TO: 'TO',
};

export function eodhdSymbol(sec: Security): string {
  const suffix = EXCHANGE_SUFFIX[sec.exchange] ?? 'US';
  return `${sec.ticker}.${suffix}`;
}

async function fetchEod(env: Env, symbol: string, fromISO: string, toISO: string): Promise<EodBar[]> {
  if (!env.EODHD_API_KEY) throw new Error('EODHD_API_KEY not set');
  const url =
    `https://eodhd.com/api/eod/${encodeURIComponent(symbol)}` +
    `?api_token=${env.EODHD_API_KEY}&fmt=json&order=a&from=${dateOnly(fromISO)}&to=${dateOnly(toISO)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`EODHD ${symbol} ${resp.status}`);
  const data = (await resp.json()) as EodBar[];
  return Array.isArray(data) ? data : [];
}

function adjFactor(b: EodBar): number {
  return b.close ? b.adjusted_close / b.close : 1;
}

/**
 * Entry bar = OPEN of the first trading bar STRICTLY AFTER `afterISO`. Returns null if no such bar
 * exists yet (e.g. the tip is from today and the next session hasn't closed) — caller retries later.
 */
export async function getEntryBar(env: Env, sec: Security, afterISO: string): Promise<Bar | null> {
  const from = afterISO;
  const to = isoPlusDays(afterISO, 14);
  const bars = await fetchEod(env, eodhdSymbol(sec), from, to);
  const cut = dateOnly(afterISO);
  const bar = bars.find((b) => b.date > cut);
  if (!bar) return null;
  return { date: bar.date, raw: bar.open, adj: bar.open * adjFactor(bar) };
}

/**
 * Per-run price cache — collapses repeated lookups (esp. the benchmark, shared across every
 * position) so a daily valuation of N positions doesn't make O(N) identical EODHD calls.
 * Pass one `PriceCache` for the whole run.
 */
export type PriceCache = Map<string, Bar | null>;

/** Adjusted close on `dateISO`, or the most recent trading day at/before it. Null if none found. */
export async function getAdjCloseAsOf(env: Env, sec: Security, dateISO: string, cache?: PriceCache): Promise<Bar | null> {
  const key = `aoc|${sec.id}|${dateOnly(dateISO)}`;
  if (cache?.has(key)) return cache.get(key)!;
  const from = isoPlusDays(dateISO, -10);
  const bars = await fetchEod(env, eodhdSymbol(sec), from, dateISO);
  const bar = bars.length ? { date: bars[bars.length - 1].date, raw: bars[bars.length - 1].close, adj: bars[bars.length - 1].adjusted_close } : null;
  cache?.set(key, bar);
  return bar;
}

/** Latest available adjusted close (within the last ~10 days). */
export async function getLatestAdjClose(env: Env, sec: Security, todayISO: string, cache?: PriceCache): Promise<Bar | null> {
  return getAdjCloseAsOf(env, sec, todayISO, cache);
}

function isoPlusDays(iso: string, n: number): string {
  const d = new Date(`${dateOnly(iso)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
