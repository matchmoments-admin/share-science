/**
 * Token-gated admin console. Layout adapts the "Modern" direction from the Claude Design project
 * (rail nav · dark editorial hero · trend chart + posture ring · needs-attention triage · sharer
 * ranking + live activity) but re-skinned entirely with OUR brand tokens (src/lib/theme.ts —
 * warm monochrome paper/ink, Anton display, Hanken body, JetBrains mono) and OUR real data.
 *
 * Auth: POST the ADMIN_TOKEN to /admin/login → HttpOnly+Secure+SameSite=Strict cookie; authed()
 * (index.ts) accepts that cookie OR the x-admin-token header. PRIVATE surface — not a public payload.
 */
import type { Env } from '../types.js';
import { escapeHtml, pct } from './render.js';
import { spentTodayCents, eodhdCallsToday, eodhdCallBudget } from './usage.js';
import { timingSafeEqual, nowISO, dateOnly } from './db.js';
import { BRAND_HEAD } from './theme.js';
import { alpacaMode, tradingPaused, MAX_NOTIONAL_USD } from './alpaca.js';
import { isoWeek } from './content.js';
import { configured as beehiivConfigured } from './beehiiv.js';

const COOKIE = 'ss_admin';
const COOKIE_TTL_S = 8 * 3600;

