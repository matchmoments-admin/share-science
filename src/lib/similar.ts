/**
 * Similarity engine for "Find Similar Shares" — precomputed by the weekly Cron, so a user lookup
 * is a zero-cost DB read. Two transparent signals, fused:
 *
 *  (a) FUNDAMENTAL factor nearest-neighbour — per security a vector of [size, valuation, growth,
 *      profitability, leverage, beta], z-scored *within sector* (winsorized so mega-caps don't
 *      dominate), compared by cosine. Sector is the coarse gate; the factor vector is the rank.
 *      Cost: ZERO external calls (pure D1 + math) — safe to run every week.
 *  (b) CORRELATION co-movement — trailing ~1y daily-return correlation from getAdjCloseSeries.
 *      Bounded per run + EODHD-budget-gated (one series fetch per security).
 *
 *  Blended = mean of whichever normalised signals exist for a pair. All three methods are written to
 *  `similar_securities` (idempotent full recompute per method). Automation-safety: bounded, budget-
 *  gated, fails per-security, never recommends (this is descriptive "similar to", not "buy instead").
 */
import type { Env, Security } from '../types.js';
import { nowISO, logOps } from './db.js';
import { getAdjCloseSeries } from './prices.js';
import { eodhdWithinBudget } from './usage.js';
import { type FundRow, type Peer, type ClassRow, zScoreGroup, cosine, correlation as pearson, classificationScore } from './similar-math.js';
import { US_UNIVERSE } from './universe.js';

const TOP_N = 12;
const MAX_CORRELATION_SECURITIES = 220; // bound EODHD series fetches per recompute
const CORR_MIN_OVERLAP = 60; // need ≥60 common trading days for a meaningful correlation
// US-market exchanges as stored on securities — legacy seed rows use XNAS/XNYS codes, lazy/universe
// rows use the EODHD 'US' code. prices.ts maps all of these to the same `.US` symbol, so similarity
// must treat them as one market (else liquid legacy names like NVDA/AAPL silently drop out).
const US_EXCHANGES = `('US','XNAS','XNYS','ARCX','BATS')`;

/** (a) Fundamental factor cosine NN within sector. Pure D1 + math — no external calls. */
export async function computeFundamentalSimilar(env: Env): Promise<{ securities: number; pairs: number }> {
  const raw = (await env.DB.prepare(
    `SELECT id, ticker, sector, market_cap,
            pe, pb, ps, profit_margin AS margin, roe, rev_growth AS growth, debt_equity AS de, beta
       FROM securities
      WHERE exchange IN ${US_EXCHANGES} AND sector IS NOT NULL AND market_cap IS NOT NULL`,
  ).all<FundRow & { market_cap: number | null }>()).results ?? [];
  // log-size in JS (don't rely on SQLite's optional log() build flag).
  const rows: FundRow[] = raw.map((r) => ({ ...r, mcap_log: r.market_cap && r.market_cap > 0 ? Math.log(r.market_cap) : null }));

  const bySector = new Map<string, FundRow[]>();
  for (const r of rows) (bySector.get(r.sector) ?? bySector.set(r.sector, []).get(r.sector)!).push(r);

  const peersById = new Map<string, Peer[]>();
  for (const [, members] of bySector) {
    if (members.length < 2) continue;
    const z = zScoreGroup(members);
    for (const a of members) {
      const scored = members
        .filter((b) => b.id !== a.id)
        .map((b) => ({ peer_id: b.id, score: (cosine(z.get(a.id)!, z.get(b.id)!) + 1) / 2 }))
        .sort((x, y) => y.score - x.score)
        .slice(0, TOP_N);
      peersById.set(a.id, scored);
    }
  }
  const pairs = await writeMethod(env, 'fundamental', peersById);
  return { securities: peersById.size, pairs };
}

