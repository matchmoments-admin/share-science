/**
 * Public read surface — crawlable HTML + a JSON API. Derived returns/alpha only; every payload
 * passes assertNoRawPrices() so raw EODHD prices can never leak while PUBLIC_PRICES=off.
 */
import type { Env } from '../types.js';
import { assertNoRawPrices } from './advisory.js';
import { layout, escapeHtml, pctCell, score, asOf, HYPOTHETICAL_NOTE } from './render.js';

const DEFAULT_DIM = 'horizon:90';
// A source only appears on the PUBLIC leaderboard once it has this many settled tips — a floor that
// prevents ranking anyone on 1-2 lucky calls (the Wilson score already discounts small samples; this
// is the visibility gate on top). Source-selection policy decision, 2026-06-20.
const MIN_PUBLIC_TIPS = 5;
// Publishable leaderboard dimensions. Default stays horizon:90 for backward-compat; `primary`
// scores each tip on its own stated horizon; `conviction:90` weights by stated conviction.
const ALLOWED_DIMS = ['horizon:90', 'horizon:30', 'horizon:365', 'primary', 'conviction:90'];
const DIM_LABELS: Record<string, string> = {
  'horizon:90': '90-day', 'horizon:30': '30-day', 'horizon:365': '365-day',
  primary: 'Primary horizon', 'conviction:90': 'Conviction-weighted (90d)',
};

function resolveDim(dim: string | null | undefined): string {
  return dim && ALLOWED_DIMS.includes(dim) ? dim : DEFAULT_DIM;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300' },
  });
}

// ── Leaderboard ──────────────────────────────────────────────────────
export async function leaderboard(env: Env, dimParam?: string | null): Promise<Response> {
  const dim = resolveDim(dimParam);
  const rows = (await env.DB.prepare(
    `SELECT sr.source_id, s.name AS source_name, sr.tier, sr.n_tips, sr.hit_rate,
            sr.avg_excess_pct, sr.rating_score, sr.score_lower, sr.rank, sr.updated_at
       FROM source_ratings sr JOIN sources s ON s.id = sr.source_id
      WHERE sr.dimension = ? AND sr.n_tips >= ${MIN_PUBLIC_TIPS} ORDER BY sr.rank ASC`,
  ).bind(dim).all()).results ?? [];
  assertNoRawPrices(env, rows);

  const switcher = `<p class="muted">View: ${ALLOWED_DIMS.map((d) =>
    d === dim ? `<b>${escapeHtml(DIM_LABELS[d])}</b>` : `<a href="/leaderboard?dim=${encodeURIComponent(d)}">${escapeHtml(DIM_LABELS[d])}</a>`,
  ).join(' · ')}</p>`;

  const updatedAt = (rows[0] as any)?.updated_at as string | undefined;
  const body = rows.length === 0
    ? '<p class="muted">No rated sources yet on this view — outcomes accrue as tips reach their horizon.</p>'
    : `<table><thead><tr><th>#</th><th>Source</th><th>Tier</th><th>Tips</th><th>Hit rate</th>
         <th>Avg alpha</th><th>Score (lower bound)</th></tr></thead><tbody>
       ${rows.map((r: any) => `<tr>
         <td>${r.rank}</td>
         <td><a href="/sources/${encodeURIComponent(r.source_id)}">${escapeHtml(r.source_name)}</a></td>
         <td><span class="tier">${escapeHtml(r.tier)}</span></td>
         <td>${r.n_tips}</td>
         <td>${(r.hit_rate * 100).toFixed(0)}%</td>
         ${pctCell(r.avg_excess_pct)}
         <td><b>${score(r.score_lower)}</b> <span class="muted">/ ${score(r.rating_score)}</span></td>
       </tr>`).join('')}</tbody></table>
       <p class="muted">Ranked by the lower bound of a 95% confidence interval on hit rate (alpha vs the market
       benchmark), established sources (≥20 settled tips) above provisional — so a small lucky streak
       can't top a long track record. View: ${escapeHtml(DIM_LABELS[dim])}${updatedAt ? ` · ${asOf(updatedAt)}` : ''}.
       <a href="/methodology">How this is calculated</a>.</p>
       <p class="muted">${escapeHtml(HYPOTHETICAL_NOTE)}</p>`;

  return layout('Tip-source leaderboard', `<h1>Who's actually right?</h1>
    <p class="muted">A factual record of how public share tips performed vs the market. Outcomes, not advice.</p>
    ${switcher}${body}`);
}