/** Read the admin session token from the request cookie, if present. */
export function adminCookie(req: Request): string | null {
  const c = req.headers.get('cookie') || '';
  const m = c.match(/(?:^|;\s*)ss_admin=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

// ── Inline icons (stroke, currentColor) ──────────────────────────────
const ICON: Record<string, string> = {
  grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  trend: '<path d="m3 17 6-6 4 4 8-8"/><path d="M14 7h7v7"/>',
  pulse: '<path d="M22 12h-4l-2-7-4 14-2-7H2"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
  gauge: '<path d="M12 14a2 2 0 1 0 .01-3.99M12 14l4-4"/><path d="M5 19a9 9 0 1 1 14 0"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  coins: '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18M7 6h1v4M16.71 13.88l.7.71-2.82 2.82"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  rss: '<path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
};
const icon = (name: string, size = 18) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICON[name] || ''}</svg>`;

// ── Help system ──────────────────────────────────────────────────────
// Plain-English copy for every meaningful field/section, sourced from the real code paths.
// Rendered as a focusable ⓘ that opens a floating tooltip (see shell() CSS + script). Keep
// factual/backward-looking — never advice (CLAUDE.md invariant).
const TIP: Record<string, string> = {
  // posture strip
  'posture-alpaca-mode': "Broker wiring state. OFF: no orders ever placed. PAPER (amber): orders go to Alpaca's simulated sandbox. LIVE (red): real money on every approved trade. Read from a KV override falling back to the deployed default — unreadable KV fails safe, never auto-escalates to LIVE.",
  'posture-paused': 'Shows only when the trading kill-switch is on. While shown, no real order executes and no new live intents are proposed. Unreadable KV also reads as paused — it fails closed. Toggle from the Trading view.',
  'posture-licence': "Public-pricing display flag: 'commercial' when PUBLIC_PRICES=on, else 'personal'. Affects only how public price data is presented — no effect on broker behaviour or money movement.",
  'posture-pending-live': 'Real-money buys (up to $50 each) queued for a human decision. Only appears above zero; click it to open the approvals queue. In PAPER mode intents auto-approve and never queue here.',
  // hero
  'hero-live-badge': "The pulsing dot is cosmetic; the real freshness signal is the date — the as-of of the latest NAV snapshot, which only advances when the daily pass runs. 'hypothetical' means every position is paper-traded. If the date is stale, run the daily pass.",
  'hero-headline': 'If $1,000 had been spread evenly across every tracked tip, this is its value now. It is the NAV index: 1000 × (1 + the equal-weighted average return across all valued positions, open and closed). An index off a $1,000 base, not a real share price.',
  'hero-lede': "Summary line. Calls = resolved tips (matched to a real security), sharers = active sources, and the percent is the share of settled outcomes that beat their market benchmark. Reads 'Outcomes accrue as calls settle' when nothing has settled yet.",
  'herostat-journey': "Current value of the paper $1,000 portfolio (whole dollars). The coloured badge is total return since the $1,000 baseline (green up, red down). 'indexed off $1,000' means it starts at 1000 — an index, not a price.",
  'herostat-hitrate': "Share of settled outcomes that beat their benchmark. The 'settled outcomes' count is tip_returns rows, and one tip yields up to three (30/90/365-day), so it exceeds the number of unique tips. Direction-aware: a buy hits on positive excess, a sell on negative.",
  'herostat-alpha': "Average excess return over benchmark across settled outcomes — each position's own return minus its benchmark's over the same window. +2% means the tips beat their benchmark by 2 points on average. Shows a dash until something settles.",
  // meta strip
  'meta-shares': 'Distinct securities currently tracked. A stock tipped by five people counts once. A coverage/scale figure, not a quality figure.',
  'meta-positions': 'Total paper trades ever opened, and how many are still running. A position closes automatically once its 365-day snapshot lands, so open ones are still marked-to-market daily; closed ones completed their full one-year evaluation.',
  'meta-tips': 'Total tips ingested, and how many were matched to a real security. The gap is tips stuck in the review queue with no position — a large gap means tips are piling up there.',
  'meta-subscribers': "Newsletter signups, and how many have been mirrored into beehiiv. A shortfall of active unsynced signups surfaces as a low-severity Newsletter item below; 'Sync subscribers' clears it.",
  // trend + ring
  'trend-chart': 'The paper $1,000 portfolio over the last 90 daily NAV points. The dashed line is the $1,000 baseline; area above means up, below means down. Equal-weighted across every tracked call and derived from the positions ledger — no live price calls.',
  'ring-hitrate': "Overall share of settled outcomes that beat the market — the same figure as the Hit rate stat. Shows a dash (not 0%) when nothing has settled yet, so you can tell 'all calls missed' from 'no data yet'.",
  'ring-horizon': 'Hit rate split by holding window. Each row shows the settled-outcome count and the percent that beat the benchmark; the dot is green at 50%+, else red. The 365-day row is the strongest long-term signal but has the fewest samples.',
  // needs attention
  'triage-section': "Operational items, highest severity first: Errors and Budget (red), Review and Pipeline (amber), Newsletter (grey). Shows 'All clear' when empty. Each card is clickable — it jumps to where you resolve it.",
  // jobs
  'jobs-section': 'Manual triggers for the background tasks that normally run on a schedule. Each button POSTs to an admin endpoint and dumps the raw result into the box below. The metrics above do NOT live-update — reload the page to see them move.',
  'jobs-spend': "Today's metered AI spend against the daily cap. Counts only LLM tip extraction and weekly digest drafting — market-data and beehiiv calls are unmetered. Resets at 00:00 UTC. At the cap, new AI extraction defers; free jobs keep running.",
  'jobs-eodhd': 'EODHD market-data API calls made today vs the soft daily budget. Daily valuation fetches each security once (cached, so repeat runs cost ~0). If the budget is hit, valuation defers rather than risk blowing the EODHD plan limit. Resets 00:00 UTC.',
  'job-run-daily': 'Opens positions for approved tips, re-prices everything, and recomputes the leaderboard and the $1,000 chart. Uses market data (not budget-metered). Idempotent — safe to click repeatedly. Run it after approving trades or a poll, or when the chart looks stale.',
  'job-poll': "Fetches the latest blogs, Bluesky posts and podcasts and queues any new items. Free (just HTTP). The paid AI extraction runs later in the queue and is what checks the budget — so over budget, polling 'succeeds' but no tips appear. Dedupes by content hash; safe to repeat.",
  'job-backfill': 'One-off cleanup that fills the short/swing/hold label and target horizon on old tips missing it, up to 500 per click. Zero cost, deterministic. If the result says more:true, click again for the next 500. Safe to repeat.',
  'job-sync': 'Pushes up to 100 active, never-synced subscribers to beehiiv and stamps each on success. Free and budget-immune — works even at 100% of the AI cap. Already-synced rows are skipped; click again for more than 100 pending.',
  'job-weekly': 'Generates this week’s digest content (an LLM step — uses budget) and stores it. Run this BEFORE "Publish digest draft", which only publishes an already-generated digest. Idempotent on the week.',
  'job-publish': "Takes the already-generated weekly digest, re-runs the compliance check, and creates a beehiiv DRAFT for human review — it never emails anyone. Returns no_draft if the weekly digest hasn't been generated yet (run 'Generate weekly digest' first). Idempotent on week.",
  'jobs-output': 'Shows the raw response of whichever button you last clicked, or an error. The dashboard numbers above do not refresh from this — a job can succeed here while the chart and leaderboard look unchanged until you reload.',
  // reputation
  'rep-sharers': 'Top sharers ranked by their 90-day confidence-adjusted score, best first. Each row shows name, optional tier badge, a score bar and a lifetime tip count. Top 8 only — "Full board" opens the complete leaderboard.',
  'rep-wilson': 'Ordered by the cautious lower edge of each sharer’s 90-day success-rate confidence interval, not their raw rate. The bound shrinks hard on small samples, so a 5/5 streak scores lower than a long, slightly-less-perfect record — by design, to resist lucky streaks.',
  'rep-tier': "'established' once a sharer has 20+ settled tips in that dimension, else 'provisional'. Every established sharer ranks above every provisional one, ties broken by the Wilson score — so a small perfect sample can never top a long real record.",
  'shares-section': 'The most-tipped tickers by tip volume, top 10. The bar is sized relative to the most-tipped name. Shows which names sharers talk about most — not which performed best.',
  'shares-alpha': "Average excess return over benchmark across this ticker's positions (green positive, red negative). Averaged over all sharers who tipped it, so a high-volume name can still show weak alpha. Dash when no positions have settled.",
  'rep-leaderboard': "Full ranking tables, one per scoring method (dimension). Each shows rank, sharer, settled tips, hit rate, alpha and the confidence score. Shows 'reputation accrues as tips settle' when nothing is rated yet.",
  'rep-col-tips': 'Count of SETTLED tips backing this score in this dimension (not the lifetime count on the bar list). This is what determines whether a sharer crosses the 20-tip "established" threshold.',
  'rep-col-hit': 'Percent of settled calls that beat the market — the plain, uncautioned success rate. Compare with Score to see how much a thin track record is being discounted.',
  'rep-col-alpha': 'Average margin by which calls beat the benchmark, in percent. Hit rate tells you how OFTEN they win; Alpha tells you how BIG the wins or losses are.',
  'rep-col-score': "The confidence-adjusted 0–100 trust score (Wilson lower bound) used to rank the table. Always at or below Hit; when much lower, the sharer simply hasn't settled enough tips to trust the high hit rate yet.",
  'dim:horizon:30': 'Ranking that judges each tip 30 days after it was made.',
  'dim:horizon:90': 'Ranking that judges each tip 90 days after it was made. The bar list and the trade-approval table both key off this dimension.',
  'dim:horizon:365': 'Ranking that judges each tip 365 days after it was made — the strongest long-term signal, but the slowest to fill.',
  'dim:primary': "Judges each tip at the timeframe the sharer intended (the settled window nearest its stated horizon). Tips whose intended window hasn't settled are skipped. The fairest single ranking.",
  'dim:conviction:90': 'A 90-day ranking where higher-conviction tips count for more (high=3, medium=2, low=1) in Hit and Alpha. The Score stays on the raw unweighted sample, so labelling everything high-conviction cannot manufacture statistical confidence.',
  // sources / add-tip
  'src-add': 'Creates a row in the sources table. A tip must reference an existing source (foreign key), so add the source before its first tip. Method picks the pipeline: manual = you paste tips; rss_fulltext / podcast_transcript / bluesky = auto-polled by the hourly cron.',
  'src-list': 'Every source. Pause sets active=0 so the cron stops polling it without deleting history; resume re-enables it.',
  'src-tos': 'The hard ToS gate: an auto-poll source is only ever polled once you have verified its terms of service allow this use and clicked "Mark ToS-checked" (which records who/when/note). Unchecked auto-sources are NOT polled — by design.',
  'src-health': 'Per-source poll health, set by the cron. "ok" + date = last successful fetch; "failing ×N" = N consecutive failed polls (hover for the error) — a dead feed to fix or retire. "Tips" shows lifetime tips and the % that abstained (couldn’t resolve a security).',
  'src-from': 'Forward-only anchor: the source only ingests items published on/after this date (stamped when you ToS-check it), so a new source never pulls its whole back-catalogue. Use Backfill (30d/90d/1y) to deliberately pull bounded history — it ingests + scores past tips look-ahead-free. Podcast backfill transcribes past episodes via Deepgram ($), paced by the daily budget.',
  'tip-add': 'Submits to the same /ingest/human seam the automated pollers use: Claude extracts the call, resolve.ts matches the security (or abstains → review queue), and the daily pass opens a paper position at the first market bar AFTER the publish date.',
  'tip-date': 'The REAL publication date of the tip — this is the look-ahead anchor. Entry price is the first market bar strictly after it, so back-dating to today would fabricate a same-day entry. Rejected if in the future or older than ~3 years.',
  // newsletter
  'nl-subs': 'Active newsletter subscribers (status=active) and how many are mirrored into beehiiv. The daily cron syncs them; “Sync subscribers” forces it now.',
  'nl-actions': 'Generate/regenerate runs the LLM draft (budget-gated, compliance-checked, stored in R2). Preview opens the stored HTML. Push creates a beehiiv DRAFT — it never sends; you review and send inside beehiiv.',
  'nl-failed': 'The beehiiv draft API returned an error (it is Enterprise-beta and may 403). The generated issue is still in R2 — preview it and paste into beehiiv manually.',
  'nl-history': 'The digest_publications ledger: one row per week’s push attempt with beehiiv status (drafted/failed) and post id. A failed push shows its reason instead of failing silently.',
  'newsletter-panel': "The weekly issue's publish state: was this week's digest generated, was a beehiiv DRAFT created (or did it 403), and has it been sent. Nothing auto-sends — you click Send in beehiiv. Subscriber counts are the D1 capture record; beehiiv→D1 reconciliation lands later, so 'active' may over-count until then.",
  'newsletter-failed': 'The beehiiv draft API returned an error (it is Enterprise-beta and may 403). The generated issue is still saved — open the preview, copy the HTML, and paste it into a new beehiiv post manually.',
  // activity
  'activity-feed': "The 7 most recent ops events, newest first, with errors in red. This is the only in-UI place to read error detail — check it when 'Needs attention' flags Errors.",
  // approvals / trading
  'appr-live': 'Real-money buys that passed eligibility and the 0.5 minimum-confidence bar and now await your decision. US-only long (buy) calls. Approve places the order (real money in LIVE mode); Reject leaves the call as paper-only.',
  'appr-failed': "Real orders that were attempted but didn't go through, with the reason. Retry-on-approve isn't built yet — a failed intent stays as paper and can only be dismissed. No money is at risk while it sits here.",
  'appr-review': "Tips whose security couldn't be auto-identified; they have no position and aren't in the money path until resolved. The resolve/add-alias workbench is not built yet (Slice 2) — this is a count only for now.",
  'trade-killswitch': 'Master on/off for ALL real trading. Re-checked per item, so it halts an in-progress sweep too. Fails closed — unreadable KV behaves as paused. The emergency stop: pausing prevents any real order regardless of mode or approvals.',
  'trade-mode': 'Sets the broker connection via a KV override (no redeploy). Off: never call Alpaca. Paper: simulated orders. Live: real orders (needs a funded account + live keys, else they fail as not_configured). Each is confirm-gated.',
  'exp-pending': "Proposed real trades awaiting your approve/reject decision — potential real spend that hasn't happened yet. Same population as the red awaiting-approval pill on the overview.",
  'exp-approved': "Trades you've approved that haven't been placed yet. They execute on Approve and on the sweeps; a non-zero value usually means mid-sweep, cap-deferred, or halted by the kill-switch.",
  'exp-realpos': 'Lifetime count of positions ever placed with real broker money, open and closed. A position flips from paper to real only after a buy succeeds, so this only ever grows — it is not current exposure.',
  'exp-openreal': 'Real money currently tied up in open positions, against the live ceiling. A new order is deferred if it would push open exposure over the cap. This is your real money-at-risk figure right now.',
  'exp-orders': 'Real orders executed today versus the daily limit, plus the per-order cap. Once the daily count is reached, further approved trades defer until tomorrow. Both caps fail closed to a conservative default, never unlimited.',
  'trade-realtable': 'Ledger of actual broker positions (latest 20): ticker, Alpaca order id, buy status, position status and notional. The audit trail of real money deployed — use it to confirm orders landed at the broker.',
};

/** Focusable info icon that opens a floating tooltip (positioned by shell() script). */
const tip = (key: string): string => {
  const t = TIP[key];
  if (!t) return '';
  return `<span class="tip" tabindex="0" role="note" aria-label="${escapeHtml(t)}" data-tip="${escapeHtml(t)}">${icon('info', 13)}</span>`;
};

/** Shared rail nav across views; `active` highlights the current one. */
function railNav(active: string): string {
  const it = (href: string, name: string, key: string, title: string) =>
    `<a ${active === key ? 'class="on"' : ''} href="${href}" title="${title}">${icon(name)}</a>`;
  return `<nav class="rail"><div class="logo">S</div>
    ${it('/admin', 'grid', 'overview', 'Overview')}
    ${it('/admin/approvals', 'inbox', 'approvals', 'Approvals')}
    ${it('/admin/trading', 'coins', 'trading', 'Trading')}
    ${it('/admin/sources', 'rss', 'sources', 'Sources')}
    ${it('/admin/add-tip', 'plus', 'addtip', 'Add tip')}
    ${it('/admin/newsletter', 'mail', 'newsletter', 'Newsletter')}
    <div class="spacer"></div>
    <a href="/leaderboard" title="Public site">${icon('gauge')}</a>
    <form method="post" action="/admin/logout"><button class="ghost" style="width:42px;height:42px;border-radius:11px;padding:0" title="Sign out">${icon('settings')}</button></form>
  </nav>`;
}

/** Action-button script: data-act POSTs (with optional data-confirm), result into #out. */
const ACTION_SCRIPT = `<script>
  document.querySelectorAll('button[data-act]').forEach(function(b){
    b.addEventListener('click', function(){
      var c=b.getAttribute('data-confirm'); if(c && !confirm(c)) return;
      var out=document.getElementById('out'); if(out){out.textContent=b.textContent.trim()+'\\u2026 running';}
      b.disabled=true;
      fetch(b.getAttribute('data-act'),{method:'POST'}).then(function(r){return r.text();})
        .then(function(t){ if(out) out.textContent=t; b.disabled=false; })
        .catch(function(e){ if(out) out.textContent='Error: '+e; b.disabled=false; });
    });
  });
</script>`;

/** ALPACA mode + kill-switch posture badge: OFF grey · PAPER amber · LIVE red. */
function postureBadge(mode: string, paused: boolean): string {
  const tone = mode === 'live' ? ['var(--bad)', 'LIVE'] : mode === 'paper' ? ['#c98a00', 'PAPER'] : ['var(--faint)', 'OFF'];
  return `<span class="pill" style="background:${tone[0]};color:#fff;border:none">ALPACA · ${tone[1]}</span>` +
    (paused ? ` <span class="pill" style="border-color:var(--bad);color:var(--bad)">⛔ PAUSED</span>` : '');
}

interface IntentRow { tip_id: string; ticker: string; notional_cents: number; sec_name: string; direction: string; conviction: string | null; evidence_span: string | null; source_name: string; tier: string | null }

/** Trade intents awaiting operator approval (proposed). */
async function proposedIntents(env: Env): Promise<IntentRow[]> {
  return (await env.DB.prepare(
    `SELECT ti.tip_id, ti.ticker, ti.notional_cents, sec.name sec_name, t.direction, t.conviction,
            t.evidence_span, s.name source_name, sr.tier
       FROM trade_intents ti JOIN tips t ON t.id=ti.tip_id JOIN securities sec ON sec.id=ti.security_id
       JOIN sources s ON s.id=t.source_id LEFT JOIN source_ratings sr ON sr.source_id=s.id AND sr.dimension='horizon:90'
      WHERE ti.status='proposed' ORDER BY ti.created_at ASC LIMIT 50`,
  ).all<IntentRow>()).results ?? [];
}

/** Live-trade approval table with per-row Approve (confirm-gated) / Reject. */
function liveTradeTable(rows: IntentRow[]): string {
  if (rows.length === 0) return '<p class="muted">No live trades awaiting approval. ✓</p>';
  return `<table><thead><tr><th>Ticker</th><th>Source</th><th>Dir</th><th>Conv</th><th class="num">Notional</th><th>Evidence</th><th></th></tr></thead><tbody>
    ${rows.map((r) => {
      const usd = (r.notional_cents / 100).toFixed(2);
      return `<tr>
        <td><b>${escapeHtml(r.ticker)}</b> <span class="muted" style="font-size:.76rem">${escapeHtml((r.sec_name || '').slice(0, 16))}</span></td>
        <td>${escapeHtml(r.source_name)} ${r.tier ? `<span class="tier">${escapeHtml(r.tier)}</span>` : ''}</td>
        <td>${escapeHtml(r.direction)}</td><td>${escapeHtml(r.conviction || '–')}</td>
        <td class="num">$${usd}</td>
        <td class="muted" style="white-space:normal;max-width:240px;font-size:.78rem">${escapeHtml((r.evidence_span || '').slice(0, 110))}</td>
        <td style="white-space:nowrap">
          <button data-act="/admin/approve-trade?tip=${encodeURIComponent(r.tip_id)}" data-confirm="Place a REAL $${usd} order in ${escapeHtml(r.ticker)}? This moves real money.">Approve</button>
          <button class="ghost" data-act="/admin/reject-trade?tip=${encodeURIComponent(r.tip_id)}">Reject</button>
        </td></tr>`;
    }).join('')}
  </tbody></table>`;
}

function shell(title: string, body: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · Shareo admin</title>
${BRAND_HEAD}
<style>
  .app { display: grid; grid-template-columns: 64px 1fr; min-height: 100vh; }
  /* rail */
  .rail { background: var(--ink); display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 16px 0; position: sticky; top: 0; height: 100vh; }
  .rail .logo { width: 38px; height: 38px; border-radius: 11px; background: var(--paper); color: var(--ink); display: grid; place-items: center; font-family: var(--font-display); font-size: 19px; margin-bottom: 14px; }
  .rail a { width: 42px; height: 42px; border-radius: 11px; display: grid; place-items: center; color: rgba(255,255,255,.5); text-decoration: none; position: relative; }
  .rail a.on { background: rgba(255,255,255,.12); color: #fff; }
  .rail a:hover { color: #fff; }
  .rail .spacer { flex: 1; }
  /* main */
  .main { min-width: 0; display: flex; flex-direction: column; }
  .topbar { display: flex; align-items: center; gap: 14px; padding: 14px 26px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: color-mix(in srgb, var(--paper) 88%, transparent); backdrop-filter: blur(8px); z-index: 4; }
  .search { flex: 1; display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 13px; background: var(--card); border: 1px solid var(--line); border-radius: var(--r-pill); padding: 9px 14px; max-width: 420px; }
  .pills { display: inline-flex; background: var(--card); border: 1px solid var(--line); border-radius: var(--r-pill); padding: 3px; }
  .pills a { font-size: 12px; font-weight: 600; padding: 6px 13px; border-radius: var(--r-pill); color: var(--muted); text-decoration: none; }
  .pills a.on { background: var(--ink); color: var(--on-dark); }
  .content { padding: 24px 26px 60px; display: flex; flex-direction: column; gap: 20px; }
  /* hero */
  .hero { background: var(--ink); color: var(--on-dark); border-radius: var(--r-lg); padding: 34px 38px; display: grid; grid-template-columns: 1.45fr 1fr; gap: 40px; position: relative; overflow: hidden; box-shadow: var(--shadow-lg); }
  .hero .gridbg { position: absolute; inset: 0; opacity: .06; pointer-events: none; }
  .hero .live { display: inline-flex; align-items: center; gap: 8px; font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; letter-spacing: .09em; color: rgba(255,255,255,.6); margin-bottom: 18px; }
  .hero .live i { width: 6px; height: 6px; border-radius: 50%; background: #5bbb6b; box-shadow: 0 0 0 4px rgba(91,187,107,.18); }
  .hero h1 { font-family: var(--font-display); font-weight: 400; text-transform: uppercase; font-size: clamp(30px, 4vw, 50px); line-height: .98; letter-spacing: .005em; margin: 0; }
  .hero h1 em { font-style: normal; color: #fff; }
  .hero .lede { font-size: 14px; color: rgba(255,255,255,.62); max-width: 460px; line-height: 1.55; margin: 18px 0 0; }
  .herostats { display: flex; flex-direction: column; justify-content: center; gap: 0; position: relative; z-index: 1; }
  .herostat { border-top: 1px solid rgba(255,255,255,.12); padding: 14px 0; display: flex; justify-content: space-between; align-items: flex-end; gap: 14px; }
  .herostat .lab { font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: rgba(255,255,255,.5); }
  .herostat .val { font-family: var(--font-display); font-size: 30px; line-height: 1; margin-top: 6px; }
  .herostat .sub { font-size: 11px; color: rgba(255,255,255,.4); margin-top: 6px; }
  .delta { font-family: var(--font-mono); font-size: 12px; font-weight: 500; padding: 3px 8px; border-radius: 6px; }
  .delta.up { color: #2f9e44; background: rgba(91,187,107,.15); } .delta.down { color: var(--bad); background: rgba(176,50,44,.12); }
  /* cards / grid */
  .row { display: grid; gap: 20px; }
  .r-trend { grid-template-columns: 1.6fr 1fr; } .r-half { grid-template-columns: 1.2fr 1fr; }
  @media (max-width: 940px){ .hero, .row { grid-template-columns: 1fr !important; } .app { grid-template-columns: 52px 1fr; } }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: var(--r-lg); box-shadow: var(--shadow-sm); display: flex; flex-direction: column; }
  .card.dark { background: var(--ink); color: var(--on-dark); border: none; }
  .card > header { padding: 20px 22px 14px; display: flex; justify-content: space-between; align-items: flex-start; gap: 14px; }
  .card h3 { margin: 0; font-family: var(--font-display); font-weight: 400; text-transform: uppercase; letter-spacing: .02em; font-size: 14px; }
  .card .csub { margin: 4px 0 0; font-size: 12px; color: var(--muted); }
  .card.dark .csub { color: rgba(255,255,255,.55); }
  .card > .body { padding: 0 22px 22px; }
  .bignum { font-family: var(--font-display); font-size: 40px; line-height: 1; }
  /* tables / lists */
  table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 9px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  .card.dark th, .card.dark td { border-color: rgba(255,255,255,.08); }
  th { font-family: var(--font-mono); font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); font-weight: 500; }
  .num { text-align: right; font-family: var(--font-mono); }
  .pos { color: var(--good); } .neg { color: var(--bad); } .muted { color: var(--muted); }
  .tier, .pill { font-family: var(--font-mono); font-size: 10px; text-transform: uppercase; letter-spacing: .04em; padding: 2px 7px; border-radius: var(--r-pill); border: 1px solid var(--line); color: var(--muted); }
  .barlist .b { display: grid; grid-template-columns: 150px 1fr 54px 50px; gap: 14px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--line); }
  .barlist .track { height: 6px; background: var(--line); border-radius: 3px; position: relative; }
  .barlist .track > span { position: absolute; inset: 0; background: var(--ink); border-radius: 3px; }
  .triage { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
  .ti { display: grid; grid-template-columns: 4px 1fr auto; gap: 14px; align-items: center; background: var(--paper-2); border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; }
  .ti .accent { width: 4px; align-self: stretch; }
  .ti .mid { padding: 12px 0; min-width: 0; }
  .ti .sev { font-family: var(--font-mono); font-size: 9px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; padding: 2px 6px; border-radius: 4px; }
  .feed .f { display: grid; grid-template-columns: 32px 1fr auto; gap: 12px; align-items: center; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,.08); }
  .feed .ic { width: 32px; height: 32px; border-radius: 9px; background: rgba(255,255,255,.07); display: grid; place-items: center; color: rgba(255,255,255,.8); }
  .ring-wrap { display: flex; align-items: center; gap: 22px; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .jobwrap { display: inline-flex; align-items: center; gap: 3px; }
  /* sub-page primitives (errors / approvals / trading) */
  h2 { font-family: var(--font-display); font-weight: 400; text-transform: uppercase; letter-spacing: .02em; font-size: 15px; margin: 20px 0 10px; }
  .panel { background: var(--card); border: 1px solid var(--line); border-radius: var(--r-lg); box-shadow: var(--shadow-sm); padding: 16px 18px; overflow-x: auto; }
  .grid.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(155px, 1fr)); gap: 14px; }
  .grid.stats .card { padding: 16px 18px; }
  .grid.stats .k { font-family: var(--font-mono); font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); display: flex; align-items: center; }
  .grid.stats .v { font-family: var(--font-display); font-size: 30px; line-height: 1; margin-top: 6px; }
  .grid.stats .sub { font-size: 11px; color: var(--muted); margin-top: 5px; }
  .grid.stats .sub a { color: var(--muted); }
  button { font: inherit; font-weight: 600; padding: 9px 16px; border: none; border-radius: var(--r-pill); background: var(--ink); color: var(--on-dark); cursor: pointer; }
  button.ghost { background: var(--card); color: var(--text); border: 1px solid var(--line); }
  a.btn { display: inline-block; font: inherit; font-weight: 600; padding: 9px 16px; border-radius: var(--r-pill); background: var(--ink); color: var(--on-dark); text-decoration: none; cursor: pointer; }
  a.btn.ghost { background: var(--card); color: var(--text); border: 1px solid var(--line); }
  a.btn:hover { opacity: .9; }
  .field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 12px; }
  .field label { font-family: var(--font-mono); font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
  .field input, .field select, .field textarea { font: inherit; padding: 9px 11px; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--card); color: var(--text); width: 100%; box-sizing: border-box; }
  .field textarea { min-height: 150px; resize: vertical; font-family: var(--font-mono); font-size: 13px; }
  .field .hint { font-size: 11px; color: var(--muted); }
  .formgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 16px; }
  @media (max-width: 720px) { .formgrid { grid-template-columns: 1fr; } }
  button:hover { opacity: .9; } button:disabled { opacity: .5; }
  pre#out { font-family: var(--font-mono); font-size: 12px; background: var(--paper-2); border: 1px solid var(--line); border-radius: var(--r-md); padding: 11px; white-space: pre-wrap; word-break: break-word; min-height: 1rem; color: var(--text-2); }
  kbd { font-family: var(--font-mono); font-size: 10px; border: 1px solid var(--line); border-radius: 4px; padding: 2px 6px; color: var(--muted); }
  /* help: info icon + floating tooltip */
  .tip { display: inline-flex; align-items: center; vertical-align: middle; margin-left: 5px; color: var(--faint); cursor: help; }
  .tip:hover, .tip:focus { color: var(--muted); outline: none; }
  .card.dark .tip, .hero .tip { color: rgba(255,255,255,.45); }
  .card.dark .tip:hover, .hero .tip:hover, .card.dark .tip:focus, .hero .tip:focus { color: rgba(255,255,255,.8); }
  .tip-pop { position: fixed; z-index: 60; display: none; max-width: 300px; background: var(--ink); color: var(--on-dark); font-family: var(--font-body); font-size: 12px; font-weight: 400; line-height: 1.5; text-transform: none; letter-spacing: normal; padding: 10px 12px; border-radius: var(--r-md); box-shadow: var(--shadow-lg); pointer-events: none; }
  /* walkthrough */
  .walk { background: var(--card); border: 1px solid var(--line); border-radius: var(--r-lg); box-shadow: var(--shadow-sm); padding: 4px 20px; }
  .walk > summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 10px; padding: 14px 0; font-family: var(--font-display); font-weight: 400; text-transform: uppercase; letter-spacing: .02em; font-size: 14px; }
  .walk > summary::-webkit-details-marker { display: none; }
  .walk > summary .chev { margin-left: auto; color: var(--faint); transition: transform .15s; }
  .walk[open] > summary .chev { transform: rotate(90deg); }
  .walk > summary span.sub { font-family: var(--font-body); text-transform: none; letter-spacing: normal; font-size: 12px; font-weight: 400; color: var(--muted); }
  .walk .wbody { padding: 0 0 18px; }
  .walk .wbody > p { margin: 0 0 12px; font-size: 13px; color: var(--text-2); max-width: 70ch; }
  .walk ol { margin: 0; padding-left: 0; counter-reset: step; list-style: none; display: grid; gap: 8px; }
  .walk ol li { counter-increment: step; position: relative; padding-left: 34px; font-size: 13px; color: var(--text-2); line-height: 1.5; }
  .walk ol li::before { content: counter(step); position: absolute; left: 0; top: -1px; width: 22px; height: 22px; border-radius: 50%; background: var(--ink); color: var(--on-dark); font-family: var(--font-mono); font-size: 11px; display: grid; place-items: center; }
  /* clickable triage cards */
  a.ti { text-decoration: none; color: inherit; transition: border-color .12s, transform .12s; }
  a.ti:hover { border-color: var(--muted); transform: translateY(-1px); }
  a.ti:hover .go { color: var(--text); }
</style></head><body>${body}
<div class="tip-pop" id="tip-pop"></div>
<script>
  (function(){
    var pop = document.getElementById('tip-pop');
    function show(el){
      var t = el.getAttribute('data-tip'); if(!t) return;
      pop.textContent = t; pop.style.display = 'block';
      var r = el.getBoundingClientRect();
      var w = pop.offsetWidth, h = pop.offsetHeight, m = 10;
      var left = Math.min(Math.max(m, r.left - 4), window.innerWidth - w - m);
      var top = r.bottom + 8;
      if (top + h > window.innerHeight - m) top = Math.max(m, r.top - h - 8);
      pop.style.left = left + 'px'; pop.style.top = top + 'px';
    }
    function hide(){ pop.style.display = 'none'; }
    document.addEventListener('mouseover', function(e){ var el = e.target.closest && e.target.closest('.tip'); if(el) show(el); });
    document.addEventListener('mouseout', function(e){ var el = e.target.closest && e.target.closest('.tip'); if(el) hide(); });
    document.addEventListener('focusin', function(e){ var el = e.target.closest && e.target.closest('.tip'); if(el) show(el); });
    document.addEventListener('focusout', function(e){ var el = e.target.closest && e.target.closest('.tip'); if(el) hide(); });
    window.addEventListener('scroll', hide, true);
  })();
</script>
</body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

/** Login form. */
export function adminLoginPage(error?: string): Response {
  return shell('Sign in', `<div style="display:grid;place-items:center;min-height:100vh;padding:1.5rem">
    <div style="max-width:380px;width:100%;text-align:center">
      <div class="display" style="font-size:2rem">Shareo <span class="muted" style="font-size:1rem">admin</span></div>
      <p class="muted" style="margin:.4rem 0 1rem">Enter the admin token to continue.</p>
      ${error ? `<p class="neg" style="font-weight:600">${escapeHtml(error)}</p>` : ''}
      <form method="post" action="/admin/login">
        <input name="token" type="password" placeholder="admin token" autocomplete="current-password" required
          style="width:100%;padding:.75rem;border:1px solid var(--line);border-radius:var(--r-md);font:inherit;background:var(--card);color:var(--text);margin-bottom:.7rem">
        <button type="submit" style="width:100%">Sign in</button>
      </form>
    </div></div>`);
}

export async function handleAdminLogin(req: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_TOKEN) return adminLoginPage('Admin token is not configured on the server.');
  let token = '';
  try {
    const form = await req.formData();
    const t = form.get('token');
    if (typeof t === 'string') token = t;
  } catch { return adminLoginPage('Invalid request.'); }
  if (!token || !timingSafeEqual(token, env.ADMIN_TOKEN)) return adminLoginPage('Incorrect token.');
  const cookie = `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=${COOKIE_TTL_S}`;
  return new Response(null, { status: 302, headers: { location: '/admin', 'set-cookie': cookie } });
}

export function handleAdminLogout(): Response {
  const cookie = `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=0`;
  return new Response(null, { status: 302, headers: { location: '/admin', 'set-cookie': cookie } });
}

async function rows<T = Record<string, unknown>>(env: Env, sql: string): Promise<T[]> {
  return (await env.DB.prepare(sql).all<T>()).results ?? [];
}

/** Filled NAV area chart (monochrome, $1,000 baseline). */
function navChart(values: number[], w = 720, h = 200): string {
  if (values.length === 0) return '<p class="muted">No NAV points yet — run the daily pass.</p>';
  const min = Math.min(...values, 1000), max = Math.max(...values, 1000), range = max - min || 1;
  const pb = 10;
  const x = (i: number) => (values.length > 1 ? (i / (values.length - 1)) * w : w / 2);
  const y = (v: number) => (h - pb) - ((v - min) / range) * (h - pb * 2);
  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L ${x(values.length - 1).toFixed(1)} ${h} L ${x(0).toFixed(1)} ${h} Z`;
  const last = values[values.length - 1];
  return `<svg width="100%" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="display:block">
    <defs><linearGradient id="nav" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--ink)" stop-opacity=".16"/><stop offset="100%" stop-color="var(--ink)" stop-opacity="0"/></linearGradient></defs>
    <line x1="0" y1="${y(1000).toFixed(1)}" x2="${w}" y2="${y(1000).toFixed(1)}" stroke="var(--line)" stroke-dasharray="3 4"/>
    <path d="${area}" fill="url(#nav)"/>
    <path d="${line}" fill="none" stroke="var(--ink)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(values.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="4" fill="var(--paper)" stroke="var(--ink)" stroke-width="2"/>
  </svg>`;
}

