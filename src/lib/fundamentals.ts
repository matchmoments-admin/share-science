/**
 * Fundamentals fetch + backfill for the "Find Similar Shares" feature.
 *
 * EODHD `/api/fundamentals/{symbol}` (10 credits/call) carries everything the factor vector needs:
 * sector/industry, market cap, valuation (PE/PB/PS), profitability (margin/ROE), growth, leverage,
 * beta, description. We upsert those onto the existing `securities` row (columns added in 0017).
 *
 * Automation-safety (CLAUDE.md): the backfill is BOUNDED per invocation (caps + EODHD budget gate),
 * idempotent (fundamentals_at marks done → never re-paid), fails per-symbol without aborting the run,
 * and aborts cleanly on an account-level EODHD error so a quota/auth failure can't hammer N symbols.
 */
import type { Env, Security } from '../types.js';
import { nowISO, logOps } from './db.js';
import { eodhdSymbol, EodhdAccountError } from './prices.js';
import { recordEodhdCall, eodhdWithinBudget } from './usage.js';
import { US_UNIVERSE } from './universe.js';

const ACCOUNT_LEVEL_STATUSES = new Set([401, 402, 403]);
const MAX_BACKFILL_PER_RUN = 60; // bound EODHD spend/run (60 × 10 credits = 600, far under the daily cap)

export interface Fundamentals {
  sector: string | null;
  industry: string | null;
  name: string | null;
  market_cap: number | null;
  pe: number | null;
  pb: number | null;
  ps: number | null;
  profit_margin: number | null;
  roe: number | null;
  rev_growth: number | null;
  debt_equity: number | null;
  beta: number | null;
  description: string | null;
}

/** Defensive numeric coercion — EODHD returns "NA"/null/strings; reject non-finite + zero-placeholders. */
function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(String(v));
  return Number.isFinite(n) ? n : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' && v.trim().toUpperCase() !== 'NA' ? v.trim() : null;
}

/** One EODHD fundamentals call for a security → parsed factor fields. Throws EodhdAccountError on 401/402/403. */
export async function getFundamentals(env: Env, sec: Security): Promise<Fundamentals> {
  if (!env.EODHD_API_KEY) throw new Error('EODHD_API_KEY not set');
  const url = `https://eodhd.com/api/fundamentals/${encodeURIComponent(eodhdSymbol(sec))}?api_token=${env.EODHD_API_KEY}&fmt=json`;
  const resp = await fetch(url);
  await recordEodhdCall(env);
  if (ACCOUNT_LEVEL_STATUSES.has(resp.status)) throw new EodhdAccountError(resp.status);
  if (!resp.ok) throw new Error(`EODHD fundamentals ${eodhdSymbol(sec)} ${resp.status}`);
  const d = (await resp.json()) as Record<string, any>;

  const general = d.General ?? {};
  const highlights = d.Highlights ?? {};
  const valuation = d.Valuation ?? {};
  const technicals = d.Technicals ?? {};

  return {
    sector: str(general.Sector),
    industry: str(general.Industry),
    name: str(general.Name),
    market_cap: num(highlights.MarketCapitalization),
    pe: num(highlights.PERatio),
    pb: num(valuation.PriceBookMRQ),
    ps: num(valuation.PriceSalesTTM),
    profit_margin: num(highlights.ProfitMargin),
    roe: num(highlights.ReturnOnEquityTTM),
    rev_growth: num(highlights.QuarterlyRevenueGrowthYOY),
    debt_equity: debtEquityFrom(d),
    beta: num(technicals.Beta),
    description: str(general.Description),
  };
}