export async function leaderboardJson(env: Env, dimParam?: string | null): Promise<Response> {
  const dim = resolveDim(dimParam);
  const rows = (await env.DB.prepare(
    `SELECT sr.source_id, s.name AS source_name, sr.dimension, sr.tier, sr.n_tips, sr.n_hits,
            sr.hit_rate, sr.avg_excess_pct, sr.median_excess_pct, sr.rating_score, sr.score_lower,
            sr.score_upper, sr.rank, sr.updated_at
       FROM source_ratings sr JOIN sources s ON s.id = sr.source_id
      WHERE sr.dimension = ? AND sr.n_tips >= ${MIN_PUBLIC_TIPS} ORDER BY sr.rank ASC`,
  ).bind(dim).all()).results ?? [];
  assertNoRawPrices(env, rows);
  return json({
    dimension: dim,
    as_of: (rows[0] as any)?.updated_at ?? null,
    hypothetical: true,
    disclaimer: HYPOTHETICAL_NOTE,
    sources: rows,
  });
}

// ── Methodology ──────────────────────────────────────────────────────
/** Public, static explanation of how outcomes are measured — credibility as a feature. */
export function methodologyPage(): Response {
  return layout('Methodology', `<h1>How we measure outcomes</h1>
    <p class="muted">We score public share tips the same way for everyone, with the rules fixed in
      advance. ${escapeHtml(HYPOTHETICAL_NOTE)}</p>

    <h2>Entry — no look-ahead</h2>
    <p>Every call is timestamped the moment it's detected, and that timestamp is immutable. A tip's
      simulated entry is the <b>open of the first market bar strictly after</b> detection — never the
      same bar, never a back-dated price. A call can't be credited for a move that had already happened
      when it was made.</p>

    <h2>Return — total return, corporate-action adjusted</h2>
    <p>Returns use <b>adjusted</b> closing prices, so splits, dividends and other corporate actions are
      reinvested into the figure (total return). The frozen, unadjusted entry is kept as evidence.</p>

    <h2>Benchmark — measured per tip</h2>
    <p>Each tip is compared against its market benchmark (S&amp;P 500 for US, ASX 200 for AU) over its
      <b>own</b> entry-to-evaluation window — apples-to-apples, not a single index point-to-point number.
      The credibility metric is <b>alpha</b> (excess return vs that benchmark), not raw return: a buy
      "hits" if it beat the market; a sell "hits" if it underperformed it.</p>

    <h2>Leaderboard — confidence-adjusted</h2>
    <p>Sources are ranked by the <b>lower bound of a 95% confidence interval</b> on their hit rate, and
      established sources (≥20 settled tips) always rank above provisional ones. A small lucky streak
      can't top a long track record.</p>

    <h2>Scoring window — keyed to the call's own horizon</h2>
    <p>Each tip is bucketed by its stated horizon (short / swing / buy-and-hold) and scored
      <b>primarily on the window nearest that horizon</b> — 30, 90 or 365 days. Judging a multi-year
      thesis at 30 days, or a "this pops this week" call at a year, would be meaningless. The default
      leaderboard view is the 90-day window; the <a href="/leaderboard?dim=primary">Primary horizon</a>
      view scores every call on its own clock, and other windows are shown as secondary context.</p>

    <h2>Conviction</h2>
    <p>The <a href="/leaderboard?dim=conviction:90">conviction-weighted</a> view counts a source's
      high-conviction calls for more than its throwaway mentions. The confidence interval still uses the
      raw sample, so weighting reflects emphasis — it can't manufacture statistical certainty.</p>

    <h2>Survivorship — losers stay in</h2>
    <p>Delisted, acquired and failed tickers are kept in the record at their last value. Quietly dropping
      losers is exactly what inflates a published track record; we don't.</p>

    <h2>Time to target</h2>
    <p>When a source states an explicit target level, we record whether and <b>how fast</b> the price
      first reached it. We publish the days-to-target, never the target level itself.</p>

    <h2>Risk, not just return</h2>
    <p>For each call we also report <b>max drawdown</b> (the worst peak-to-trough fall on its return
      curve), <b>annualised volatility</b>, and a <b>Sharpe-style ratio</b> of its excess return.
      A high hit rate with violent drawdowns is a different thing from a steady one, and we show both.
      These are derived from the same daily valuations and annualised treating each step as a trading day.</p>

    <h2>The $1,000 journey</h2>
    <p>This is the current mark of <b>$1,000 spread equally across every tracked call</b> — the
      equal-weighted average of each call's return from its own entry, expressed as an index off a
      $1,000 base (not a dollar price). It is a cross-sectional average, not a single compounding
      portfolio, and it moves as new calls enter and existing ones are remarked. Closed and failed
      calls stay in the average, so it can't flatter itself by dropping losers.</p>

    <h2>Currency</h2>
    <p>Returns are currency-neutral ratios, so cross-market comparisons are fair. Any dollar-denominated
      figure states its currency.</p>

    <h2>Finding similar shares</h2>
    <p>The <a href="/similar">Find similar shares</a> tool answers "what else is like this?" for a US-listed
      ticker — reproducibly, not by opinion. It combines two complementary signals into a <b>blended</b> rank:</p>
    <p><b>Price co-movement</b> — how closely each share's daily returns have tracked the one you entered over
      the past ~year (a statistical correlation). Shares that consistently move together tend to share real
      drivers, so this surfaces a stock's genuine market neighbourhood. It measures behaviour, though, so it can
      occasionally include a name from another industry that simply moved in sympathy.</p>
    <p><b>Business class</b> — how closely each company matches by what it actually does: industry, finer
      sub-industry, and business keywords (e.g. a memory-chip maker matches other semiconductor and chip-
      equipment names, and an unrelated industrial that merely co-moved is filtered out). This is the
      "same kind of company" signal. A further measure based on detailed <b>financial characteristics</b>
      (size, valuation, growth, profitability, leverage) switches on if our data plan includes it.</p>
    <p>For each peer we also overlay <b>which tracked tipsters have called it</b> and the best 90-day alpha
      among those calls — connecting peer discovery to our audited track record. This is descriptive,
      factual information about share characteristics and past outcomes. It is <b>not</b> a recommendation,
      and "similar" never means "as good as" or "buy instead".</p>

    <p class="muted">We never publish raw market prices — only derived returns and alpha.</p>`);
}

