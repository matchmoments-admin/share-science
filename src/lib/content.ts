/**
 * Weekly newsletter draft. Deterministic facts pack from the ledger → Claude drafts factual copy
 * → assertFactual() gate (report-not-recommend) → store HTML in R2 for manual paste into beehiiv.
 * Direct beehiiv API push is deferred (needs creds); founder reviews + sends the stored draft.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { Env } from '../types.js';
import { nowISO, logOps } from './db.js';
import { withinBudget, recordSpend } from './usage.js';
import { assertFactual, checkFactual } from './advisory.js';
import { HYPOTHETICAL_NOTE } from './render.js';
import { configured as beehiivConfigured, createPostDraft } from './beehiiv.js';

const DRAFT_BUDGET_CENTS = 10;
const DEFAULT_MODEL = 'claude-opus-4-8';
// Public-leaderboard visibility floor — mirror of MIN_PUBLIC_TIPS in pages.ts so the newsletter
// never surfaces a source the public site suppresses. Keep in sync.
const MIN_PUBLIC_TIPS = 5;
// We feature ~3 named shares per issue (settled outcomes first, then newest still-pending tips).
const FEATURED_TARGET = 3;

// Per-1M-token cents by model, so the spend ledger reflects what actually ran (not a hardcoded tier).
const MODEL_RATES: Record<string, { in: number; out: number }> = {
  'claude-haiku-4-5': { in: 100, out: 500 },
  'claude-opus-4-8': { in: 500, out: 2500 },
};
function modelRate(model: string): { in: number; out: number } {
  return MODEL_RATES[model] ?? MODEL_RATES['claude-opus-4-8']; // unknown → conservative (highest) rate
}

interface ResolvedCall { tie_back_id: string; ticker: string; source: string; direction: string; return_pct: number | null; excess_pct: number | null; is_hit: number | null; horizon_days?: number; as_of?: string }

/** A share featured in "This Week's Three". status='settled' has a real benchmark-based outcome;
 * status='pending' is a newly-tracked call whose outcome hasn't settled yet (honest, no metric). */
export interface FeaturedShare {
  ticker: string; source: string; direction: string;
  status: 'settled' | 'pending';
  return_pct: number | null; excess_pct: number | null; is_hit: number | null;
  horizon_days: number | null; detected_at: string | null;
}

export interface FactsPack {
  week: string;
  generated_at: string;
  featured: FeaturedShare[];        // ~3 named shares: settled outcomes first, then newest pending
  top_sources: Array<{ tie_back_id: string; name: string; tier: string; n_tips: number; hit_rate: number; score_lower: number }>;
  settled_this_week: ResolvedCall[];// real outcomes that settled in the last 7d (ANY horizon)
  closed_this_week: ResolvedCall[]; // positions that completed their full 365d evaluation this week
  opened_this_week: Array<{ tie_back_id: string; ticker: string; source: string; direction: string; detected_at: string }>;
  // Recurring weekly franchises. Any may be null/empty in a quiet week.
  called_it: ResolvedCall | null;   // strongest settled call this week (highest alpha)
  blew_it: ResolvedCall | null;     // weakest settled call this week (lowest alpha) — only when >=2 settled
  dollar_journey: { nav_index: number; week_ago_index: number | null; change_pct: number | null; as_of: string } | null;
  horizon_report: Array<{ horizon_days: number; n_tips: number; hit_rate: number; avg_excess_pct: number }>;
}