/** Donut ring with a centre percentage. `frac` null ⇒ no-data dash (distinct from a genuine 0%). */
function ring(frac: number | null, label: string, size = 124, stroke = 11): string {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const f = frac ?? 0;
  const centre = frac == null ? '–' : `${Math.round(f * 100)}%`;
  return `<div style="position:relative;width:${size}px;height:${size}px;flex-shrink:0">
    <svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--line)" stroke-width="${stroke}"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--ink)" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${(f * c).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg>
    <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">
      <div class="display" style="font-size:26px">${centre}</div>
      <div class="mono muted" style="font-size:9px;text-transform:uppercase;letter-spacing:.08em">${escapeHtml(label)}</div></div></div>`;
}

export async function adminDashboard(env: Env): Promise<Response> {
  const cap = Number(env.MAX_DAILY_COST_CENTS) || 0;
  const spent = await spentTodayCents(env).catch(() => 0);
  // True percent (can exceed 100 — withinBudget gates on estimate, recordSpend records actual).
  const spentPct = cap > 0 ? Math.round((spent / cap) * 100) : 0;
  const spendLabel = `${spentPct}% of cap${spentPct > 100 ? ' · over' : ''}`;
  const eodhdCalls = await eodhdCallsToday(env).catch(() => null);
  const eodhdBudget = eodhdCallBudget(env);

  const [tipsAgg] = await rows<{ total: number; resolved: number }>(env, `SELECT COUNT(*) total, SUM(CASE WHEN security_id IS NOT NULL THEN 1 ELSE 0 END) resolved FROM tips`);
  const [posAgg] = await rows<{ open: number; closed: number }>(env, `SELECT SUM(status='open') open, SUM(status='closed') closed FROM positions`);
  const [subAgg] = await rows<{ total: number; synced: number }>(env, `SELECT COUNT(*) total, SUM(CASE WHEN beehiiv_synced_at IS NOT NULL THEN 1 ELSE 0 END) synced FROM subscribers`);
  const [srcAgg] = await rows<{ n: number }>(env, `SELECT COUNT(*) n FROM sources WHERE active IS NULL OR active = 1`);
  const [secAgg] = await rows<{ n: number }>(env, `SELECT COUNT(DISTINCT security_id) n FROM tips WHERE security_id IS NOT NULL`);
  const [hitAgg] = await rows<{ hits: number; n: number; alpha: number | null }>(env, `SELECT SUM(is_hit) hits, COUNT(*) n, AVG(excess_pct) alpha FROM tip_returns WHERE is_hit IS NOT NULL`);
  const navSeries = await rows<{ as_of: string; nav_index: number }>(env, `SELECT as_of, nav_index FROM portfolio_nav WHERE scope='all' ORDER BY as_of ASC LIMIT 90`);
  const horizons = await rows<{ horizon_days: number; n: number; hits: number; alpha: number | null }>(env, `SELECT horizon_days, COUNT(*) n, SUM(is_hit) hits, AVG(excess_pct) alpha FROM tip_returns WHERE is_hit IS NOT NULL GROUP BY horizon_days ORDER BY horizon_days`);
  const [reviewTips] = await rows<{ n: number }>(env, `SELECT COUNT(*) n FROM tips WHERE status='review'`);
  const [pendPos] = await rows<{ n: number }>(env, `SELECT COUNT(*) n FROM tips t LEFT JOIN positions p ON p.tip_id=t.id WHERE t.security_id IS NOT NULL AND p.id IS NULL`);
  // "Active" errors = real errors in the last 24h that happened AFTER the most recent successful
  // valuation — so an issue you've since fixed and re-run no longer alarms. NOTE: created_at is ISO
  // ('T'-separated), so we MUST compare against an ISO bound, never SQLite datetime('now') (which is
  // space-separated and string-compares as if every row were "recent").
  const lastValuedAt = (await env.DB.prepare(`SELECT MAX(last_valued_at) m FROM positions`).first<{ m: string | null }>())?.m ?? null;
  const iso24 = new Date(Date.now() - 86_400_000).toISOString();
  const err24 = await env.DB.prepare(
    `SELECT COUNT(*) n FROM ops_events WHERE kind='error' AND created_at >= ? AND (? IS NULL OR created_at > ?)`,
  ).bind(iso24, lastValuedAt, lastValuedAt).first<{ n: number }>();
  const [unsynced] = await rows<{ n: number }>(env, `SELECT COUNT(*) n FROM subscribers WHERE status='active' AND beehiiv_synced_at IS NULL`);
  const [tosUnchecked] = await rows<{ n: number }>(env, `SELECT COUNT(*) n FROM sources WHERE (active IS NULL OR active=1) AND ingest_method IN ('rss_fulltext','podcast_transcript','bluesky') AND (tos_checked IS NULL OR tos_checked != 1)`);
  const sharers = await rows<{ name: string; medium: string; tips: number; settled: number | null; hit_rate: number | null; score_lower: number | null; tier: string | null }>(env,
    `SELECT s.name, s.medium, COUNT(t.id) tips, sr.n_tips settled, sr.hit_rate, sr.score_lower, sr.tier
       FROM sources s LEFT JOIN tips t ON t.source_id=s.id LEFT JOIN source_ratings sr ON sr.source_id=s.id AND sr.dimension='horizon:90'
      GROUP BY s.id ORDER BY (sr.score_lower IS NULL), sr.score_lower DESC, tips DESC LIMIT 8`);
  const shares = await rows<{ ticker: string; name: string; tips: number; hits: number; avg_alpha: number | null }>(env,
    `SELECT sec.ticker, sec.name, COUNT(t.id) tips, SUM(CASE WHEN p.is_hit=1 THEN 1 ELSE 0 END) hits, AVG(p.excess_return_pct) avg_alpha
       FROM securities sec JOIN tips t ON t.security_id=sec.id LEFT JOIN positions p ON p.tip_id=t.id GROUP BY sec.id ORDER BY tips DESC, sec.ticker LIMIT 10`);
  const ratings = await rows<{ dimension: string; source_name: string; tier: string; n_tips: number; hit_rate: number; avg_excess_pct: number; score_lower: number; rank: number }>(env,
    `SELECT sr.dimension, s.name source_name, sr.tier, sr.n_tips, sr.hit_rate, sr.avg_excess_pct, sr.score_lower, sr.rank FROM source_ratings sr JOIN sources s ON s.id=sr.source_id ORDER BY sr.dimension, sr.rank LIMIT 80`);
  const ops = await rows<{ kind: string; created_at: string; detail: string }>(env, `SELECT kind, created_at, substr(detail,1,90) detail FROM ops_events ORDER BY created_at DESC LIMIT 7`);
  // Newsletter funnel state (Phase 1 observability).
  const lastDigest = await env.DB.prepare(
    `SELECT week, status, beehiiv_post_id, sent_at, created_at, substr(detail,1,160) detail FROM digest_publications ORDER BY week DESC LIMIT 1`,
  ).first<{ week: string; status: string; beehiiv_post_id: string | null; sent_at: string | null; created_at: string; detail: string | null }>().catch(() => null);
  const [subBreak] = await rows<{ active: number; pending: number; unsubscribed: number }>(env,
    `SELECT SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) active, SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending, SUM(CASE WHEN status='unsubscribed' THEN 1 ELSE 0 END) unsubscribed FROM subscribers`);

  const pendingLive = (await env.DB.prepare(`SELECT COUNT(*) n FROM trade_intents WHERE status='proposed'`).first<{ n: number }>())?.n ?? 0;
  const brokerMode = await alpacaMode(env);
  const tradingHalted = await tradingPaused(env);
  const navLast = navSeries[navSeries.length - 1];
  const navRet = navLast ? navLast.nav_index / 1000 - 1 : null;
  const overallHit = hitAgg && hitAgg.n ? hitAgg.hits / hitAgg.n : null;
  const maxTips = Math.max(1, ...shares.map((s) => s.tips));

  const delta = (frac: number | null) => frac == null ? '' : `<span class="delta ${frac >= 0 ? 'up' : 'down'}">${pct(frac)}</span>`;
  const sign = (frac: number | null | undefined) => frac == null ? '<td class="num muted">–</td>' : `<td class="num ${frac >= 0 ? 'pos' : 'neg'}">${pct(frac)}</td>`;
  const DIM: Record<string, string> = { 'horizon:30': '30-day', 'horizon:90': '90-day', 'horizon:365': '365-day', primary: 'Primary horizon', 'conviction:90': 'Conviction-weighted' };

  // Needs-attention triage (operational). Each item links to where the operator resolves it.
  const triage = [
    err24?.n ? { sev: 'high', kind: 'Errors', t: `${err24.n} active error${err24.n === 1 ? '' : 's'} (24h)`, d: 'Errors since the last successful run — open the errors page', href: '/admin/errors' } : null,
    spentPct >= 90 ? { sev: 'high', kind: 'Budget', t: `LLM spend at ${spentPct}% of cap`, d: 'AI extraction defers until the daily reset (00:00 UTC)', href: '#jobs' } : null,
    reviewTips?.n ? { sev: 'med', kind: 'Review', t: `${reviewTips.n} tip${reviewTips.n === 1 ? '' : 's'} need review`, d: 'Unresolved security — open the review queue (view-only for now)', href: '/admin/approvals' } : null,
    pendPos?.n ? { sev: 'med', kind: 'Pipeline', t: `${pendPos.n} resolved tip${pendPos.n === 1 ? '' : 's'} awaiting a position`, d: 'Run the daily pass below to open + value them', href: '#jobs' } : null,
    tosUnchecked?.n ? { sev: 'med', kind: 'Sources', t: `${tosUnchecked.n} source${tosUnchecked.n === 1 ? '' : 's'} need a ToS check`, d: 'Auto-polling is paused until verified — open Sources to review + enable', href: '/admin/sources' } : null,
    unsynced?.n ? { sev: 'low', kind: 'Newsletter', t: `${unsynced.n} subscriber${unsynced.n === 1 ? '' : 's'} not synced to beehiiv`, d: 'Runs in the daily cron, or sync now below', href: '#jobs' } : null,
  ].filter(Boolean) as Array<{ sev: string; kind: string; t: string; d: string; href: string }>;
  const sevColor = (s: string) => s === 'high' ? 'var(--bad)' : s === 'med' ? '#c98a00' : 'var(--faint)';

  const dimGroups = ratings.reduce((acc: Record<string, typeof ratings>, r) => { (acc[r.dimension] ??= []).push(r); return acc; }, {});

  const body = `<div class="app">
    ${railNav('overview')}
    <div class="main">
      <header class="topbar">
        <div class="search">${icon('grid', 15)}<span>Shareo · empirical tip accountability</span><kbd style="margin-left:auto">live</kbd></div>
        <div class="pills">
          <a class="on" href="/leaderboard?dim=primary">Primary</a>
          <a href="/leaderboard?dim=horizon:90">90-day</a>
          <a href="/leaderboard?dim=conviction:90">Conviction</a>
        </div>
        <button onclick="location.reload()">↻ Refresh</button>
      </header>

      <div class="content">
        <!-- WALKTHROUGH -->
        <details class="walk" open>
          <summary>${icon('grid', 16)} How to use this console <span class="sub">— daily quick-start</span><span class="chev" style="font-size:18px">›</span></summary>
          <div class="wbody">
            <p>This console tracks public stock tips, paper-trades each outcome, and reports a confidence-adjusted sharer leaderboard — a backward-looking record only, never advice. A typical pass:</p>
            <ol>
              <li>Check the posture strip below — confirm the broker mode (OFF / PAPER / LIVE) and deal with any red “live trades awaiting approval” pill first.</li>
              <li>Scan <b>Needs attention</b>: red items (Errors, Budget) before amber (Review, Pipeline) before grey (Newsletter). Each card is clickable — it jumps to where you fix it.</li>
              <li>If errors are flagged, open the dark <b>Live activity</b> card and read the red lines for the cause.</li>
              <li>In <b>Run a job</b>, click <b>Poll producers</b> to pull fresh tips, then <b>Run daily</b> to open/value positions and refresh the chart + leaderboard.</li>
              <li>Approve or reject any pending real-money trades in <b>Approvals</b>, after checking ticker, notional, source and evidence.</li>
              <li>Reload the page to see updated numbers — the metrics do not live-update after a job runs.</li>
            </ol>
            <p style="margin:0 0 6px;font-size:13px;color:var(--text-2)"><b>Beyond the daily loop</b> (rail icons, left):</p>
            <ul style="margin:0 0 12px;padding-left:18px;font-size:13px;color:var(--text-2);line-height:1.6">
              <li><b>Sources</b> — add where tips come from. Auto-poll feeds only run once you <b>Mark ToS-checked</b> (so they show as “need a ToS check” until you do). Watch each source's health + abstain rate here.</li>
              <li><b>Add tip</b> — paste a tip you found by hand; set its <b>real publish date</b> and it joins the same pipeline.</li>
              <li><b>Newsletter</b> — preview the weekly issue, push it to a beehiiv draft (you send it), and see subscriber + publish history.</li>
            </ul>
            <p class="muted" style="margin-bottom:0;font-size:12px">Hover the ${icon('info', 12)} icons anywhere on this page for a plain-English explanation of each field.</p>
          </div>
        </details>
        <!-- POSTURE STRIP -->
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;${brokerMode === 'live' ? 'border-top:3px solid var(--bad);padding-top:10px' : ''}">
          ${postureBadge(brokerMode, tradingHalted)}${tip(tradingHalted ? 'posture-paused' : 'posture-alpaca-mode')}
          <span class="pill">LICENCE · ${env.PUBLIC_PRICES === 'on' ? 'commercial' : 'personal'}</span>${tip('posture-licence')}
          ${pendingLive ? `<a href="/admin/approvals" class="pill" style="background:var(--bad);color:#fff;border:none;text-decoration:none">${pendingLive} live trade${pendingLive === 1 ? '' : 's'} awaiting approval →</a>${tip('posture-pending-live')}` : ''}
        </div>
        <!-- HERO -->
        <section class="hero">
          <svg class="gridbg" width="100%" height="100%"><defs><pattern id="g" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M 40 0 L 0 0 0 40" fill="none" stroke="#fff" stroke-width="0.5"/></pattern></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>
          <div style="position:relative;z-index:1">
            <div class="live"><i></i> Live · ${escapeHtml(navLast?.as_of || 'awaiting first run')} · hypothetical${tip('hero-live-badge')}</div>
            <h1>A hypothetical<br>$1,000 is worth<br><em>$${navLast ? navLast.nav_index.toFixed(0) : '—'}</em> today.${tip('hero-headline')}</h1>
            <p class="lede">Spread equally across ${tipsAgg?.resolved ?? 0} tracked calls from ${srcAgg?.n ?? 0} sharers. ${overallHit != null ? `${Math.round(overallHit * 100)}% of settled calls beat their market benchmark.` : 'Outcomes accrue as calls settle.'} Backward-looking, paper-traded — not advice.${tip('hero-lede')}</p>
          </div>
          <div class="herostats">
            <div class="herostat"><div><div class="lab">$1,000 journey${tip('herostat-journey')}</div><div class="val">${navLast ? navLast.nav_index.toFixed(0) : '–'}</div><div class="sub">indexed off $1,000</div></div>${delta(navRet)}</div>
            <div class="herostat"><div><div class="lab">Hit rate${tip('herostat-hitrate')}</div><div class="val">${overallHit == null ? '–' : Math.round(overallHit * 100) + '%'}</div><div class="sub">${hitAgg?.n ?? 0} settled outcomes</div></div></div>
            <div class="herostat"><div><div class="lab">Avg alpha${tip('herostat-alpha')}</div><div class="val">${hitAgg?.alpha == null ? '–' : pct(hitAgg.alpha)}</div><div class="sub">excess vs benchmark</div></div>${delta(hitAgg?.alpha ?? null)}</div>
          </div>
        </section>

        <!-- META STRIP -->
        <div style="display:flex;gap:26px;flex-wrap:wrap;font-size:13px;color:var(--muted);padding:0 2px">
          <span><b style="color:var(--text);font-family:var(--font-mono)">${secAgg?.n ?? 0}</b> shares followed${tip('meta-shares')}</span>
          <span><b style="color:var(--text);font-family:var(--font-mono)">${(posAgg?.open ?? 0) + (posAgg?.closed ?? 0)}</b> positions · ${posAgg?.open ?? 0} open${tip('meta-positions')}</span>
          <span><b style="color:var(--text);font-family:var(--font-mono)">${tipsAgg?.total ?? 0}</b> tips · ${tipsAgg?.resolved ?? 0} resolved${tip('meta-tips')}</span>
          <span><b style="color:var(--text);font-family:var(--font-mono)">${subAgg?.total ?? 0}</b> subscribers · ${subAgg?.synced ?? 0} synced${tip('meta-subscribers')}</span>
        </div>

        <!-- TREND + RING -->
        <div class="row r-trend">
          <section class="card"><header><div><h3>The $1,000 journey${tip('trend-chart')}</h3><p class="csub">Equal-weighted across every tracked call · indexed off $1,000</p></div>
            <div class="bignum">${navLast ? navLast.nav_index.toFixed(0) : '–'}</div></header>
            <div class="body">${navChart(navSeries.map((n) => n.nav_index))}</div></section>
          <section class="card"><header><div><h3>Hit rate${tip('ring-hitrate')}</h3><p class="csub">Calls that beat the market, by horizon${tip('ring-horizon')}</p></div></header>
            <div class="body ring-wrap">
              ${ring(overallHit, 'overall')}
              <div style="flex:1;display:flex;flex-direction:column;gap:9px">
                ${horizons.length === 0 ? '<span class="muted">No settled horizons yet.</span>' : horizons.map((h) => {
                  const hr = h.n ? h.hits / h.n : 0;
                  return `<div style="display:flex;align-items:center;gap:8px;font-size:12px"><span style="width:7px;height:7px;border-radius:50%;background:${hr >= 0.5 ? 'var(--good)' : 'var(--bad)'}"></span>
                    <span style="flex:1;font-weight:600">${h.horizon_days}-day</span><span class="mono muted">${h.n} · ${Math.round(hr * 100)}%</span></div>`;
                }).join('')}
              </div></div></section>
        </div>

        <!-- NEEDS ATTENTION -->
        <section class="card"><header><div><h3>Needs attention${tip('triage-section')}</h3><p class="csub">Operational items, sorted by severity — click any card to resolve it</p></div></header>
          <div class="body">${triage.length === 0 ? '<p class="muted">All clear — nothing needs attention. ✓</p>' :
            `<div class="triage">${triage.map((it) => `<a class="ti" href="${escapeHtml(it.href)}"><div class="accent" style="background:${sevColor(it.sev)}"></div>
              <div class="mid"><div style="display:flex;align-items:center;gap:8px;margin-bottom:3px"><span class="sev" style="color:${sevColor(it.sev)};background:color-mix(in srgb, ${sevColor(it.sev)} 14%, transparent)">${it.sev}</span><span class="mono muted" style="font-size:10px;text-transform:uppercase;letter-spacing:.06em">${escapeHtml(it.kind)}</span></div>
              <div style="font-size:13px;font-weight:600">${escapeHtml(it.t)}</div><div style="font-size:12px;color:var(--muted)">${escapeHtml(it.d)}</div></div>
              <span class="go" style="padding-right:14px;color:var(--faint)">›</span></a>`).join('')}</div>`}</div></section>

        <!-- SHARERS + SHARES -->
        <div class="row r-half" id="sharers">
          <section class="card"><header><div><h3>Tip sharers · reputation${tip('rep-sharers')}</h3><p class="csub">Ranked by 90-day Wilson lower bound${tip('rep-wilson')}</p></div><a href="/leaderboard" class="mono muted" style="font-size:12px">Full board →</a></header>
            <div class="body barlist">${sharers.length === 0 ? '<p class="muted">No sharers yet.</p>' : sharers.map((s) => {
              const score = s.score_lower ?? 0;
              return `<div class="b"><span style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis">${escapeHtml(s.name)} ${s.tier ? `<span class="tier">${escapeHtml(s.tier)}</span>` : ''}</span>
                <div class="track"><span style="width:${Math.min(100, score)}%"></span></div>
                <span class="num" style="font-size:12px">${s.score_lower == null ? '–' : `<b>${score.toFixed(0)}</b>`}</span>
                <span class="num muted" style="font-size:11px">${s.tips} tip${s.tips === 1 ? '' : 's'}</span></div>`;
            }).join('')}</div></section>
          <section class="card" id="shares"><header><div><h3>Shares we follow${tip('shares-section')}</h3><p class="csub">By tip volume · last column is alpha vs benchmark${tip('shares-alpha')}</p></div></header>
            <div class="body barlist">${shares.length === 0 ? '<p class="muted">No tracked shares yet.</p>' : shares.map((s) => `<div class="b" style="grid-template-columns:120px 1fr 54px 56px">
              <span style="font-size:13px"><b>${escapeHtml(s.ticker)}</b></span>
              <div class="track"><span style="width:${(s.tips / maxTips) * 100}%"></span></div>
              <span class="num muted" style="font-size:12px">${s.tips}</span>
              <span class="num ${(s.avg_alpha ?? 0) >= 0 ? 'pos' : 'neg'}" style="font-size:11px">${s.avg_alpha == null ? '–' : pct(s.avg_alpha)}</span></div>`).join('')}</div></section>
        </div>

        <!-- REPUTATION BY DIMENSION + ACTIVITY -->
        <div class="row r-half" id="activity">
          <section class="card"><header><div><h3>Reputation leaderboard${tip('rep-leaderboard')}</h3><p class="csub">Every dimension — horizon-keyed &amp; conviction-weighted · tiers gate ranking${tip('rep-tier')}</p></div></header>
            <div class="body">${Object.keys(dimGroups).length === 0 ? '<p class="muted">No rated sources yet — reputation accrues as tips settle.</p>' :
              Object.entries(dimGroups).map(([dim, rs]) => `<div style="margin-bottom:14px"><span class="pill" style="margin-bottom:6px;display:inline-block">${escapeHtml(DIM[dim] || dim)}</span>${tip('dim:' + dim)}
                <table><thead><tr><th>#</th><th>Sharer</th><th class="num">Tips${tip('rep-col-tips')}</th><th class="num">Hit${tip('rep-col-hit')}</th><th class="num">Alpha${tip('rep-col-alpha')}</th><th class="num">Score${tip('rep-col-score')}</th></tr></thead><tbody>
                ${rs.map((r) => `<tr><td class="num">${r.rank}</td><td>${escapeHtml(r.source_name)}</td><td class="num">${r.n_tips}</td><td class="num">${Math.round(r.hit_rate * 100)}%</td>${sign(r.avg_excess_pct)}<td class="num"><b>${r.score_lower.toFixed(0)}</b></td></tr>`).join('')}
                </tbody></table></div>`).join('')}</div></section>
          <section class="card dark"><header><div><h3>Live activity${tip('activity-feed')}</h3><p class="csub">Recent ops events · <a href="/admin/errors" style="color:rgba(255,255,255,.8)">all errors →</a></p></div><span style="display:inline-flex;align-items:center;gap:6px;font-size:11px;color:rgba(255,255,255,.6)"><span style="width:6px;height:6px;border-radius:50%;background:#5bbb6b;box-shadow:0 0 0 3px rgba(91,187,107,.18)"></span>Live</span></header>
            <div class="body feed">${ops.map((o) => `<div class="f"><div class="ic">${icon('pulse', 14)}</div>
              <div style="min-width:0"><div style="font-size:13px;${o.kind === 'error' ? 'color:var(--bad-soft)' : ''}">${escapeHtml(o.kind)}</div><div class="mono" style="font-size:11px;color:rgba(255,255,255,.45);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(o.detail || '')}</div></div>
              <span class="mono" style="font-size:10px;color:rgba(255,255,255,.45)">${escapeHtml(o.created_at.slice(11, 16))}</span></div>`).join('')}</div></section>
        </div>

        <!-- NEWSLETTER -->
        ${(() => {
          const st = lastDigest?.status ?? 'none';
          const tone = st === 'sent' ? 'var(--good)' : st === 'drafted' ? '#c98a00' : st === 'failed' ? 'var(--bad)' : 'var(--faint)';
          const label = st === 'none' ? 'no issue yet' : st === 'drafted' ? 'draft created' : st;
          return `<section class="card" id="newsletter"><header><div><h3>Newsletter${tip('newsletter-panel')}</h3><p class="csub">Weekly issue publish state &amp; subscriber funnel</p></div>
            <span class="pill" style="background:${tone};color:#fff;border:none">${escapeHtml(label)}</span></header>
            <div class="body">
              <div style="display:flex;gap:26px;flex-wrap:wrap;font-size:13px;color:var(--muted);margin-bottom:4px">
                <span><b style="color:var(--text);font-family:var(--font-mono)">${escapeHtml(lastDigest?.week ?? '—')}</b> latest issue</span>
                <span><b style="color:var(--text);font-family:var(--font-mono)">${subBreak?.active ?? 0}</b> active${subBreak?.pending ? ` · ${subBreak.pending} pending` : ''}${subBreak?.unsubscribed ? ` · ${subBreak.unsubscribed} unsub` : ''}</span>
                <span><b style="color:var(--text);font-family:var(--font-mono)">${unsynced?.n ?? 0}</b> not synced to beehiiv</span>
                <span><b style="color:var(--text);font-family:var(--font-mono)">${lastDigest?.sent_at ? escapeHtml(lastDigest.sent_at.slice(0, 10)) : '—'}</b> last sent</span>
              </div>
              ${lastDigest?.beehiiv_post_id ? `<p class="muted" style="font-size:12px;margin:0 0 8px">beehiiv post id: <span class="mono">${escapeHtml(lastDigest.beehiiv_post_id)}</span></p>` : ''}
              ${st === 'failed' ? `<div class="panel" style="border-color:var(--bad);background:color-mix(in srgb, var(--bad) 6%, var(--card));padding:12px 14px;margin:4px 0"><b style="color:var(--bad)">beehiiv draft failed${tip('newsletter-failed')}:</b> <span class="muted" style="font-size:12px">${escapeHtml(lastDigest?.detail || 'see ops events')}</span> — the issue is still saved; open the preview and paste it into beehiiv manually.</div>` : ''}
              <div class="actions" style="margin-top:8px">
                ${lastDigest?.week ? `<a href="/admin/digest?week=${encodeURIComponent(lastDigest.week)}" target="_blank" rel="noopener" style="text-decoration:none;display:inline-block;font-weight:600;padding:9px 16px;border-radius:var(--r-pill);background:var(--card);color:var(--text);border:1px solid var(--line)">Preview latest issue →</a>` : '<span class="muted" style="font-size:13px">No issue generated yet — use “Generate weekly digest” below.</span>'}
              </div>
            </div></section>`;
        })()}
        <!-- JOBS -->
        <section class="card" id="jobs"><header><div><h3>Run a job${tip('jobs-section')}</h3><p class="csub">Spend today: $${(spent / 100).toFixed(2)} / $${(cap / 100).toFixed(0)} · ${spendLabel}${tip('jobs-spend')} · EODHD ${eodhdCalls == null ? '–' : eodhdCalls}${eodhdBudget ? `/${eodhdBudget}` : ''} calls${tip('jobs-eodhd')}</p></div></header>
          <div class="body"><div class="actions">
            <span class="jobwrap"><button data-act="/admin/run-daily">Run daily</button>${tip('job-run-daily')}</span>
            <span class="jobwrap"><button data-act="/admin/poll" class="ghost">Poll producers</button>${tip('job-poll')}</span>
            <span class="jobwrap"><button data-act="/admin/backfill-tip-type?limit=500" class="ghost">Backfill tip types</button>${tip('job-backfill')}</span>
            <span class="jobwrap"><button data-act="/admin/sync-subscribers" class="ghost">Sync subscribers</button>${tip('job-sync')}</span>
            <span class="jobwrap"><button data-act="/admin/run-weekly" class="ghost">Generate weekly digest</button>${tip('job-weekly')}</span>
            <span class="jobwrap"><button data-act="/admin/publish-digest" class="ghost">Publish digest draft</button>${tip('job-publish')}</span>
          </div>
          <p class="muted" style="font-size:12px;margin:12px 0 0">Tip extraction and digest drafting cost AI budget and defer when over cap; polling, backfill and sync are free. Polling only queues items — new tips appear after the queue extracts them.${tip('jobs-output')}</p>
          <pre id="out" class="muted" style="margin-top:10px">Action results appear here · reload the page to see updated metrics.</pre></div></section>
      </div>
    </div>
  </div>${ACTION_SCRIPT}`;
  return shell('Dashboard', body);
}