// ── Portfolio NAV ($1,000 invested) ──────────────────────────────────
/** Public JSON: the cumulative "$1,000 invested across every tracked tip" equity curve. */
export async function navJson(env: Env, scope = 'all'): Promise<Response> {
  const rows = (await env.DB.prepare(
    `SELECT as_of, nav_index, return_pct, n_positions FROM portfolio_nav
      WHERE scope = ? ORDER BY as_of ASC LIMIT 1000`,
  ).bind(scope).all()).results ?? [];
  assertNoRawPrices(env, rows); // nav_index/return_pct are derived indices, never prices
  const latest = rows[rows.length - 1] as any;
  return json({
    scope,
    base: 1000,
    latest: latest ? { as_of: latest.as_of, nav_index: latest.nav_index } : null,
    hypothetical: true,
    disclaimer: HYPOTHETICAL_NOTE,
    series: rows,
  });
}

// ── Source card ──────────────────────────────────────────────────────
export async function sourcePage(env: Env, id: string): Promise<Response> {
  const src = await env.DB.prepare('SELECT id, name, medium, handle FROM sources WHERE id = ?').bind(id).first<any>();
  if (!src) return layout('Not found', '<h1>Source not found</h1>');

  const ratings = (await env.DB.prepare(
    `SELECT dimension, tier, n_tips, n_hits, hit_rate, avg_excess_pct, median_excess_pct, score_lower
       FROM source_ratings WHERE source_id = ? ORDER BY dimension`,
  ).bind(id).all()).results ?? [];

  const tips = (await env.DB.prepare(
    `SELECT t.id, t.direction, t.detected_at, sec.ticker, sec.name AS sec_name,
            tr.horizon_days, tr.return_pct, tr.excess_pct, tr.is_hit
       FROM tips t JOIN securities sec ON sec.id = t.security_id
       LEFT JOIN tip_returns tr ON tr.tip_id = t.id AND tr.horizon_days = 90
      WHERE t.source_id = ? AND t.security_id IS NOT NULL
      ORDER BY t.detected_at DESC LIMIT 100`,
  ).bind(id).all()).results ?? [];
  assertNoRawPrices(env, { ratings, tips });

  const ratingsTable = ratings.length === 0 ? '<p class="muted">No settled outcomes yet.</p>' :
    `<table><thead><tr><th>Horizon</th><th>Tier</th><th>Tips</th><th>Hit rate</th><th>Avg alpha</th><th>Score (LB)</th></tr></thead><tbody>
     ${ratings.map((r: any) => `<tr><td>${escapeHtml(r.dimension.replace('horizon:', ''))}d</td>
       <td><span class="tier">${escapeHtml(r.tier)}</span></td><td>${r.n_tips}</td>
       <td>${(r.hit_rate * 100).toFixed(0)}%</td>${pctCell(r.avg_excess_pct)}<td><b>${score(r.score_lower)}</b></td></tr>`).join('')}
     </tbody></table>`;

  const tipsTable = tips.length === 0 ? '' :
    `<h2>Calls</h2><table><thead><tr><th>Date</th><th>Security</th><th>Call</th><th>90d return</th><th>90d alpha</th><th>Hit?</th></tr></thead><tbody>
     ${tips.map((t: any) => `<tr><td>${escapeHtml((t.detected_at || '').slice(0, 10))}</td>
       <td><a href="/securities/${encodeURIComponent(t.ticker)}">${escapeHtml(t.ticker)}</a></td>
       <td>${escapeHtml(t.direction)}</td>${pctCell(t.return_pct)}${pctCell(t.excess_pct)}
       <td>${t.is_hit === null || t.is_hit === undefined ? '<span class="muted">pending</span>' : t.is_hit ? '✓' : '✗'}
       &nbsp;<a class="muted" href="/tips/${encodeURIComponent(t.id)}">detail</a></td></tr>`).join('')}
     </tbody></table>`;

  return layout(src.name, `<h1>${escapeHtml(src.name)}</h1>
    <p class="muted">${escapeHtml(src.medium)}${src.handle ? ' · ' + escapeHtml(src.handle) : ''}</p>
    ${ratingsTable}${tipsTable}`);
}

