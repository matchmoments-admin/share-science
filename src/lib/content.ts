/**
 * Weekly newsletter. Deterministic facts pack from the ledger → deterministic, email-safe HTML
 * (the "Editorial" template, designed in Claude Design) → assertFactual() gate → store in R2 →
 * founder reviews + pushes a beehiiv DRAFT. No LLM in the loop: the issue is structured data, so
 * it renders directly from the facts — $0 per issue, deterministic, and inherently report-not-advice.
 */
import type { Env } from '../types.js';
import { nowISO, logOps } from './db.js';
import { assertFactual, checkFactual } from './advisory.js';
import { escapeHtml } from './render.js';
import { configured as beehiivConfigured, createPostDraft } from './beehiiv.js';

// Public-leaderboard visibility floor — mirror of MIN_PUBLIC_TIPS in pages.ts so the newsletter
// never surfaces a source the public site suppresses. Keep in sync.
const MIN_PUBLIC_TIPS = 5;
// We feature ~3 named shares per issue (settled outcomes first, then newest still-pending tips).
const FEATURED_TARGET = 3;

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

// ── Editorial email renderer (deterministic, email-safe) ─────────────
// Font stacks: custom web fonts (loaded via <link> for clients that honour it, e.g. Apple Mail)
// with robust fallbacks everywhere else. All layout is table-based with inline styles for email.
const F_DISPLAY = "'Saira Condensed','Arial Narrow',Arial,sans-serif";
const F_BODY = "'Public Sans',Arial,sans-serif";
const F_MONO = "'IBM Plex Mono','Courier New',monospace";
const INK = '#1c1b18', PAPER = '#f4f2ec', PAGE = '#d7d4ca', MUTED = '#8d897e', FAINT = '#a09c90', LINE = '#ddd9cf', BODY = '#55524a';
const GREEN = '#2f7d52', RED = '#c0463d';
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

const word = (n: number) => (n >= 0 && n < WORDS.length ? WORDS[n] : String(n));
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const signPct = (frac: number | null) => frac == null ? '—' : `${frac >= 0 ? '+' : '−'}${(Math.abs(frac) * 100).toFixed(2)}%`;
const signPp = (frac: number | null) => frac == null ? '—' : `${frac >= 0 ? '+' : '−'}${(Math.abs(frac) * 100).toFixed(2)} pp`;
const ratePct = (frac: number) => `${(frac * 100).toFixed(2).replace(/\.00$/, '')}%`;
const isBearish = (dir: string) => /sell|bearish|short/i.test(dir);