// ── Approvals view ───────────────────────────────────────────────────
export async function adminApprovals(env: Env): Promise<Response> {
  const live = await proposedIntents(env);
  const reviewTips = (await env.DB.prepare(`SELECT COUNT(*) n FROM tips WHERE status='review'`).first<{ n: number }>())?.n ?? 0;
  const failed = (await env.DB.prepare(
    `SELECT ti.tip_id, ti.ticker, ti.reason FROM trade_intents ti WHERE ti.status='failed' ORDER BY ti.created_at DESC LIMIT 20`,
  ).all<{ tip_id: string; ticker: string; reason: string | null }>()).results ?? [];

  const body = `<div class="app">${railNav('approvals')}<div class="main">
    <header class="topbar"><div class="search">${icon('inbox', 15)}<span>Approvals — what needs you</span></div><button onclick="location.reload()">↻ Refresh</button></header>
    <div class="content">
      <h2 style="margin-top:0">Live trades awaiting approval ${live.length ? `<span class="pill" style="background:var(--bad);color:#fff;border:none">${live.length}</span>` : ''}${tip('appr-live')}</h2>
      <div class="panel">${liveTradeTable(live)}</div>
      <pre id="out" class="muted">Approve places a real (capped) Alpaca order via the single execute path. Reject leaves the call as a paper-only scoring record.</pre>

      ${failed.length ? `<h2>Failed real buys (retryable) <span class="pill">${failed.length}</span>${tip('appr-failed')}</h2>
      <div class="panel"><table><thead><tr><th>Ticker</th><th>Reason</th><th></th></tr></thead><tbody>
      ${failed.map((f) => `<tr><td><b>${escapeHtml(f.ticker)}</b></td><td class="muted">${escapeHtml(f.reason || '')}</td>
        <td><button data-act="/admin/reject-trade?tip=${encodeURIComponent(f.tip_id)}" class="ghost">Dismiss</button></td></tr>`).join('')}
      </tbody></table><p class="muted" style="font-size:.78rem">Retry-on-approve and re-propose ship in a later slice; for now a failed intent stays as paper and can be dismissed.</p></div>` : ''}

      <h2>Tip review queue <span class="pill">${reviewTips}</span>${tip('appr-review')}</h2>
      <div class="panel"><p class="muted">${reviewTips} unresolved tip(s) (abstained security). View-only for now — the resolve / add-alias / dismiss workbench is Slice 2.</p></div>
    </div>${ACTION_SCRIPT}</div></div>`;
  return shell('Approvals', body);
}