// ── Tip outcome ──────────────────────────────────────────────────────
export async function tipPage(env: Env, id: string): Promise<Response> {
  const t = await env.DB.prepare(
    `SELECT t.id, t.direction, t.conviction, t.horizon, t.tip_type, t.detected_at, t.evidence_span, t.status,
            t.target_price_raw, s.id AS source_id, s.name AS source_name, sec.ticker, sec.name AS sec_name
       FROM tips t JOIN sources s ON s.id = t.source_id
       LEFT JOIN securities sec ON sec.id = t.security_id WHERE t.id = ?`,
  ).bind(id).first<any>();
  if (!t) return layout('Not found', '<h1>Tip not found</h1>');

  const returns = (await env.DB.prepare(
    'SELECT horizon_days, return_pct, excess_pct, is_hit, as_of FROM tip_returns WHERE tip_id = ? ORDER BY horizon_days',
  ).bind(id).all()).results ?? [];
  const valCount = await env.DB.prepare('SELECT count(*) AS n FROM validations WHERE tip_id = ?').bind(id).first<{ n: number }>();
  const risk = await env.DB.prepare(
    'SELECT max_drawdown_pct, volatility_pct, sharpe_proxy, target_hit_at, days_to_target FROM positions WHERE tip_id = ?',
  ).bind(id).first<{ max_drawdown_pct: number | null; volatility_pct: number | null; sharpe_proxy: number | null; target_hit_at: string | null; days_to_target: number | null }>();
  const hasTarget = (t.target_price_raw ?? null) !== null;
  // Never expose the raw target price — DELETE the key (not just blank the value: assertNoRawPrices
  // matches on key name, so `target_price_raw: undefined` would still trip the guard) before checking.
  const tPublic: Record<string, unknown> = { ...t };
  delete tPublic.target_price_raw;
  assertNoRawPrices(env, { t: tPublic, returns, risk });

  const retTable = returns.length === 0 ? '<p class="muted">No settled horizons yet — outcomes appear at 30/90/365 days.</p>' :
    `<table><thead><tr><th>Horizon</th><th>Return</th><th>Alpha vs benchmark</th><th>Hit?</th><th>As of</th></tr></thead><tbody>
     ${returns.map((r: any) => `<tr><td>${r.horizon_days}d</td>${pctCell(r.return_pct)}${pctCell(r.excess_pct)}
       <td>${r.is_hit ? '✓' : '✗'}</td><td class="muted">${escapeHtml((r.as_of || '').slice(0, 10))}</td></tr>`).join('')}
     </tbody></table>`;

  const riskLine = risk && (risk.max_drawdown_pct !== null || risk.volatility_pct !== null || risk.sharpe_proxy !== null)
    ? `<p class="muted">Risk: max drawdown ${risk.max_drawdown_pct === null ? '–' : (risk.max_drawdown_pct * 100).toFixed(1) + '%'}
       · volatility ${risk.volatility_pct === null ? '–' : (risk.volatility_pct * 100).toFixed(1) + '%'} ann.
       · Sharpe-proxy ${risk.sharpe_proxy === null ? '–' : risk.sharpe_proxy.toFixed(2)}</p>`
    : '';

  // Time-to-target: report whether/how fast the stated target was reached — never the target price.
  const targetLine = hasTarget
    ? `<p class="muted">Stated price target: ${risk?.days_to_target != null
        ? `reached in ${risk.days_to_target} day${risk.days_to_target === 1 ? '' : 's'}`
        : 'not yet reached'}.</p>`
    : '';

  return layout(`${t.ticker || 'Tip'} — ${t.source_name}`, `<h1>${escapeHtml(t.ticker || '—')} · ${escapeHtml(t.direction)}</h1>
    <p class="muted">Called by <a href="/sources/${encodeURIComponent(t.source_id)}">${escapeHtml(t.source_name)}</a>
      on ${escapeHtml((t.detected_at || '').slice(0, 10))}${t.horizon ? ' · horizon: ' + escapeHtml(t.horizon) : ''}
      ${valCount && valCount.n > 0 ? ` · corroborated by ${valCount.n} other source(s)` : ''}</p>
    ${t.evidence_span ? `<blockquote class="muted">“${escapeHtml(t.evidence_span)}”</blockquote>` : ''}
    ${retTable}${riskLine}${targetLine}`);
}

