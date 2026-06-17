/**
 * Public read surface — crawlable HTML + a JSON API. Derived returns/alpha only; every payload
 * passes assertNoRawPrices() so raw EODHD prices can never leak while PUBLIC_PRICES=off.
 */
import type { Env } from '../types.js';
import { assertNoRawPrices } from './advisory.js';
import { layout, escapeHtml, pctCell, score } from './render.js';

const DEFAULT_DIM = 'horizon:90';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300' },
  });
}

// ── Leaderboard ──────────────────────────────────────────────────────
export async function leaderboard(env: Env): Promise<Response> {
  const rows = (await env.DB.prepare(
    `SELECT sr.source_id, s.name AS source_name, sr.tier, sr.n_tips, sr.hit_rate,
            sr.avg_excess_pct, sr.rating_score, sr.score_lower, sr.rank
       FROM source_ratings sr JOIN sources s ON s.id = sr.source_id
      WHERE sr.dimension = ? ORDER BY sr.rank ASC`,
  ).bind(DEFAULT_DIM).all()).results ?? [];
  assertNoRawPrices(env, rows);

  const body = rows.length === 0
    ? '<p class="muted">No rated sources yet — outcomes accrue as tips reach their 90-day mark.</p>'
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
       can't top a long track record. Horizon: 90 days.</p>`;

  return layout('Tip-source leaderboard', `<h1>Who's actually right?</h1>
    <p class="muted">A factual record of how public share tips performed vs the market. Outcomes, not advice.</p>${body}`);
}

export async function leaderboardJson(env: Env): Promise<Response> {
  const rows = (await env.DB.prepare(
    `SELECT sr.source_id, s.name AS source_name, sr.dimension, sr.tier, sr.n_tips, sr.n_hits,
            sr.hit_rate, sr.avg_excess_pct, sr.median_excess_pct, sr.rating_score, sr.score_lower,
            sr.score_upper, sr.rank
       FROM source_ratings sr JOIN sources s ON s.id = sr.source_id
      WHERE sr.dimension = ? ORDER BY sr.rank ASC`,
  ).bind(DEFAULT_DIM).all()).results ?? [];
  assertNoRawPrices(env, rows);
  return json({ dimension: DEFAULT_DIM, sources: rows });
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
    `SELECT t.id, t.direction, t.conviction, t.horizon, t.detected_at, t.evidence_span, t.status,
            s.id AS source_id, s.name AS source_name, sec.ticker, sec.name AS sec_name
       FROM tips t JOIN sources s ON s.id = t.source_id
       LEFT JOIN securities sec ON sec.id = t.security_id WHERE t.id = ?`,
  ).bind(id).first<any>();
  if (!t) return layout('Not found', '<h1>Tip not found</h1>');

  const returns = (await env.DB.prepare(
    'SELECT horizon_days, return_pct, excess_pct, is_hit, as_of FROM tip_returns WHERE tip_id = ? ORDER BY horizon_days',
  ).bind(id).all()).results ?? [];
  const valCount = await env.DB.prepare('SELECT count(*) AS n FROM validations WHERE tip_id = ?').bind(id).first<{ n: number }>();
  assertNoRawPrices(env, { t, returns });

  const retTable = returns.length === 0 ? '<p class="muted">No settled horizons yet — outcomes appear at 30/90/365 days.</p>' :
    `<table><thead><tr><th>Horizon</th><th>Return</th><th>Alpha vs benchmark</th><th>Hit?</th><th>As of</th></tr></thead><tbody>
     ${returns.map((r: any) => `<tr><td>${r.horizon_days}d</td>${pctCell(r.return_pct)}${pctCell(r.excess_pct)}
       <td>${r.is_hit ? '✓' : '✗'}</td><td class="muted">${escapeHtml((r.as_of || '').slice(0, 10))}</td></tr>`).join('')}
     </tbody></table>`;

  return layout(`${t.ticker || 'Tip'} — ${t.source_name}`, `<h1>${escapeHtml(t.ticker || '—')} · ${escapeHtml(t.direction)}</h1>
    <p class="muted">Called by <a href="/sources/${encodeURIComponent(t.source_id)}">${escapeHtml(t.source_name)}</a>
      on ${escapeHtml((t.detected_at || '').slice(0, 10))}${t.horizon ? ' · horizon: ' + escapeHtml(t.horizon) : ''}
      ${valCount && valCount.n > 0 ? ` · corroborated by ${valCount.n} other source(s)` : ''}</p>
    ${t.evidence_span ? `<blockquote class="muted">“${escapeHtml(t.evidence_span)}”</blockquote>` : ''}
    ${retTable}`);
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