/** ISO-ish week label YYYY-Www based on a date (UTC). */
export function isoWeek(d = new Date()): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((date.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export async function assembleFactsPack(env: Env, week = isoWeek()): Promise<FactsPack> {
  const top = (await env.DB.prepare(
    `SELECT sr.source_id AS tie_back_id, s.name, sr.tier, sr.n_tips, sr.hit_rate, sr.score_lower
       FROM source_ratings sr JOIN sources s ON s.id = sr.source_id
      WHERE sr.dimension = 'horizon:90' AND sr.n_tips >= ${MIN_PUBLIC_TIPS} ORDER BY sr.rank ASC LIMIT 5`,
  ).all()).results as FactsPack['top_sources'] ?? [];

  // Real per-share OUTCOMES at ANY horizon (30/90/365) — not only 365d closes. is_hit IS NOT NULL
  // guarantees a benchmark-based hit/miss (honest metric). Ordered by recency of settlement so the
  // FEATURE pool surfaces both freshly-matured forward tips AND backfilled history (whose horizons
  // settled at past dates) — a strict 7-day window would miss backfilled outcomes entirely.
  const settledPool = (await env.DB.prepare(
    `SELECT t.id AS tie_back_id, sec.ticker, s.name AS source, t.direction,
            tr.return_pct, tr.excess_pct, tr.is_hit, tr.horizon_days, tr.as_of
       FROM tip_returns tr JOIN tips t ON t.id = tr.tip_id
       JOIN sources s ON s.id = t.source_id JOIN securities sec ON sec.id = t.security_id
      WHERE tr.is_hit IS NOT NULL ORDER BY tr.as_of DESC LIMIT 30`,
  ).all<ResolvedCall>()).results ?? [];
  // "This week" subset (for the Called It / Blew It franchise only).
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const settled = settledPool.filter((c) => (c.as_of ?? '') >= weekAgo);

  const closed = (await env.DB.prepare(
    `SELECT t.id AS tie_back_id, sec.ticker, s.name AS source, t.direction,
            p.return_pct, p.excess_return_pct AS excess_pct, p.is_hit
       FROM positions p JOIN tips t ON t.id = p.tip_id
       JOIN sources s ON s.id = t.source_id JOIN securities sec ON sec.id = p.security_id
      WHERE p.status = 'closed' AND p.exit_at >= date('now','-7 day') ORDER BY p.exit_at DESC LIMIT 20`,
  ).all<ResolvedCall>()).results ?? [];

  const opened = (await env.DB.prepare(
    `SELECT t.id AS tie_back_id, sec.ticker, s.name AS source, t.direction, t.detected_at
       FROM tips t JOIN sources s ON s.id = t.source_id JOIN securities sec ON sec.id = t.security_id
      WHERE t.security_id IS NOT NULL AND t.detected_at >= date('now','-7 day') ORDER BY t.detected_at DESC LIMIT 20`,
  ).all()).results as FactsPack['opened_this_week'] ?? [];

  // Called It / Blew It — strongest + weakest SETTLED call this week. Only show the contrasting pair
  // when there are >=2 distinct settled outcomes, so a 1-settled week never lists the same row as both.
  const scored = settled.filter((c) => c.excess_pct !== null);
  const called_it = scored.length ? scored.reduce((a, b) => (b.excess_pct! > a.excess_pct! ? b : a)) : null;
  const blew_it = scored.length >= 2 ? scored.reduce((a, b) => (b.excess_pct! < a.excess_pct! ? b : a)) : null;

  // "This Week's Three": settled outcomes first (real metric), then newest still-pending tips
  // (direction only, honestly labelled), de-duped by ticker, capped at FEATURED_TARGET.
  const featured: FeaturedShare[] = [];
  const seen = new Set<string>();
  for (const c of settledPool) {
    if (seen.has(c.ticker)) continue;
    seen.add(c.ticker);
    featured.push({ ticker: c.ticker, source: c.source, direction: c.direction, status: 'settled', return_pct: c.return_pct, excess_pct: c.excess_pct, is_hit: c.is_hit, horizon_days: c.horizon_days ?? null, detected_at: null });
    if (featured.length >= FEATURED_TARGET) break;
  }
  for (const o of opened) {
    if (featured.length >= FEATURED_TARGET) break;
    if (seen.has(o.ticker)) continue;
    seen.add(o.ticker);
    featured.push({ ticker: o.ticker, source: o.source, direction: o.direction, status: 'pending', return_pct: null, excess_pct: null, is_hit: null, horizon_days: null, detected_at: o.detected_at });
  }

  // The $1,000 Journey — latest NAV vs ~7 days ago.
  const navNow = await env.DB.prepare(
    `SELECT as_of, nav_index FROM portfolio_nav WHERE scope = 'all' ORDER BY as_of DESC LIMIT 1`,
  ).first<{ as_of: string; nav_index: number }>();
  const navWeekAgo = await env.DB.prepare(
    `SELECT nav_index FROM portfolio_nav WHERE scope = 'all' AND as_of <= date('now','-7 day') ORDER BY as_of DESC LIMIT 1`,
  ).first<{ nav_index: number }>();
  const dollar_journey = navNow
    ? {
        nav_index: navNow.nav_index,
        week_ago_index: navWeekAgo?.nav_index ?? null,
        change_pct: navWeekAgo?.nav_index ? navNow.nav_index / navWeekAgo.nav_index - 1 : null,
        as_of: navNow.as_of,
      }
    : null;

  // Horizon Report — settled win rates by horizon.
  const horizon_report = (await env.DB.prepare(
    `SELECT horizon_days, COUNT(*) AS n_tips,
            CAST(SUM(is_hit) AS REAL) / COUNT(*) AS hit_rate, AVG(excess_pct) AS avg_excess_pct
       FROM tip_returns WHERE is_hit IS NOT NULL GROUP BY horizon_days ORDER BY horizon_days`,
  ).all()).results as FactsPack['horizon_report'] ?? [];

  return {
    week, generated_at: nowISO(), featured, top_sources: top,
    settled_this_week: settled, closed_this_week: closed, opened_this_week: opened,
    called_it, blew_it, dollar_journey, horizon_report,
  };
}

export async function draftDigest(env: Env, pack: FactsPack): Promise<{ text: string; costCents: number }> {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.DIGEST_MODEL || env.EXTRACT_MODEL || DEFAULT_MODEL;
  const msg = await client.messages.create({
    model,
    max_tokens: 1500,
    system:
      'You write a weekly newsletter for "share-science", which empirically tracks how public ' +
      'share tips perform vs the market. STRICT RULES: report only the facts in the provided JSON. ' +
      'Backward-looking and factual ONLY. Never tell the reader to buy, sell, or hold; never call ' +
      'anything a "pick" or "best"; never predict; never use numbers not present in the JSON. Plain, ' +
      'concise prose. Lead with the section "This Week\'s Three": enumerate EACH item in featured[] — ' +
      'state the source (tipster), the direction (bullish/bearish), and the share (ticker). For a ' +
      'featured item with status "settled", report its realistic outcome at its horizon_days using the ' +
      'is_hit field as the authoritative verdict (is_hit=1 -> "a hit", is_hit=0 -> "a miss"). ' +
      'CRITICAL — read the verdict THROUGH the direction so it never reads as a contradiction: a ' +
      'BULLISH (buy) call wins when the share RISES / beats the benchmark; a BEARISH (sell) call wins ' +
      'when the share FALLS / underperforms. So for a bearish call where the share went UP or BEAT the ' +
      'benchmark, state plainly that the call MISSED BECAUSE the share rose/outperformed (do NOT present ' +
      'a positive return or positive excess_pct as if it vindicated a sell call). Quote return_pct and ' +
      'excess_pct vs the benchmark as the evidence, but always tie the hit/miss to whether the share ' +
      'moved the way the call expected. For status "pending", say it was newly tracked (around ' +
      'detected_at) and its outcome has not settled yet — NEVER invent or imply an outcome for a ' +
      'pending share. Then add these recurring sections, ' +
      'omitting any whose data is absent: "The Leaderboard" (top_sources), "Called It / Blew It" ' +
      '(called_it = strongest settled call by alpha, blew_it = weakest — describe outcomes, do not ' +
      'praise or criticise the source; if blew_it is null, omit it), "The $1,000 Journey" ' +
      '(dollar_journey: an index off a $1,000 base = the equal-weighted AVERAGE return across all ' +
      'tracked calls, not a single compounding portfolio — describe as a hypothetical average, never a ' +
      'real or guaranteed portfolio), "The Horizon Report" (horizon_report win rates by holding period). ' +
      'Every figure is a paper-traded (hypothetical) outcome — never imply real money was invested or ' +
      'that results are guaranteed. End with one neutral line: "General information only — hypothetical, ' +
      'paper-traded outcomes, not advice."',
    messages: [{ role: 'user', content: `Write this week's issue from these facts:\n\n${JSON.stringify(pack, null, 2)}` }],
  });
  const rate = modelRate(model);
  const costCents = (msg.usage.input_tokens / 1e6) * rate.in + (msg.usage.output_tokens / 1e6) * rate.out;
  const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
  return { text, costCents };
}

/** Assemble → draft → assertFactual → store HTML in R2. Returns the stored key + verdict. */
export async function generateAndStoreDigest(env: Env, week = isoWeek(), force = false): Promise<{ ok: boolean; week: string; key?: string; reason?: string }> {
  const key = `digests/${week}.html`;
  // Idempotent per week: if this week's draft already exists, return it WITHOUT re-paying for an
  // identical Opus/Haiku draft. The weekly cron, /admin/run-weekly, and any re-run all hit the cache.
  // Pass force=true (e.g. ?force=1) to deliberately regenerate after more outcomes settle.
  if (!force) {
    const existing = await env.RAW_MEDIA.head(key);
    if (existing) {
      await logOps(env, 'publish', { week, key, skipped: 'already_drafted' });
      return { ok: true, week, key, reason: 'cached' };
    }
  }
  if (!(await withinBudget(env, DRAFT_BUDGET_CENTS))) {
    await logOps(env, 'publish', { skipped: 'over_budget', week });
    return { ok: false, week, reason: 'over_budget' };
  }
  const pack = await assembleFactsPack(env, week);
  // Quiet-week guard: don't pay to draft (or ship) an empty issue. Need at least one featured share
  // OR a populated franchise (leaderboard / horizon report) to have something honest to say.
  if (pack.featured.length === 0 && pack.top_sources.length === 0 && pack.horizon_report.length === 0) {
    await logOps(env, 'publish', { week, skipped: 'quiet_week_no_content' });
    return { ok: false, week, reason: 'quiet_week_no_content' };
  }
  const { text, costCents } = await draftDigest(env, pack);
  await recordSpend(env, costCents);

  const verdict = checkFactual(text);
  if (!verdict.ok) {
    await logOps(env, 'compliance', { week, blocked: 'advice_language', violations: verdict.violations });
    return { ok: false, week, reason: `advice_language: ${verdict.violations.join(', ')}` };
  }
  assertFactual(text); // belt-and-suspenders

  const html = `<!doctype html><meta charset="utf-8"><title>share-science ${week}</title>` +
    `<article style="font:16px/1.6 system-ui;max-width:680px;margin:2rem auto">` +
    text.split('\n').map((p) => (p.trim() ? `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>` : '')).join('') +
    `<hr><p style="font-size:.8rem;opacity:.7">${HYPOTHETICAL_NOTE.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>` +
    `</article>`;
  await env.RAW_MEDIA.put(key, html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
  await logOps(env, 'publish', { week, key, featured: pack.featured.length, settled: pack.settled_this_week.length, top_sources: pack.top_sources.length });
  return { ok: true, week, key };
}

/**
 * Push the stored weekly digest to beehiiv as a DRAFT for the founder to review + send (never
 * auto-sends). Re-checks the factual gate on the stored copy, is idempotent on `week`, and degrades
 * gracefully: if beehiiv post-creation isn't available (Enterprise beta), it records the failure and
 * the R2 draft remains for a manual paste.
 */
export async function publishDigestToBeehiiv(env: Env, week = isoWeek()): Promise<{ ok: boolean; week: string; post_id?: string; reason?: string }> {
  const existing = await env.DB.prepare('SELECT beehiiv_post_id, status FROM digest_publications WHERE week = ?')
    .bind(week).first<{ beehiiv_post_id: string | null; status: string }>();
  if (existing?.status === 'drafted') return { ok: true, week, post_id: existing.beehiiv_post_id ?? undefined };

  if (!beehiivConfigured(env)) return { ok: false, week, reason: 'not_configured' };

  const obj = await env.RAW_MEDIA.get(`digests/${week}.html`);
  if (!obj) return { ok: false, week, reason: 'no_draft' };
  const html = await obj.text();

  const verdict = checkFactual(html);
  if (!verdict.ok) {
    await logOps(env, 'compliance', { week, blocked: 'advice_language_on_publish', violations: verdict.violations });
    return { ok: false, week, reason: `advice_language: ${verdict.violations.join(', ')}` };
  }

  const res = await createPostDraft(env, `share-science — ${week}`, html);
  const status = res.ok ? 'drafted' : 'failed';
  await env.DB.prepare(
    `INSERT OR REPLACE INTO digest_publications (week, beehiiv_post_id, status, detail, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(week, res.id ?? null, status, res.ok ? null : `${res.status}: ${res.error ?? ''}`.slice(0, 300), nowISO()).run();
  await logOps(env, 'publish', { week, beehiiv: status, post_id: res.id, err: res.ok ? undefined : res.error });

  return res.ok ? { ok: true, week, post_id: res.id } : { ok: false, week, reason: `beehiiv_error_${res.status}` };
}