// ── Security page ────────────────────────────────────────────────────
export async function securityPage(env: Env, ticker: string): Promise<Response> {
  const sec = await env.DB.prepare('SELECT id, ticker, name, exchange FROM securities WHERE ticker = ? LIMIT 1')
    .bind(ticker.toUpperCase()).first<any>();
  if (!sec) return layout('Not found', '<h1>Security not found</h1>');

  const tips = (await env.DB.prepare(
    `SELECT t.id, t.direction, t.detected_at, s.id AS source_id, s.name AS source_name,
            tr.return_pct, tr.excess_pct, tr.is_hit
       FROM tips t JOIN sources s ON s.id = t.source_id
       LEFT JOIN tip_returns tr ON tr.tip_id = t.id AND tr.horizon_days = 90
      WHERE t.security_id = ? ORDER BY t.detected_at DESC LIMIT 100`,
  ).bind(sec.id).all()).results ?? [];
  assertNoRawPrices(env, tips);

  const table = tips.length === 0 ? '<p class="muted">No tracked calls yet.</p>' :
    `<table><thead><tr><th>Date</th><th>Source</th><th>Call</th><th>90d return</th><th>90d alpha</th><th>Hit?</th></tr></thead><tbody>
     ${tips.map((t: any) => `<tr><td>${escapeHtml((t.detected_at || '').slice(0, 10))}</td>
       <td><a href="/sources/${encodeURIComponent(t.source_id)}">${escapeHtml(t.source_name)}</a></td>
       <td>${escapeHtml(t.direction)}</td>${pctCell(t.return_pct)}${pctCell(t.excess_pct)}
       <td>${t.is_hit === null || t.is_hit === undefined ? '<span class="muted">pending</span>' : t.is_hit ? '✓' : '✗'}
       &nbsp;<a class="muted" href="/tips/${encodeURIComponent(t.id)}">detail</a></td></tr>`).join('')}
     </tbody></table>`;

  return layout(`${sec.ticker} — who called it`, `<h1>${escapeHtml(sec.ticker)} <span class="muted">${escapeHtml(sec.name)}</span></h1>
    <p class="muted">${escapeHtml(sec.exchange)}</p>${table}`);
}