/** (b) Return-correlation NN within sector. Bounded + EODHD-budget-gated. */
export async function computeCorrelationSimilar(env: Env, asOfISO?: string): Promise<{ securities: number; pairs: number; aborted?: string }> {
  const today = (asOfISO ?? nowISO()).slice(0, 10);
  const from = isoMinusDays(today, 400);
  // Candidate universe = the curated liquid seed set ∪ anything with fundamentals (post-upgrade the
  // sector gate + fundamental blend kick in automatically). Correlation only needs EOD prices, which
  // are in-plan today, so this method ships without the (plan-gated) fundamentals API.
  const universeIds = new Set(US_UNIVERSE.map((t) => `${t}.US`));
  const all = (await env.DB.prepare(
    `SELECT id, ticker, exchange, isin, name, sec_type, domicile, currency, is_active, sector, market_cap
       FROM securities WHERE exchange IN ${US_EXCHANGES} AND is_active = 1 ORDER BY id`,
  ).all<Security & { sector: string | null; market_cap: number | null }>()).results ?? [];
  const rows = all
    .filter((r) => universeIds.has(r.id) || (r.sector !== null && r.market_cap !== null))
    .slice(0, MAX_CORRELATION_SECURITIES);

  // Fetch each series once (budget-gated). returns[id] = Map<date, logReturn>.
  const series = new Map<string, { sector: string | null; ret: Map<string, number> }>();
  let aborted: string | undefined;
  for (const sec of rows) {
    if (!(await eodhdWithinBudget(env))) { aborted = 'eodhd_budget'; break; }
    try {
      const s = await getAdjCloseSeries(env, sec, from, today);
      const ret = new Map<string, number>();
      for (let i = 1; i < s.bars.length; i++) {
        const prev = s.bars[i - 1].adj;
        const cur = s.bars[i].adj;
        if (prev > 0 && cur > 0) ret.set(s.bars[i].date, Math.log(cur / prev));
      }
      if (ret.size >= CORR_MIN_OVERLAP) series.set(sec.id, { sector: sec.sector, ret });
    } catch (err) {
      await logOps(env, 'warn', { at: 'computeCorrelationSimilar', sec: sec.id, err: String(err) });
    }
  }

  const ids = [...series.keys()];
  const peersById = new Map<string, Peer[]>();
  for (const a of ids) {
    const A = series.get(a)!;
    const scored: Peer[] = [];
    for (const b of ids) {
      if (b === a) continue;
      const B = series.get(b)!;
      if (B.sector !== A.sector) continue; // keep the sector gate consistent with (a)
      const r = pearson(A.ret, B.ret, CORR_MIN_OVERLAP);
      if (r === null) continue;
      scored.push({ peer_id: b, score: (r + 1) / 2 });
    }
    scored.sort((x, y) => y.score - x.score);
    peersById.set(a, scored.slice(0, TOP_N));
  }
  const pairs = await writeMethod(env, 'correlation', peersById);
  await logOps(env, 'cron', { job: 'computeCorrelationSimilar', securities: peersById.size, fetched: series.size, aborted });
  return { securities: peersById.size, pairs, aborted };
}

/**
 * (c) Business-classification NN — from the LLM taxonomy in security_classification. Tiered match
 * (sub-industry > industry > sector) + tag Jaccard. Pure D1 + math — no external calls. Answers
 * "is it the same kind of company?" (drops co-movers that aren't actually in the business).
 */