/** Best-effort debt/equity from the latest quarterly balance sheet (null if not present). */
function debtEquityFrom(d: Record<string, any>): number | null {
  const q = d?.Financials?.Balance_Sheet?.quarterly;
  if (!q || typeof q !== 'object') return null;
  const latest = Object.keys(q).sort().pop();
  if (!latest) return null;
  const row = q[latest] ?? {};
  const debt = num(row.totalDebt) ?? ((num(row.shortTermDebt) ?? 0) + (num(row.longTermDebt) ?? 0));
  const equity = num(row.totalStockholderEquity);
  if (!equity || equity === 0 || debt === null) return null;
  return debt / equity;
}

/** Seed the curated US universe into `securities` (idempotent). name=ticker until the backfill names it. */
export async function seedUniverse(env: Env): Promise<{ considered: number; tickers: number }> {
  const tickers = Array.from(new Set(US_UNIVERSE)); // module list has a few intentional dup mega-caps
  const now = nowISO();
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO securities (id, ticker, exchange, isin, name, sec_type, domicile, currency, sector, is_active, created_at)
     VALUES (?, ?, 'US', NULL, ?, 'share', 'US', 'USD', NULL, 1, ?)`,
  );
  for (let i = 0; i < tickers.length; i += 100) {
    const chunk = tickers.slice(i, i + 100);
    await env.DB.batch(chunk.map((t) => stmt.bind(`${t}.US`, t, t, now)));
  }
  await logOps(env, 'cron', { job: 'seedUniverse', tickers: tickers.length });
  return { considered: US_UNIVERSE.length, tickers: tickers.length };
}

/**
 * Backfill fundamentals for US securities that don't have them yet. Bounded per call; budget-gated;
 * idempotent via fundamentals_at. Call repeatedly (admin or queued) until remaining = 0.
 */
export async function backfillFundamentals(env: Env, limit = MAX_BACKFILL_PER_RUN): Promise<{ processed: number; updated: number; remaining: number; aborted?: string }> {
  const cap = Math.min(Math.max(1, limit), MAX_BACKFILL_PER_RUN);
  const todo = (await env.DB.prepare(
    `SELECT id, ticker, exchange, isin, name, sec_type, domicile, currency, is_active
       FROM securities WHERE exchange = 'US' AND fundamentals_at IS NULL ORDER BY id LIMIT ?`,
  ).bind(cap).all<Security>()).results ?? [];

  let processed = 0;
  let updated = 0;
  let aborted: string | undefined;
  const now = nowISO();
  for (const sec of todo) {
    if (!(await eodhdWithinBudget(env))) { aborted = 'eodhd_budget'; break; }
    try {
      const f = await getFundamentals(env, sec);
      await env.DB.prepare(
        `UPDATE securities SET sector = ?, industry = ?, market_cap = ?, pe = ?, pb = ?, ps = ?,
           profit_margin = ?, roe = ?, rev_growth = ?, debt_equity = ?, beta = ?, description = ?,
           name = COALESCE(?, name), fundamentals_at = ? WHERE id = ?`,
      ).bind(
        f.sector, f.industry, f.market_cap, f.pe, f.pb, f.ps,
        f.profit_margin, f.roe, f.rev_growth, f.debt_equity, f.beta, f.description,
        f.name, now, sec.id,
      ).run();
      processed++;
      if (f.sector || f.market_cap) updated++;
    } catch (err) {
      if (err instanceof EodhdAccountError) { aborted = `eodhd_${err.message}`; break; } // account-wide → stop
      // per-symbol failure: stamp fundamentals_at so we don't re-pay a permanently-bad symbol, log it.
      await env.DB.prepare('UPDATE securities SET fundamentals_at = ? WHERE id = ?').bind(now, sec.id).run();
      await logOps(env, 'warn', { at: 'backfillFundamentals', sec: sec.id, err: String(err) });
      processed++;
    }
  }

  const remaining = (await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM securities WHERE exchange = 'US' AND fundamentals_at IS NULL`,
  ).first<{ n: number }>())?.n ?? 0;

  await logOps(env, 'cron', { job: 'backfillFundamentals', processed, updated, remaining, aborted });
  return { processed, updated, remaining, aborted };
}