// ── Find Similar Shares ──────────────────────────────────────────────
// 'blended' is the synthesis; these are its inputs. Order = display order / default preference.
const SIMILAR_INPUT_METHODS = ['fundamental', 'classification', 'correlation'];
const SIMILAR_METHOD_LABELS: Record<string, string> = {
  blended: 'Blended', fundamental: 'Fundamental factors', classification: 'Business class', correlation: 'Price co-movement',
};

interface PeerRow {
  peer_id: string; score: number; rank: number;
  ticker: string; name: string; sector: string | null;
}
interface Overlay { n_calls: number; n_sources: number; best_alpha: number | null }
interface ClassLabel { sector: string | null; industry: string | null; sub_industry: string | null }

/** "Sector · Sub-industry" (or the best available level) for display; '' when unclassified. */
function classText(c: ClassLabel | undefined): string {
  if (!c) return '';
  const parts = [c.sector, c.sub_industry || c.industry].filter(Boolean);
  return parts.join(' · ');
}

/**
 * Resolve a US security + its precomputed peers. The signal options shown are DATA-DRIVEN: we only
 * offer methods that actually have rows for this security. While the fundamental signal is dark
 * (EODHD plan-gated), the blend == correlation, so we collapse to a single honest "co-movement"
 * option rather than showing redundant/dead choices.
 */
async function loadSimilar(env: Env, ticker: string, methodParam?: string | null): Promise<
  { sec: any; method: string; offered: string[]; peers: PeerRow[]; overlay: Map<string, Overlay>; classes: Map<string, ClassLabel> } | null
> {
  // US-market exchanges as stored (legacy XNAS/XNYS vs the EODHD 'US' code) — must match similar.ts.
  const sec = await env.DB.prepare(
    `SELECT id, ticker, name, sector, exchange FROM securities
      WHERE ticker = ? AND exchange IN ('US','XNAS','XNYS','ARCX','BATS') LIMIT 1`,
  ).bind(ticker.toUpperCase()).first<any>();
  if (!sec) return null;

  const availRows = (await env.DB.prepare(
    'SELECT DISTINCT method FROM similar_securities WHERE security_id = ?',
  ).bind(sec.id).all<{ method: string }>()).results ?? [];
  const avail = new Set(availRows.map((r) => r.method));
  // Offer 'blended' only when ≥2 input signals exist (otherwise blended == its single input — redundant).
  // Then list whichever inputs are present. Default = the first offered (blended when available).
  const inputs = SIMILAR_INPUT_METHODS.filter((m) => avail.has(m));
  const offered = inputs.length >= 2 ? ['blended', ...inputs] : inputs;
  const method = methodParam && offered.includes(methodParam) ? methodParam : (offered[0] ?? 'blended');

  const peers = (await env.DB.prepare(
    `SELECT ss.peer_id, ss.score, ss.rank, sec.ticker, sec.name, sec.sector
       FROM similar_securities ss JOIN securities sec ON sec.id = ss.peer_id
      WHERE ss.security_id = ? AND ss.method = ? ORDER BY ss.rank ASC`,
  ).bind(sec.id, method).all<PeerRow>()).results ?? [];

  const overlay = new Map<string, Overlay>();
  const classes = new Map<string, ClassLabel>();
  if (peers.length) {
    const ids = [sec.id, ...peers.map((p) => p.peer_id)];
    const ph = ids.map(() => '?').join(',');
    // Tipster overlay — for each peer, how many tracked calls + best 90d alpha by any source (derived only).
    const ov = (await env.DB.prepare(
      `SELECT t.security_id, COUNT(DISTINCT t.id) AS n_calls, COUNT(DISTINCT t.source_id) AS n_sources,
              MAX(tr.excess_pct) AS best_alpha
         FROM tips t LEFT JOIN tip_returns tr ON tr.tip_id = t.id AND tr.horizon_days = 90
        WHERE t.security_id IN (${ph}) GROUP BY t.security_id`,
    ).bind(...ids).all<{ security_id: string; n_calls: number; n_sources: number; best_alpha: number | null }>()).results ?? [];
    for (const r of ov) overlay.set(r.security_id, { n_calls: r.n_calls, n_sources: r.n_sources, best_alpha: r.best_alpha });
    // Business-classification labels for the queried security + each peer (the "Semiconductors" tag).
    const cl = (await env.DB.prepare(
      `SELECT security_id, sector, industry, sub_industry FROM security_classification WHERE security_id IN (${ph})`,
    ).bind(...ids).all<{ security_id: string; sector: string | null; industry: string | null; sub_industry: string | null }>()).results ?? [];
    for (const r of cl) classes.set(r.security_id, { sector: r.sector, industry: r.industry, sub_industry: r.sub_industry });
  }
  return { sec, method, offered, peers, overlay, classes };
}