// ── Errors view ──────────────────────────────────────────────────────
interface OpsRow { id: string; detail: string | null; created_at: string }

/** Normalise an error row into a stable signature so identical failures group together. */
function errSignature(detail: string | null): { at: string; sig: string } {
  if (!detail) return { at: 'unknown', sig: 'unknown' };
  let o: Record<string, unknown> | null = null;
  try { o = JSON.parse(detail) as Record<string, unknown>; } catch { return { at: 'unparsed', sig: detail.slice(0, 70) }; }
  const at = String(o.at ?? o.stage ?? 'unknown');
  let msg = o.err != null ? String(o.err) : o.status != null ? `status ${String(o.status)}` : '';
  msg = msg
    .replace(/\b[A-Z0-9]{1,6}\.[A-Z]{2,5}\b/g, '<sym>') // TICKER.EXCHANGE
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\b\d{4}-\d{2}-\d{2}([T ][\d:.]+Z?)?\b/g, '<time>');
  return { at, sig: msg ? `${at} · ${msg}` : at };
}

/** Operator-facing diagnosis for known failure signatures. */
function errHint(sig: string): string | null {
  if (/EODHD/.test(sig) && /\b40[0-9]\b/.test(sig)) {
    if (/\b402\b/.test(sig)) return 'EODHD market-data API returned 402 (Payment Required). This is account-wide — either the EODHD subscription lapsed/payment failed, or the daily API-call limit is exhausted (each daily valuation calls EODHD per security). Check the EODHD account plan + daily usage, or the EODHD_API_KEY secret. While 402 persists, NAV, returns and hit-rate stop updating.';
    if (/\b401\b/.test(sig)) return 'EODHD returned 401 (Unauthorized) — the EODHD_API_KEY secret is missing or wrong. Re-set it with wrangler secret put EODHD_API_KEY.';
    return 'EODHD market-data API is rejecting requests — pricing, NAV and returns will not update until it recovers.';
  }
  if (/fetchFeed/.test(sig) && /\b(429|5\d\d)\b/.test(sig)) return 'A producer feed is rate-limiting (429) or down (5xx). Usually transient and external — the poller retries next cycle. Persistent failures may mean a dead/blocked feed URL.';
  return null;
}

