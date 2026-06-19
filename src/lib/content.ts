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

interface ResolvedCall { tie_back_id: string; ticker: string; source: string; direction: string; return_pct: number | null; excess_pct: number | null; is_hit: number | null }

export interface FactsPack {
  week: string;
  generated_at: string;
  top_sources: Array<{ tie_back_id: string; name: string; tier: string; n_tips: number; hit_rate: number; score_lower: number }>;
  closed_this_week: ResolvedCall[];
  opened_this_week: Array<{ tie_back_id: string; ticker: string; source: string; direction: string }>;
  // Recurring weekly franchises (Slice 9). Any may be null/empty in a quiet week.
  called_it: ResolvedCall | null;   // strongest resolved call this week (highest alpha)
  blew_it: ResolvedCall | null;     // weakest resolved call this week (lowest alpha)
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
      WHERE sr.dimension = 'horizon:90' ORDER BY sr.rank ASC LIMIT 5`,
  ).all()).results as FactsPack['top_sources'] ?? [];

  const closed = (await env.DB.prepare(
    `SELECT t.id AS tie_back_id, sec.ticker, s.name AS source, t.direction,
            p.return_pct, p.excess_return_pct AS excess_pct, p.is_hit
       FROM positions p JOIN tips t ON t.id = p.tip_id
       JOIN sources s ON s.id = t.source_id JOIN securities sec ON sec.id = p.security_id
      WHERE p.status = 'closed' AND p.exit_at >= date('now','-7 day') ORDER BY p.exit_at DESC LIMIT 20`,
  ).all<ResolvedCall>()).results ?? [];

  const opened = (await env.DB.prepare(
    `SELECT t.id AS tie_back_id, sec.ticker, s.name AS source, t.direction
       FROM tips t JOIN sources s ON s.id = t.source_id JOIN securities sec ON sec.id = t.security_id
      WHERE t.security_id IS NOT NULL AND t.detected_at >= date('now','-7 day') ORDER BY t.detected_at DESC LIMIT 20`,
  ).all()).results as FactsPack['opened_this_week'] ?? [];

  // Called It / Blew It — strongest + weakest resolved call this week (from the rows already fetched).
  const scored = closed.filter((c) => c.excess_pct !== null);
  const called_it = scored.length ? scored.reduce((a, b) => (b.excess_pct! > a.excess_pct! ? b : a)) : null;
  const blew_it = scored.length ? scored.reduce((a, b) => (b.excess_pct! < a.excess_pct! ? b : a)) : null;

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
    week, generated_at: nowISO(), top_sources: top, closed_this_week: closed, opened_this_week: opened,
    called_it, blew_it, dollar_journey, horizon_report,
  };
}

export async function draftDigest(env: Env, pack: FactsPack): Promise<{ text: string; costCents: number }> {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: env.EXTRACT_MODEL || DEFAULT_MODEL,
    max_tokens: 1500,
    system:
      'You write a weekly newsletter for "share-science", which empirically tracks how public ' +
      'share tips perform vs the market. STRICT RULES: report only the facts in the provided JSON. ' +
      'Backward-looking and factual ONLY. Never tell the reader to buy, sell, or hold; never call ' +
      'anything a "pick" or "best"; never predict; never use numbers not present in the JSON. Plain, ' +
      'concise prose. Structure the issue into these recurring sections, omitting any whose data is ' +
      'absent: "The Leaderboard" (top_sources), "Called It / Blew It" (called_it = the strongest ' +
      'resolved call by alpha, blew_it = the weakest — describe outcomes, do not praise or criticise ' +
      'the source), "The $1,000 Journey" (dollar_journey: an index off a $1,000 base = the ' +
      'equal-weighted AVERAGE return across all tracked calls, not a single compounding portfolio — ' +
      'describe it as a hypothetical average, never a real or guaranteed portfolio), "The Horizon Report" ' +
      '(horizon_report win rates by holding period). Every figure is a paper-traded (hypothetical) ' +
      'outcome — never imply real money was invested or that results are guaranteed. End with one ' +
      'neutral line: "General information only — hypothetical, paper-traded outcomes, not advice."',
    messages: [{ role: 'user', content: `Write this week's issue from these facts:\n\n${JSON.stringify(pack, null, 2)}` }],
  });
  const costCents = (msg.usage.input_tokens / 1e6) * 500 + (msg.usage.output_tokens / 1e6) * 2500;
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
  await logOps(env, 'publish', { week, key, top_sources: pack.top_sources.length, closed: pack.closed_this_week.length });
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