/** Plain-English description of what a similarity signal measures (shown on the page). */
function methodExplain(method: string): string {
  if (method === 'correlation') return "how closely each share's daily price has moved together with it over the past year";
  if (method === 'classification') return 'how closely each company matches it by industry and business type';
  if (method === 'fundamental') return 'how alike each company is on size, valuation, growth, profitability and leverage (compared within its sector)';
  return 'a blend of the available signals — business type and how their prices have moved together';
}

export async function similarPage(env: Env, tickerParam?: string | null, methodParam?: string | null): Promise<Response> {
  const ticker = (tickerParam || '').trim();
  const form = `<form method="get" action="/similar" class="similar-form">
      <input name="ticker" placeholder="Enter a US ticker, e.g. MU" value="${escapeHtml(ticker.toUpperCase())}" />
      <button type="submit">Find similar</button>
    </form>`;
  const intro = `<h1>Find similar shares</h1>
    <p class="muted">Enter a US-listed ticker (e.g. <b>MU</b>) to see shares that have behaved similarly in the
      market — and which tracked tipsters have called them, with how those calls scored. This is descriptive,
      factual information about share characteristics, <b>not</b> a recommendation to buy, sell or switch.</p>${form}`;

  if (!ticker) return layout('Find similar shares', intro +
    `<p class="muted">Try <a href="/similar?ticker=MU">MU</a>, <a href="/similar?ticker=NVDA">NVDA</a>, or <a href="/similar?ticker=JPM">JPM</a>.</p>`);

  const data = await loadSimilar(env, ticker, methodParam);
  if (!data) return layout('Find similar shares', intro +
    `<p class="muted">No US security found for <b>${escapeHtml(ticker.toUpperCase())}</b> in our universe yet.</p>`);
  const { sec, method, offered, peers, overlay, classes } = data;
  assertNoRawPrices(env, { peers, overlay: [...overlay.values()] });
  const secClass = escapeHtml(classText(classes.get(sec.id)) || sec.sector || '');

  if (peers.length === 0) {
    return layout(`Similar to ${sec.ticker}`, intro +
      `<h2>${escapeHtml(sec.ticker)} <span class="muted">${escapeHtml(sec.name)}</span></h2>
       <p class="muted">Similar shares haven't been computed for this security yet — check back after the next refresh.</p>`);
  }

  // Data-driven signal switcher: only methods that actually have data. A single option renders as a
  // plain label (no dead links) so the page is never confusing about what it's showing.
  const switcher = offered.length <= 1
    ? `<p class="muted">Signal: <b>${escapeHtml(SIMILAR_METHOD_LABELS[method] || method)}</b> — ${escapeHtml(methodExplain(method))}.</p>`
    : `<p class="muted">Signal: ${offered.map((m) =>
        m === method ? `<b>${escapeHtml(SIMILAR_METHOD_LABELS[m])}</b>`
          : `<a href="/similar?ticker=${encodeURIComponent(sec.ticker)}&method=${m}">${escapeHtml(SIMILAR_METHOD_LABELS[m])}</a>`,
      ).join(' · ')} · <a href="/methodology">how these are computed</a></p>`;

  const rowsHtml = peers.map((p) => {
    const o = overlay.get(p.peer_id);
    const tipster = o && o.n_calls > 0
      ? `${o.n_calls} call${o.n_calls === 1 ? '' : 's'} · ${o.n_sources} source${o.n_sources === 1 ? '' : 's'}` +
        (o.best_alpha !== null ? ` · best 90d alpha ${(o.best_alpha * 100).toFixed(1)}%` : '')
      : '<span class="muted">no tracked calls</span>';
    return `<tr>
      <td>${p.rank}</td>
      <td><a href="/securities/${encodeURIComponent(p.ticker)}">${escapeHtml(p.ticker)}</a></td>
      <td>${escapeHtml(p.name)}</td>
      <td class="muted">${escapeHtml(classText(classes.get(p.peer_id)) || p.sector || '—')}</td>
      <td>${score(p.score * 100)}</td>
      <td>${tipster} ${o && o.n_calls > 0 ? `<a class="muted" href="/securities/${encodeURIComponent(p.ticker)}">view</a>` : ''}</td>
    </tr>`;
  }).join('');

  return layout(`Similar to ${sec.ticker}`, intro +
    `<h2>Shares similar to ${escapeHtml(sec.ticker)} <span class="muted">${escapeHtml(sec.name)}${secClass ? ' · ' + secClass : ''}</span></h2>
     ${switcher}
     <table><thead><tr><th>#</th><th>Ticker</th><th>Company</th><th>Sector / industry</th>
       <th>Similarity</th><th>Tracked tipster calls</th></tr></thead><tbody>${rowsHtml}</tbody></table>
     <p class="muted"><b>Similarity</b> is a 0–100 index of ${escapeHtml(methodExplain(method))} (higher = more alike).
       The <b>Tracked tipster calls</b> column shows how many tracked public calls each peer has, from how many
       sources, and the best 90-day alpha among them — historical, measured outcomes (click a ticker to see who
       called it). <a href="/methodology">How this is computed</a>.</p>
     <p class="muted">${escapeHtml(HYPOTHETICAL_NOTE)} This is general information about share characteristics, not a
       recommendation to buy, sell, or switch between any securities.</p>`);
}