export async function adminErrors(env: Env): Promise<Response> {
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  // created_at is ISO ('T'-separated) — compare against an ISO bound, NOT SQLite datetime('now')
  // (space-separated, which string-compares as if every row were recent).
  const rowsOf = async (kind: string) => (await env.DB.prepare(
    `SELECT id, detail, created_at FROM ops_events WHERE kind=? AND created_at >= ? ORDER BY created_at DESC LIMIT 500`,
  ).bind(kind, weekAgo).all<OpsRow>()).results ?? [];
  const errorRows = await rowsOf('error');
  const warnRows = await rowsOf('warn');
  const eodhdCalls = await eodhdCallsToday(env).catch(() => null);
  const eodhdBudget = eodhdCallBudget(env);
  // A group is "resolved" if its newest occurrence predates the most recent successful valuation —
  // i.e. you've since fixed it and a run has succeeded. Used to stop alarming on already-fixed issues.
  const lastValuedAt = (await env.DB.prepare(`SELECT MAX(last_valued_at) m FROM positions`).first<{ m: string | null }>())?.m ?? null;

  // Group a row list by normalised signature.
  const groupRows = (list: OpsRow[]) => {
    const groups = new Map<string, { at: string; sig: string; n24: number; n7: number; last: string }>();
    for (const r of list) {
      const { at, sig } = errSignature(r.detail);
      const g = groups.get(sig) ?? { at, sig, n24: 0, n7: 0, last: r.created_at };
      g.n7 += 1;
      if (r.created_at >= dayAgo) g.n24 += 1;
      if (r.created_at > g.last) g.last = r.created_at;
      groups.set(sig, g);
    }
    return [...groups.values()]
      .map((g) => ({ ...g, resolved: !!lastValuedAt && g.last < lastValuedAt }))
      .sort((a, b) => Number(a.resolved) - Number(b.resolved) || b.n24 - a.n24 || b.n7 - a.n7);
  };
  const ranked = groupRows(errorRows);
  const warnRanked = groupRows(warnRows);
  const activeErr = ranked.filter((g) => !g.resolved);
  const n24total = errorRows.filter((r) => r.created_at >= dayAgo).length;
  // Only surface a red "Likely cause" banner for ACTIVE (unresolved) error groups.
  const hints = [...new Set(activeErr.map((g) => errHint(g.sig)).filter(Boolean) as string[])];

  const groupTable = (rk: typeof ranked) => `<table><thead><tr><th>Status</th><th>Stage</th><th>Signature</th><th class="num">24h</th><th class="num">7d</th><th>Last seen</th></tr></thead><tbody>
    ${rk.map((g) => `<tr>
      <td>${g.resolved ? '<span class="pill" style="color:var(--good);border-color:var(--good)">resolved ✓</span>' : '<span class="pill" style="background:var(--bad);color:#fff;border:none">active</span>'}</td>
      <td><span class="pill">${escapeHtml(g.at)}</span></td>
      <td class="muted" style="white-space:normal;max-width:380px;font-size:.82rem">${escapeHtml(g.sig)}</td>
      <td class="num"><b>${g.n24}</b></td><td class="num">${g.n7}</td>
      <td class="mono muted" style="font-size:.74rem">${escapeHtml(g.last.slice(0, 16).replace('T', ' '))}</td></tr>`).join('')}
    </tbody></table>`;

  const body = `<div class="app">${railNav('overview')}<div class="main">
    <header class="topbar"><div class="search">${icon('pulse', 15)}<span>Errors — what is breaking</span></div>
      <a href="/admin" class="pill" style="text-decoration:none">← Overview</a>
      <button onclick="location.reload()">↻ Refresh</button></header>
    <div class="content">
      ${hints.length
        ? hints.map((h) => `<div class="panel" style="border-color:var(--bad);border-width:2px;background:color-mix(in srgb, var(--bad) 7%, var(--card));padding:14px 16px"><b style="color:var(--bad)">Likely cause:</b> ${escapeHtml(h)}</div>`).join('')
        : `<div class="panel" style="border-color:var(--good);background:color-mix(in srgb, var(--good) 6%, var(--card));padding:14px 16px"><b style="color:var(--good)">No active errors.</b> ${ranked.length ? 'Everything below was resolved by a later successful run — shown for history.' : 'Nothing has failed recently. ✓'}</div>`}

      <div class="grid stats">
        <div class="card"><div class="k">EODHD calls today</div><div class="v">${eodhdCalls == null ? '–' : eodhdCalls}${eodhdBudget ? `<small>/${eodhdBudget}</small>` : ''}</div><div class="sub">soft cap before a run defers${eodhdBudget ? '' : ' (uncapped)'}</div></div>
        <div class="card"><div class="k">Active errors</div><div class="v">${activeErr.length}</div><div class="sub">unresolved groups (${n24total} events 24h)</div></div>
        <div class="card"><div class="k">Transient (7d)</div><div class="v">${warnRows.length}</div><div class="sub">auto-retried / backed off</div></div>
      </div>

      <h2>Error groups <span class="muted" style="font-weight:400;font-size:.8em">· ${activeErr.length} active · ${ranked.length} total (7d)</span></h2>
      <div class="panel">${ranked.length === 0 ? '<p class="muted">No real errors in the last 7 days. ✓</p>' : groupTable(ranked)}</div>

      <h2>Transient / external <span class="muted" style="font-weight:400;font-size:.8em">· auto-retried — not alarming</span></h2>
      <div class="panel">${warnRanked.length === 0 ? '<p class="muted">None.</p>' : groupTable(warnRanked)}</div>

      <h2>Recent errors (raw)</h2>
      <div class="panel">${errorRows.length === 0 ? '<p class="muted">None.</p>' :
        `<table><thead><tr><th>When (UTC)</th><th>Detail</th></tr></thead><tbody>
        ${errorRows.slice(0, 100).map((r) => `<tr><td class="mono muted" style="font-size:.72rem;white-space:nowrap">${escapeHtml(r.created_at.slice(0, 19).replace('T', ' '))}</td>
          <td class="mono" style="white-space:normal;word-break:break-word;font-size:.74rem">${escapeHtml(r.detail || '')}</td></tr>`).join('')}
        </tbody></table>${errorRows.length > 100 ? `<p class="muted" style="font-size:.78rem">Showing 100 of ${errorRows.length} (7-day window, capped at 500).</p>` : ''}`}</div>
    </div></div></div>`;
  return shell('Errors', body);
}