/** Render the FactsPack as the "Editorial" weekly email (Variation B). Deterministic + factual. */
export function renderDigestHtml(pack: FactsPack, week: string): string {
  const total = pack.featured.length;
  const nSettled = pack.featured.filter((f) => f.status === 'settled').length;
  const eyebrow = `This Week&rsquo;s ${cap(word(total || 0))}`;
  const headline = total === 0 ? 'No calls settled this week.'
    : nSettled === total ? `${cap(word(total))} call${total === 1 ? '' : 's'}<br>have settled.`
    : nSettled === 0 ? `${cap(word(total))} new call${total === 1 ? '' : 's'}<br>tracked.`
    : `${cap(word(total))} calls<br>this week.`;

  const calls = pack.featured.map((c, i) => {
    const n = String(i + 1).padStart(2, '0');
    const dir = isBearish(c.direction) ? 'Bearish' : 'Bullish';
    const action = isBearish(c.direction) ? 'Sell' : 'Buy';
    const settled = c.status === 'settled';
    const res = settled ? (c.is_hit === 1 ? { label: 'Hit', color: GREEN } : { label: 'Miss', color: RED }) : { label: 'Pending', color: FAINT };
    const horizon = c.horizon_days ? `${c.horizon_days}-day` : '';
    const sentence = settled
      ? `${escapeHtml(c.source)}. Settled over a ${horizon} horizon &mdash; returned <strong style="color:${INK};">${signPct(c.return_pct)}</strong>, an excess of <strong style="color:${INK};">${signPp(c.excess_pct)}</strong> versus the benchmark.`
      : `${escapeHtml(c.source)}. Newly tracked${c.detected_at ? ` ${escapeHtml(c.detected_at.slice(0, 10))}` : ''} &mdash; outcome still pending.`;
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:28px; border-top:1px solid ${LINE};"><tr>
      <td style="padding-top:18px; width:64px; vertical-align:top;">
        <div style="font-family:${F_DISPLAY}; font-weight:800; font-size:34px; line-height:0.9; color:#cbc6b9;">${n}</div>
      </td>
      <td style="padding-top:18px; vertical-align:top;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
          <td style="vertical-align:baseline;">
            <span style="font-family:${F_DISPLAY}; font-weight:800; font-size:26px; color:${INK};">${escapeHtml(c.ticker)}</span>
            <span style="font-family:${F_MONO}; font-size:10px; letter-spacing:0.08em; text-transform:uppercase; color:${MUTED}; padding-left:8px;">${dir} &middot; ${action}</span>
          </td>
          <td style="text-align:right; vertical-align:baseline;">
            <span style="font-family:${F_DISPLAY}; font-weight:700; font-size:13px; letter-spacing:0.12em; text-transform:uppercase; color:${INK}; border-bottom:2px solid ${res.color}; padding-bottom:2px;">${res.label}</span>
          </td>
        </tr></table>
        <div style="font-family:${F_BODY}; font-size:13px; line-height:1.55; color:${BODY}; margin-top:12px;">${sentence}</div>
      </td>
    </tr></table>`;
  }).join('');

  const journey = pack.dollar_journey ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:34px; border-top:2px solid ${INK};"><tr>
    <td style="padding-top:22px;">
      <div style="font-family:${F_MONO}; font-size:10px; letter-spacing:0.14em; text-transform:uppercase; color:${FAINT};">The $1,000 Journey</div>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:8px;"><tr>
        <td style="vertical-align:bottom;"><span style="font-family:${F_DISPLAY}; font-weight:800; font-size:68px; line-height:0.85; letter-spacing:-0.02em; color:${INK};">${pack.dollar_journey.nav_index.toFixed(2)}</span></td>
        <td style="vertical-align:bottom; text-align:right;"><span style="font-family:${F_MONO}; font-size:10px; color:${MUTED};">as of ${escapeHtml(pack.dollar_journey.as_of)}</span></td>
      </tr></table>
      <div style="font-family:${F_BODY}; font-size:12px; line-height:1.55; color:#76736a; margin-top:14px;">Average return across all tracked calls, applied to a $1,000 base. An average of paper-traded outcomes &mdash; not a real or guaranteed portfolio.</div>
    </td>
  </tr></table>` : '';

  const horizonRows = pack.horizon_report.map((h) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:12px; border-top:1px solid ${LINE};"><tr>
    <td style="padding-top:12px; vertical-align:baseline;">
      <span style="font-family:${F_DISPLAY}; font-weight:700; font-size:22px; color:${INK};">${h.horizon_days}-day</span>
      <span style="font-family:${F_MONO}; font-size:11px; color:${MUTED}; padding-left:8px;">${h.n_tips} tips &middot; ${ratePct(h.hit_rate)} hit rate</span>
    </td>
    <td style="padding-top:12px; text-align:right; vertical-align:baseline;">
      <span style="font-family:${F_MONO}; font-size:10px; text-transform:uppercase; letter-spacing:0.08em; color:${FAINT};">avg excess&nbsp;&nbsp;</span>
      <span style="font-family:${F_DISPLAY}; font-weight:700; font-size:20px; color:${INK};">${signPp(h.avg_excess_pct)}</span>
    </td>
  </tr></table>`).join('');
  const horizonBlock = pack.horizon_report.length ? `<div style="font-family:${F_MONO}; font-size:10px; letter-spacing:0.14em; text-transform:uppercase; color:${FAINT}; margin-top:34px;">The Horizon Report</div>${horizonRows}` : '';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shareo Weekly &mdash; ${escapeHtml(week)}</title>
<link href="https://fonts.googleapis.com/css2?family=Saira+Condensed:wght@700;800&family=Public+Sans:wght@400;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
</head><body style="margin:0; background:${PAGE};">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${PAGE};"><tr><td align="center" style="padding:32px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px; max-width:600px; background:${PAPER}; border-radius:4px; box-shadow:0 18px 40px rgba(40,38,30,0.18); overflow:hidden;"><tr><td style="padding:40px 44px;">

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-bottom:2px solid ${INK};"><tr>
    <td style="vertical-align:bottom; padding-bottom:12px;"><span style="font-family:${F_DISPLAY}; font-weight:800; font-size:24px; letter-spacing:0.01em; color:${INK};">Shareo</span></td>
    <td style="vertical-align:bottom; text-align:right; padding-bottom:14px;"><span style="font-family:${F_MONO}; font-size:11px; letter-spacing:0.1em; text-transform:uppercase; color:${MUTED};">Weekly &middot; ${escapeHtml(week)}</span></td>
  </tr></table>

  <div style="font-family:${F_MONO}; font-size:10px; letter-spacing:0.14em; text-transform:uppercase; color:${FAINT}; margin-top:30px;">${eyebrow}</div>
  <div style="font-family:${F_DISPLAY}; font-weight:800; font-size:52px; line-height:0.95; letter-spacing:-0.015em; color:${INK}; margin-top:8px;">${headline}</div>

  ${calls}
  ${journey}
  ${horizonBlock}

  <div style="font-family:${F_BODY}; font-size:10.5px; line-height:1.6; color:#9a9689; margin-top:30px; padding-top:18px; border-top:1px solid ${LINE};">General information only. Hypothetical, paper-traded outcomes &mdash; entries are simulated at the first market bar after a call was detected; no real capital is at risk. Past performance is no guarantee of future results.</div>
  <div style="font-family:${F_MONO}; font-size:10px; color:#9a9689; margin-top:14px;">Shareo &middot; Unsubscribe &middot; Manage preferences</div>

</td></tr></table>
</td></tr></table>
</body></html>`;
}

/** Assemble → render the Editorial email → compliance gate → store HTML in R2. Deterministic, no LLM. */
export async function generateAndStoreDigest(env: Env, week = isoWeek(), force = false): Promise<{ ok: boolean; week: string; key?: string; reason?: string }> {
  const key = `digests/${week}.html`;
  // Idempotent per week unless force=true (e.g. ?force=1 after more outcomes settle).
  if (!force) {
    const existing = await env.RAW_MEDIA.head(key);
    if (existing) {
      await logOps(env, 'publish', { week, key, skipped: 'already_drafted' });
      return { ok: true, week, key, reason: 'cached' };
    }
  }
  const pack = await assembleFactsPack(env, week);
  // Quiet-week guard: don't ship an empty issue. Need a featured share OR a populated franchise.
  if (pack.featured.length === 0 && pack.top_sources.length === 0 && pack.horizon_report.length === 0) {
    await logOps(env, 'publish', { week, skipped: 'quiet_week_no_content' });
    return { ok: false, week, reason: 'quiet_week_no_content' };
  }
  const html = renderDigestHtml(pack, week);
  // Belt-and-suspenders: the render is deterministic + factual, but still gate it (e.g. a source name
  // that happened to contain advice language would block rather than ship).
  const verdict = checkFactual(html);
  if (!verdict.ok) {
    await logOps(env, 'compliance', { week, blocked: 'advice_language', violations: verdict.violations });
    return { ok: false, week, reason: `advice_language: ${verdict.violations.join(', ')}` };
  }
  assertFactual(html);

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