export async function similarJson(env: Env, tickerParam?: string | null, methodParam?: string | null): Promise<Response> {
  const ticker = (tickerParam || '').trim();
  if (!ticker) return json({ error: 'missing ?ticker=' }, 400);
  const data = await loadSimilar(env, ticker, methodParam);
  if (!data) return json({ error: 'not_found', ticker: ticker.toUpperCase() }, 404);
  const { sec, method, peers, overlay, classes } = data;
  const out = peers.map((p) => {
    const o = overlay.get(p.peer_id);
    const c = classes.get(p.peer_id);
    return {
      ticker: p.ticker, name: p.name, rank: p.rank,
      sector: c?.sector ?? p.sector, industry: c?.industry ?? null, sub_industry: c?.sub_industry ?? null,
      similarity: Math.round(p.score * 1000) / 10, // 0..100, 1dp
      tipster: { n_calls: o?.n_calls ?? 0, n_sources: o?.n_sources ?? 0, best_90d_alpha_pct: o?.best_alpha ?? null },
    };
  });
  assertNoRawPrices(env, out);
  const qc = classes.get(sec.id);
  return json({
    query: { ticker: sec.ticker, name: sec.name, sector: qc?.sector ?? sec.sector, industry: qc?.industry ?? null, sub_industry: qc?.sub_industry ?? null }, method,
    hypothetical: true, disclaimer: HYPOTHETICAL_NOTE, peers: out,
  });
}