// ── Trading view ─────────────────────────────────────────────────────
export async function adminTrading(env: Env): Promise<Response> {
  const mode = await alpacaMode(env);
  const paused = await tradingPaused(env);
  const live = await proposedIntents(env);
  const realCount = (await env.DB.prepare(`SELECT COUNT(*) n FROM positions WHERE mode='real'`).first<{ n: number }>())?.n ?? 0;
  const openNotional = (await env.DB.prepare(
    `SELECT COALESCE(SUM(ti.notional_cents),0) c FROM trade_intents ti JOIN positions p ON p.tip_id=ti.tip_id WHERE ti.status='executed' AND p.status='open'`,
  ).first<{ c: number }>())?.c ?? 0;
  const ordersToday = (await env.DB.prepare(
    `SELECT COUNT(*) n FROM trade_intents WHERE status='executed' AND substr(executed_at,1,10)=?`,
  ).bind(dateOnly(nowISO())).first<{ n: number }>())?.n ?? 0;
  // Approved-but-not-yet-executed (cap-deferred or awaiting the next sweep) — must stay visible.
  const awaitingExec = (await env.DB.prepare(`SELECT COUNT(*) n FROM trade_intents WHERE status='approved'`).first<{ n: number }>())?.n ?? 0;
  const maxDaily = Math.max(1, Number(env.MAX_DAILY_TRADES) || 5);
  const maxOpenCents = Math.max(100, Number(env.MAX_OPEN_REAL_NOTIONAL_CENTS) || 20000);
  const real = (await env.DB.prepare(
    `SELECT sec.ticker, p.broker_order_id, p.real_buy_status, p.status, ti.notional_cents
       FROM positions p JOIN securities sec ON sec.id=p.security_id LEFT JOIN trade_intents ti ON ti.tip_id=p.tip_id
      WHERE p.mode='real' ORDER BY p.entry_at DESC LIMIT 20`,
  ).all<{ ticker: string; broker_order_id: string | null; real_buy_status: string | null; status: string; notional_cents: number | null }>()).results ?? [];

  const card = (k: string, v: string, sub = '', tipKey = '') => `<div class="card"><div class="k">${k}${tipKey ? tip(tipKey) : ''}</div><div class="v">${v}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  const body = `<div class="app">${railNav('trading')}<div class="main">
    <header class="topbar"><div class="search">${icon('coins', 15)}<span>Trading — brokerage posture &amp; live exposure</span></div>
      <div>${postureBadge(mode, paused)}</div></header>
    <div class="content">
      ${mode === 'live' ? `<div class="panel" style="border-color:var(--bad);border-width:2px"><b style="color:var(--bad)">LIVE mode:</b> every approved trade places real money (≤$${MAX_NOTIONAL_USD}/order).</div>` : ''}

      <h2 style="margin-top:0">Controls</h2>
      <div class="panel"><div class="actions">
        ${paused
          ? `<span class="jobwrap"><button data-act="/admin/trading-resume" data-confirm="Resume live trading?">▶ Resume trading</button>${tip('trade-killswitch')}</span>`
          : `<span class="jobwrap"><button data-act="/admin/trading-pause" data-confirm="Pause ALL real trading (kill-switch)?">⛔ Pause trading</button>${tip('trade-killswitch')}</span>`}
        <span class="muted" style="margin:0 .4rem">Mode:${tip('trade-mode')}</span>
        <button class="ghost" data-act="/admin/set-alpaca-mode?mode=off" data-confirm="Set broker mode to OFF (no orders)?">Off</button>
        <button class="ghost" data-act="/admin/set-alpaca-mode?mode=paper" data-confirm="Set broker mode to PAPER (simulated)?">Paper</button>
        <button data-act="/admin/set-alpaca-mode?mode=live" data-confirm="Set broker mode to LIVE — real money on every APPROVED trade. Continue?">Live</button>
      </div><pre id="out" class="muted" style="margin-top:12px">Mode + kill-switch are KV overrides (no redeploy). The kill-switch fails closed.</pre></div>

      <h2>Exposure</h2>
      <div class="grid stats">
        ${card('Pending approval', String(live.length), live.length ? '<a href="/admin/approvals">review queue →</a>' : 'none', 'exp-pending')}
        ${card('Approved · awaiting exec', String(awaitingExec), awaitingExec ? 'sweeping (or cap-deferred)' : 'none', 'exp-approved')}
        ${card('Real positions', String(realCount), 'open + closed', 'exp-realpos')}
        ${card('Open real exposure', `$${(openNotional / 100).toFixed(0)}`, `live cap $${(maxOpenCents / 100).toFixed(0)}`, 'exp-openreal')}
        ${card('Orders today', `${ordersToday}<small>/${maxDaily}</small>`, `per-order cap $${MAX_NOTIONAL_USD}`, 'exp-orders')}
      </div>

      <h2>Pending live trades${tip('appr-live')}</h2>
      <div class="panel">${liveTradeTable(live)}</div>

      <h2>Real positions${tip('trade-realtable')}</h2>
      <div class="panel">${real.length === 0 ? '<p class="muted">No real (broker) positions yet.</p>' :
        `<table><thead><tr><th>Ticker</th><th>Order id</th><th>Buy status</th><th>Position</th><th class="num">Notional</th></tr></thead><tbody>
        ${real.map((p) => `<tr><td><b>${escapeHtml(p.ticker)}</b></td><td class="mono muted" style="font-size:.74rem">${escapeHtml((p.broker_order_id || '–').slice(0, 14))}</td>
          <td><span class="pill">${escapeHtml(p.real_buy_status || '–')}</span></td><td>${escapeHtml(p.status)}</td>
          <td class="num">${p.notional_cents == null ? '–' : '$' + (p.notional_cents / 100).toFixed(2)}</td></tr>`).join('')}
        </tbody></table>`}</div>
    </div>${ACTION_SCRIPT}</div></div>`;
  return shell('Trading', body);
}

// ── Sources view ─────────────────────────────────────────────────────
interface SourceRow {
  id: string; name: string; medium: string; feed_url: string | null; bluesky_did: string | null;
  ingest_method: string; active: number | null; tos_checked: number | null; tos_checked_at: string | null;
  ingest_from: string | null;
  last_success_at: string | null; last_error: string | null; consecutive_failures: number | null;
  tips: number; review: number;
}

/** Create + list + activate/deactivate sources + ToS sign-off + health. Sources precede their tips (FK). */
export async function adminSources(env: Env): Promise<Response> {
  const sources = (await env.DB.prepare(
    `SELECT s.id, s.name, s.medium, s.feed_url, s.bluesky_did, s.ingest_method, s.active,
            s.tos_checked, s.tos_checked_at, s.ingest_from, s.last_success_at, s.last_error, s.consecutive_failures,
            COUNT(t.id) tips, SUM(CASE WHEN t.status='review' THEN 1 ELSE 0 END) review
       FROM sources s LEFT JOIN tips t ON t.source_id = s.id
      GROUP BY s.id ORDER BY (s.active IS NULL OR s.active=1) DESC, s.name LIMIT 200`,
  ).all<SourceRow>()).results ?? [];
  const autoMethods = new Set(['rss_fulltext', 'podcast_transcript', 'bluesky']);
  const needsToS = sources.filter((s) => (s.active == null || s.active === 1) && autoMethods.has(s.ingest_method) && s.tos_checked !== 1).length;

  const methodPill = (m: string) => `<span class="pill">${escapeHtml(m)}</span>`;
  const body = `<div class="app">${railNav('sources')}<div class="main">
    <header class="topbar"><div class="search">${icon('rss', 15)}<span>Sources — where tips come from</span></div>
      <button onclick="location.reload()">↻ Refresh</button></header>
    <div class="content">
      ${needsToS ? `<div class="panel" style="border-color:#c98a00;background:color-mix(in srgb, #c98a00 7%, var(--card))"><b style="color:#c98a00">${needsToS} auto-poll source${needsToS === 1 ? '' : 's'} not ToS-checked</b> — these are <b>not being polled</b>. Review each feed's terms, then click <b>Mark ToS-checked</b> to start ingestion.</div>` : ''}
      <section class="card"><header><div><h3>Add a source${tip('src-add')}</h3><p class="csub">A source must exist before its first tip. RSS / podcast / Bluesky sources are auto-polled by the hourly cron — once ToS-checked.</p></div></header>
        <div class="body">
          <div class="formgrid">
            <div class="field"><label>Name *</label><input id="s-name" placeholder="e.g. The Science of Hitting"></div>
            <div class="field"><label>Ingest method *</label><select id="s-method">
              <option value="manual">manual — you paste tips by hand</option>
              <option value="rss_fulltext">rss_fulltext — auto-poll a blog/Substack RSS</option>
              <option value="podcast_transcript">podcast_transcript — auto-poll a podcast RSS</option>
              <option value="bluesky">bluesky — auto-poll a Bluesky account</option>
            </select></div>
            <div class="field"><label>Home URL</label><input id="s-home" placeholder="https://example.com"></div>
            <div class="field"><label>Feed URL <span class="hint">(required for rss/podcast)</span></label>
              <div style="display:flex;gap:6px"><input id="s-feed" placeholder="https://example.com/feed">
              <button class="ghost" type="button" id="s-findfeed" style="white-space:nowrap">Find feed</button></div></div>
            <div class="field"><label>Bluesky DID <span class="hint">(required for bluesky)</span></label><input id="s-did" placeholder="did:plc:..."></div>
            <div class="field"><label>Locale</label><input id="s-locale" placeholder="AU | US | UK | CA"></div>
          </div>
          <button id="s-submit">Add source</button>
          <pre id="out" class="muted" style="margin-top:12px">Verify each feed's terms, then Mark ToS-checked to start polling. New sources ingest only items published after you start them — use Backfill for bounded history.</pre>
        </div></section>

      <section class="card"><header><div><h3>Sources${tip('src-list')}</h3><p class="csub">${sources.length} total · ToS-check to enable polling · pause to stop without deleting</p></div></header>
        <div class="body">${sources.length === 0 ? '<p class="muted">No sources yet.</p>' :
          `<table><thead><tr><th>Name</th><th>Method</th><th>ToS${tip('src-tos')}</th><th>Health${tip('src-health')}</th><th class="num">Tips</th><th>From${tip('src-from')}</th><th>Status</th><th></th></tr></thead><tbody>
          ${sources.map((s) => {
            const on = s.active == null || s.active === 1;
            const auto = autoMethods.has(s.ingest_method);
            const tosOk = s.tos_checked === 1;
            const tips = s.tips || 0;
            const abstainPct = tips ? Math.round(((s.review || 0) / tips) * 100) : 0;
            const fails = s.consecutive_failures || 0;
            // Health only meaningful for auto-polled sources.
            const health = !auto ? '<span class="muted" style="font-size:.74rem">manual</span>'
              : !tosOk ? '<span class="muted" style="font-size:.74rem">—</span>'
              : fails >= 3 ? `<span class="pill" style="background:var(--bad);color:#fff;border:none" title="${escapeHtml(s.last_error || '')}">failing ×${fails}</span>`
              : s.last_success_at ? `<span class="pill" style="color:var(--good);border-color:var(--good)">ok</span> <span class="mono muted" style="font-size:.7rem">${escapeHtml(s.last_success_at.slice(0, 10))}</span>`
              : '<span class="muted" style="font-size:.74rem">not polled yet</span>';
            const tosCell = !auto ? '<span class="muted" style="font-size:.74rem">n/a</span>'
              : tosOk ? `<span class="pill" style="color:var(--good);border-color:var(--good)" title="checked ${escapeHtml(s.tos_checked_at || '')}">✓</span>`
              : '<span class="pill" style="background:#c98a00;color:#fff;border:none">unchecked</span>';
            return `<tr>
              <td><b>${escapeHtml(s.name)}</b> <span class="muted" style="font-size:.72rem;display:block">${escapeHtml(s.feed_url || s.bluesky_did || s.medium)}</span></td>
              <td>${methodPill(s.ingest_method)}</td>
              <td>${tosCell}${auto && !tosOk ? ` <button class="ghost" data-tos="${encodeURIComponent(s.id)}" style="padding:5px 9px;font-size:.74rem">Mark ToS-checked</button>` : ''}</td>
              <td>${health}</td>
              <td class="num">${tips}${tips && abstainPct ? ` <span class="muted" style="font-size:.7rem">${abstainPct}% abst</span>` : ''}</td>
              <td>${!auto ? '<span class="muted" style="font-size:.74rem">—</span>' : `<span class="mono muted" style="font-size:.7rem">${s.ingest_from ? 'from ' + escapeHtml(s.ingest_from.slice(0, 10)) : 'all history'}</span>${tosOk ? `<div style="margin-top:4px;display:flex;gap:4px">${['30', '90', '365'].map((d) => `<button class="ghost" data-backfill="${encodeURIComponent(s.id)}" data-days="${d}"${s.ingest_method === 'podcast_transcript' ? ' data-pod="1"' : ''} style="padding:4px 7px;font-size:.7rem">${d === '365' ? '1y' : d + 'd'}</button>`).join('')}</div>` : ''}`}</td>
              <td>${on ? '<span class="pill" style="color:var(--good);border-color:var(--good)">active</span>' : '<span class="pill">paused</span>'}</td>
              <td>${on
                ? `<button class="ghost" data-toggle="/admin/toggle-source?id=${encodeURIComponent(s.id)}&active=0">Pause</button>`
                : `<button class="ghost" data-toggle="/admin/toggle-source?id=${encodeURIComponent(s.id)}&active=1">Resume</button>`}</td>
            </tr>`;
          }).join('')}</tbody></table>`}</div></section>
    </div>${ACTION_SCRIPT}
    <script>
      (function(){
        var out=document.getElementById('out');
        document.querySelectorAll('button[data-toggle]').forEach(function(b){
          b.addEventListener('click', function(){
            b.disabled=true; out.textContent='Updating…';
            fetch(b.getAttribute('data-toggle'),{method:'POST'}).then(function(r){return r.json();})
              .then(function(j){ if(j.ok){ location.reload(); } else { b.disabled=false; out.textContent='Error: '+(j.error||'failed'); } })
              .catch(function(e){ b.disabled=false; out.textContent='Error: '+e; });
          });
        });
        document.querySelectorAll('button[data-tos]').forEach(function(b){
          b.addEventListener('click', function(){
            var note=prompt('Record the ToS check for this source (short note — where you verified its terms allow this use):','');
            if(note===null) return; // cancelled
            b.disabled=true; out.textContent='Recording ToS check…';
            fetch('/admin/set-tos?id='+b.getAttribute('data-tos')+'&note='+encodeURIComponent(note),{method:'POST'})
              .then(function(r){return r.json();})
              .then(function(j){ if(j.ok){ location.reload(); } else { b.disabled=false; out.textContent='Error: '+(j.error||'failed'); } })
              .catch(function(e){ b.disabled=false; out.textContent='Error: '+e; });
          });
        });
        document.querySelectorAll('button[data-backfill]').forEach(function(b){
          b.addEventListener('click', function(){
            var days=b.getAttribute('data-days');
            var msg='Backfill the last '+days+' days for this source? It ingests + scores past tips (look-ahead-free).';
            if(b.getAttribute('data-pod')) msg='Backfill '+days+' days of PODCAST episodes? This transcribes them via Deepgram ($ — paced by the daily budget). Continue?';
            if(!confirm(msg)) return;
            b.disabled=true; out.textContent='Setting backfill window…';
            fetch('/admin/backfill-source?id='+b.getAttribute('data-backfill')+'&days='+days,{method:'POST'})
              .then(function(r){return r.json();})
              .then(function(j){ if(j.ok){ location.reload(); } else { b.disabled=false; out.textContent='Error: '+(j.error||'failed'); } })
              .catch(function(e){ b.disabled=false; out.textContent='Error: '+e; });
          });
        });
        document.getElementById('s-findfeed').addEventListener('click', function(){
          var home=document.getElementById('s-home').value.trim() || document.getElementById('s-feed').value.trim();
          if(!home){ out.textContent='Enter a Home URL first.'; return; }
          out.textContent='Searching for a feed…';
          fetch('/admin/find-feed',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:home})})
            .then(function(r){return r.json();}).then(function(j){
              if(j.feeds && j.feeds.length){ document.getElementById('s-feed').value=j.feeds[0]; out.textContent='Found: '+j.feeds.join(', '); }
              else out.textContent='No feed found — paste the feed URL manually.';
            }).catch(function(e){ out.textContent='Error: '+e; });
        });
        document.getElementById('s-submit').addEventListener('click', function(){
          var b={ name:document.getElementById('s-name').value.trim(),
                  ingest_method:document.getElementById('s-method').value,
                  home_url:document.getElementById('s-home').value.trim()||undefined,
                  feed_url:document.getElementById('s-feed').value.trim()||undefined,
                  bluesky_did:document.getElementById('s-did').value.trim()||undefined,
                  locale:document.getElementById('s-locale').value.trim()||undefined };
          if(!b.name){ out.textContent='Name is required.'; return; }
          out.textContent='Adding…'; this.disabled=true; var btn=this;
          fetch('/admin/add-source',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)})
            .then(function(r){return r.json();}).then(function(j){
              btn.disabled=false;
              if(j.ok){ out.textContent='Added ✓ — reloading…'; location.reload(); }
              else out.textContent='Error: '+(j.error||'')+(j.detail?' — '+j.detail:'');
            }).catch(function(e){ btn.disabled=false; out.textContent='Error: '+e; });
        });
      })();
    </script></div></div>`;
  return shell('Sources', body);
}

// ── Add-tip view ─────────────────────────────────────────────────────
/** Paste a tip found on a blog/podcast, pick its source, set the REAL publish date, submit. */
export async function adminAddTip(env: Env): Promise<Response> {
  const sources = (await env.DB.prepare(
    `SELECT id, name FROM sources WHERE active IS NULL OR active=1 ORDER BY name LIMIT 200`,
  ).all<{ id: string; name: string }>()).results ?? [];

  const body = `<div class="app">${railNav('addtip')}<div class="main">
    <header class="topbar"><div class="search">${icon('plus', 15)}<span>Add a tip — paste one you found</span></div>
      <a href="/admin/sources" class="pill" style="text-decoration:none">+ Source</a>
      <button onclick="location.reload()">↻ Refresh</button></header>
    <div class="content">
      <section class="card"><header><div><h3>Add a tip${tip('tip-add')}</h3><p class="csub">Goes through the same pipeline as automated tips: Claude extracts → resolves the security → opens a paper position at the first bar AFTER the publish date.</p></div></header>
        <div class="body">
          ${sources.length === 0 ? '<p class="neg">No active sources yet — <a href="/admin/sources">add a source</a> first.</p>' : `
          <div class="field"><label>Source *</label><select id="t-source">${sources.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('')}</select></div>
          <div class="formgrid">
            <div class="field"><label>Publish date * ${tip('tip-date')}</label><input id="t-date" type="date" required><span class="hint">The REAL date the tip was published — entry is the first market bar after this. Not today unless it's genuinely today.</span></div>
            <div class="field"><label>Source URL</label><input id="t-url" placeholder="https://… (where you found it)"></div>
          </div>
          <div class="field"><label>Tip text *</label><textarea id="t-text" placeholder="Paste the quote / segment that contains the call…"></textarea></div>
          <button id="t-submit">Submit tip</button>
          <pre id="out" class="muted" style="margin-top:12px">After submitting, the tip extracts + resolves within seconds. Click “Run daily” on the Overview to open + value it. Unresolved tips land in the review queue.</pre>`}
        </div></section>
    </div>
    <script>
      (function(){
        var btn=document.getElementById('t-submit'); if(!btn) return;
        var out=document.getElementById('out');
        btn.addEventListener('click', function(){
          var date=document.getElementById('t-date').value;
          var text=document.getElementById('t-text').value.trim();
          if(!date){ out.textContent='Publish date is required.'; return; }
          if(!text){ out.textContent='Tip text is required.'; return; }
          var b={ source_id:document.getElementById('t-source').value,
                  text:text,
                  url:document.getElementById('t-url').value.trim()||undefined,
                  detected_at:new Date(date+'T00:00:00Z').toISOString() };
          out.textContent='Submitting…'; btn.disabled=true;
          fetch('/ingest/human',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)})
            .then(function(r){return r.json();}).then(function(j){
              btn.disabled=false; out.textContent=JSON.stringify(j,null,2);
              if(j.ok && !j.duplicate){ document.getElementById('t-text').value=''; document.getElementById('t-url').value=''; }
            }).catch(function(e){ btn.disabled=false; out.textContent='Error: '+e; });
        });
      })();
    </script></div></div>`;
  return shell('Add tip', body);
}

// ── Newsletter view ──────────────────────────────────────────────────
/** One screen to manage the weekly issue: status, generate, preview, push, history, subscribers. */
export async function adminNewsletter(env: Env): Promise<Response> {
  const week = isoWeek();
  const draft = await env.RAW_MEDIA.get(`digests/${week}.html`).catch(() => null);
  const hasDraft = !!draft;
  const pubs = (await env.DB.prepare(
    `SELECT week, beehiiv_post_id, status, detail, created_at FROM digest_publications ORDER BY week DESC LIMIT 12`,
  ).all<{ week: string; beehiiv_post_id: string | null; status: string; detail: string | null; created_at: string }>()).results ?? [];
  const subTotal = (await env.DB.prepare(`SELECT COUNT(*) n FROM subscribers WHERE status='active'`).first<{ n: number }>())?.n ?? 0;
  const subUnsynced = (await env.DB.prepare(`SELECT COUNT(*) n FROM subscribers WHERE status='active' AND beehiiv_synced_at IS NULL`).first<{ n: number }>())?.n ?? 0;
  const beehiivOn = beehiivConfigured(env);
  const wk = encodeURIComponent(week);
  const thisWeekPub = pubs.find((p) => p.week === week);

  const body = `<div class="app">${railNav('newsletter')}<div class="main">
    <header class="topbar"><div class="search">${icon('mail', 15)}<span>Newsletter — ${escapeHtml(week)}</span></div>
      <a href="/admin/subscribers" class="pill" style="text-decoration:none">Subscribers</a>
      <button onclick="location.reload()">↻ Refresh</button></header>
    <div class="content">

      <div class="grid stats">
        <div class="card"><div class="k">Active subscribers${tip('nl-subs')}</div><div class="v">${subTotal}</div><div class="sub">${subUnsynced ? `${subUnsynced} not synced to beehiiv` : 'all synced'}</div></div>
        <div class="card"><div class="k">This week's draft</div><div class="v">${hasDraft ? 'ready' : '—'}</div><div class="sub">${hasDraft ? 'stored in R2' : 'not generated yet'}</div></div>
        <div class="card"><div class="k">beehiiv</div><div class="v">${beehiivOn ? 'on' : 'off'}</div><div class="sub">${beehiivOn ? 'connected' : 'not configured — R2 draft only'}</div></div>
        <div class="card"><div class="k">Pushed this week</div><div class="v">${thisWeekPub?.status === 'drafted' ? 'yes' : 'no'}</div><div class="sub">${thisWeekPub ? escapeHtml(thisWeekPub.status) : 'not pushed'}</div></div>
      </div>

      ${thisWeekPub?.status === 'failed' ? `<div class="panel" style="border-color:var(--bad);background:color-mix(in srgb, var(--bad) 6%, var(--card))"><b style="color:var(--bad)">Last beehiiv push failed${tip('nl-failed')}:</b> <span class="muted">${escapeHtml(thisWeekPub.detail || 'see ops events')}</span> — the issue is still in R2; preview it and paste into beehiiv manually.</div>` : ''}

      <section class="card"><header><div><h3>This week — ${escapeHtml(week)}${tip('nl-actions')}</h3><p class="csub">Generation is automatic each week. Publishing creates a beehiiv DRAFT only — you review + send inside beehiiv.</p></div></header>
        <div class="body"><div class="actions">
          <button data-act="/admin/run-weekly?week=${wk}${hasDraft ? '&force=1' : ''}"${hasDraft ? ' data-confirm="Regenerate this week\'s issue from the latest data? Overwrites the stored draft (free — no LLM)."' : ''}>${hasDraft ? 'Regenerate this week' : 'Generate this week'}</button>
          ${hasDraft ? `<a class="btn ghost" href="/admin/digest?week=${wk}" target="_blank" rel="noopener">Preview draft ↗</a>` : ''}
          <button class="ghost" data-act="/admin/publish-digest?week=${wk}" data-confirm="Create a beehiiv DRAFT for ${escapeHtml(week)}? It will NOT send — you review + send in beehiiv.">Push to beehiiv draft</button>
          ${hasDraft ? `<button class="ghost" data-act="/admin/send-test-digest?week=${wk}">Send test to me</button>` : ''}
          <button class="ghost" data-act="/admin/sync-subscribers">Sync subscribers${subUnsynced ? ` (${subUnsynced})` : ''}</button>
        </div><pre id="out" class="muted" style="margin-top:12px">The issue renders deterministically from the ledger (the Editorial email template) — free, no LLM, and it passes the compliance gate. A blocked issue shows its reason here. beehiiv calls are free and never auto-send.</pre></div></section>

      ${hasDraft ? `<section class="card"><header><div><h3>Preview — ${escapeHtml(week)}</h3><p class="csub">The stored draft, exactly as it would paste into beehiiv</p></div></header>
        <div class="body"><iframe src="/admin/digest?week=${wk}" style="width:100%;height:540px;border:1px solid var(--line);border-radius:var(--r-md);background:#fff"></iframe></div></section>` : ''}

      <section class="card"><header><div><h3>Publish history${tip('nl-history')}</h3><p class="csub">Last 12 issues</p></div></header>
        <div class="body">${pubs.length === 0 ? '<p class="muted">No issues pushed to beehiiv yet.</p>' :
          `<table><thead><tr><th>Week</th><th>Status</th><th>beehiiv post</th><th>When</th><th></th></tr></thead><tbody>
          ${pubs.map((p) => `<tr>
            <td><b>${escapeHtml(p.week)}</b></td>
            <td>${p.status === 'drafted' ? '<span class="pill" style="color:var(--good);border-color:var(--good)">drafted ✓</span>' : `<span class="pill" style="background:var(--bad);color:#fff;border:none">failed</span> <span class="muted" style="font-size:.74rem">${escapeHtml((p.detail || '').slice(0, 60))}</span>`}</td>
            <td class="mono muted" style="font-size:.72rem">${p.beehiiv_post_id ? escapeHtml(p.beehiiv_post_id) : '–'}</td>
            <td class="mono muted" style="font-size:.72rem">${escapeHtml(p.created_at.slice(0, 16).replace('T', ' '))}</td>
            <td><a href="/admin/digest?week=${encodeURIComponent(p.week)}" target="_blank" rel="noopener" class="mono muted" style="font-size:.74rem">view ↗</a></td>
          </tr>`).join('')}</tbody></table>`}</div></section>
    </div>${ACTION_SCRIPT}</div></div>`;
  return shell('Newsletter', body);
}

// ── Subscribers view ─────────────────────────────────────────────────
/** Read-only subscriber list + sync. */
export async function adminSubscribers(env: Env): Promise<Response> {
  const [agg] = (await env.DB.prepare(
    `SELECT COUNT(*) total,
            SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) active,
            SUM(CASE WHEN status='unsubscribed' THEN 1 ELSE 0 END) unsubscribed,
            SUM(CASE WHEN status='active' AND beehiiv_synced_at IS NULL THEN 1 ELSE 0 END) unsynced
       FROM subscribers`,
  ).all<{ total: number; active: number; unsubscribed: number; unsynced: number }>()).results ?? [];
  const recent = (await env.DB.prepare(
    `SELECT email, source, status, beehiiv_synced_at, created_at FROM subscribers ORDER BY created_at DESC LIMIT 50`,
  ).all<{ email: string; source: string | null; status: string; beehiiv_synced_at: string | null; created_at: string }>()).results ?? [];

  const body = `<div class="app">${railNav('newsletter')}<div class="main">
    <header class="topbar"><div class="search">${icon('users', 15)}<span>Subscribers</span></div>
      <a href="/admin/newsletter" class="pill" style="text-decoration:none">← Newsletter</a>
      <button onclick="location.reload()">↻ Refresh</button></header>
    <div class="content">
      <div class="grid stats">
        <div class="card"><div class="k">Active</div><div class="v">${agg?.active ?? 0}</div><div class="sub">${agg?.total ?? 0} total</div></div>
        <div class="card"><div class="k">Unsynced</div><div class="v">${agg?.unsynced ?? 0}</div><div class="sub">active, not in beehiiv</div></div>
        <div class="card"><div class="k">Unsubscribed</div><div class="v">${agg?.unsubscribed ?? 0}</div><div class="sub">soft-removed</div></div>
      </div>
      <section class="card"><header><div><h3>Recent signups</h3><p class="csub">Latest 50</p></div></header>
        <div class="body"><div class="actions" style="margin-bottom:12px"><button class="ghost" data-act="/admin/sync-subscribers">Sync now${agg?.unsynced ? ` (${agg.unsynced})` : ''}</button></div>
        ${recent.length === 0 ? '<p class="muted">No subscribers yet.</p>' :
          `<table><thead><tr><th>Email</th><th>Source</th><th>Status</th><th>Synced</th><th>Joined</th></tr></thead><tbody>
          ${recent.map((s) => `<tr>
            <td class="mono" style="font-size:.78rem">${escapeHtml(s.email)}</td>
            <td class="muted" style="font-size:.78rem">${escapeHtml(s.source || '–')}</td>
            <td>${s.status === 'active' ? '<span class="pill" style="color:var(--good);border-color:var(--good)">active</span>' : `<span class="pill">${escapeHtml(s.status)}</span>`}</td>
            <td class="mono muted" style="font-size:.72rem">${s.beehiiv_synced_at ? '✓' : '–'}</td>
            <td class="mono muted" style="font-size:.72rem">${escapeHtml(s.created_at.slice(0, 10))}</td>
          </tr>`).join('')}</tbody></table>`}
        <pre id="out" class="muted" style="margin-top:12px">Sync pushes active, not-yet-synced subscribers to beehiiv (bounded, also runs daily).</pre></div></section>
    </div>${ACTION_SCRIPT}</div></div>`;
  return shell('Subscribers', body);
}