export async function computeClassificationSimilar(env: Env): Promise<{ securities: number; pairs: number }> {
  const raw = (await env.DB.prepare(
    `SELECT c.security_id, c.sector, c.industry, c.sub_industry, c.business_tags
       FROM security_classification c JOIN securities s ON s.id = c.security_id
      WHERE s.exchange IN ${US_EXCHANGES} AND s.is_active = 1`,
  ).all<{ security_id: string; sector: string | null; industry: string | null; sub_industry: string | null; business_tags: string | null }>()).results ?? [];

  const rows = raw.map((r) => ({
    id: r.security_id,
    cls: { sector: r.sector, industry: r.industry, sub_industry: r.sub_industry, tags: parseTags(r.business_tags) } as ClassRow,
  }));

  const peersById = new Map<string, Peer[]>();
  for (const a of rows) {
    const scored = rows
      .filter((b) => b.id !== a.id)
      .map((b) => ({ peer_id: b.id, score: classificationScore(a.cls, b.cls) }))
      .filter((p) => p.score > 0) // unrelated → drop (don't pad the list with zero-score names)
      .sort((x, y) => y.score - x.score)
      .slice(0, TOP_N);
    if (scored.length) peersById.set(a.id, scored);
  }
  const pairs = await writeMethod(env, 'classification', peersById);
  return { securities: peersById.size, pairs };
}

function parseTags(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Blend the input signals into a 'blended' method. We REWARD CROSS-SIGNAL AGREEMENT: each pair's
 * score = (sum of its scores across the active input signals) / (number of active signals) — so a
 * missing signal counts as 0. A strong co-mover that isn't the same kind of business (in correlation's
 * top-N but absent from classification) is correctly demoted, while a peer that's strong on both rises.
 */
export async function computeBlendedSimilar(env: Env): Promise<{ securities: number; pairs: number }> {
  const rows = (await env.DB.prepare(
    `SELECT security_id, peer_id, method, score
       FROM similar_securities WHERE method IN ('fundamental','correlation','classification')`,
  ).all<{ security_id: string; peer_id: string; method: string; score: number }>()).results ?? [];

  const k = new Set(rows.map((r) => r.method)).size || 1; // # of active input signals
  const acc = new Map<string, Map<string, number>>(); // security_id → (peer_id → summed score)
  for (const r of rows) {
    let m = acc.get(r.security_id);
    if (!m) { m = new Map(); acc.set(r.security_id, m); }
    m.set(r.peer_id, (m.get(r.peer_id) ?? 0) + r.score);
  }

  const peersById = new Map<string, Peer[]>();
  for (const [securityId, m] of acc) {
    const arr = [...m.entries()]
      .map(([peer_id, sum]) => ({ peer_id, score: sum / k }))
      .sort((x, y) => y.score - x.score)
      .slice(0, TOP_N);
    peersById.set(securityId, arr);
  }
  const pairs = await writeMethod(env, 'blended', peersById);
  return { securities: peersById.size, pairs };
}

/** Full weekly recompute: fundamental → correlation → classification → blended. */
export async function recomputeSimilar(env: Env): Promise<Record<string, unknown>> {
  const fundamental = await computeFundamentalSimilar(env);
  const correlation = await computeCorrelationSimilar(env);
  const classification = await computeClassificationSimilar(env);
  const blended = await computeBlendedSimilar(env);
  await logOps(env, 'cron', { job: 'recomputeSimilar', fundamental, correlation, classification, blended });
  return { fundamental, correlation, classification, blended };
}

/** Idempotent per-method replace: delete this method's rows, insert the fresh top-N (ranked). */
async function writeMethod(env: Env, method: string, peersById: Map<string, Peer[]>): Promise<number> {
  await env.DB.prepare('DELETE FROM similar_securities WHERE method = ?').bind(method).run();
  const now = nowISO();
  const stmt = env.DB.prepare(
    `INSERT OR REPLACE INTO similar_securities (security_id, peer_id, method, score, rank, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const binds: D1PreparedStatement[] = [];
  for (const [securityId, peers] of peersById) {
    peers.forEach((p, i) => binds.push(stmt.bind(securityId, p.peer_id, method, p.score, i + 1, now)));
  }
  for (let i = 0; i < binds.length; i += 100) await env.DB.batch(binds.slice(i, i + 100));
  return binds.length;
}

function isoMinusDays(dateISO: string, days: number): string {
  const d = new Date(dateISO + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
