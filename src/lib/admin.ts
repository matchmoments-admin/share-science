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
import { spentTodayCents } from './usage.js';
import { timingSafeEqual } from './db.js';
import { BRAND_HEAD } from './theme.js';

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
};
const icon = (name: string, size = 18) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICON[name] || ''}</svg>`;

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
  button { font: inherit; font-weight: 600; padding: 9px 16px; border: none; border-radius: var(--r-pill); background: var(--ink); color: var(--on-dark); cursor: pointer; }
  button.ghost { background: var(--card); color: var(--text); border: 1px solid var(--line); }
  button:hover { opacity: .9; } button:disabled { opacity: .5; }
  pre#out { font-family: var(--font-mono); font-size: 12px; background: var(--paper-2); border: 1px solid var(--line); border-radius: var(--r-md); padding: 11px; white-space: pre-wrap; word-break: break-word; min-height: 1rem; color: var(--text-2); }
  kbd { font-family: var(--font-mono); font-size: 10px; border: 1px solid var(--line); border-radius: 4px; padding: 2px 6px; color: var(--muted); }
</style></head><body>${body}</body></html>`;
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

/** Donut ring with a centre percentage. */
function ring(frac: number, label: string, size = 124, stroke = 11): string {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  return `<div style="position:relative;width:${size}px;height:${size}px;flex-shrink:0">
    <svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--line)" stroke-width="${stroke}"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--ink)" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${(frac * c).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg>
    <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">
      <div class="display" style="font-size:26px">${Math.round(frac * 100)}%</div>
      <div class="mono muted" style="font-size:9px;text-transform:uppercase;letter-spacing:.08em">${escapeHtml(label)}</div></div></div>`;
}

export async function adminDashboard(env: Env): Promise<Response> {
  const cap = Number(env.MAX_DAILY_COST_CENTS) || 0;
  const spent = await spentTodayCents(env).catch(() => 0);
  const spentPct = cap > 0 ? Math.min(100, Math.round((spent / cap) * 100)) : 0;

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
  const [err24] = await rows<{ n: number }>(env, `SELECT COUNT(*) n FROM ops_events WHERE kind='error' AND created_at >= datetime('now','-1 day')`);
  const [unsynced] = await rows<{ n: number }>(env, `SELECT COUNT(*) n FROM subscribers WHERE status='active' AND beehiiv_synced_at IS NULL`);
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

  const navLast = navSeries[navSeries.length - 1];
  const navRet = navLast ? navLast.nav_index / 1000 - 1 : null;
  const overallHit = hitAgg && hitAgg.n ? hitAgg.hits / hitAgg.n : null;
  const maxTips = Math.max(1, ...shares.map((s) => s.tips));

  const delta = (frac: number | null) => frac == null ? '' : `<span class="delta ${frac >= 0 ? 'up' : 'down'}">${pct(frac)}</span>`;
  const sign = (frac: number | null | undefined) => frac == null ? '<td class="num muted">–</td>' : `<td class="num ${frac >= 0 ? 'pos' : 'neg'}">${pct(frac)}</td>`;
  const DIM: Record<string, string> = { 'horizon:30': '30-day', 'horizon:90': '90-day', 'horizon:365': '365-day', primary: 'Primary horizon', 'conviction:90': 'Conviction-weighted' };

  // Needs-attention triage (operational).
  const triage = [
    err24?.n ? { sev: 'high', kind: 'Errors', t: `${err24.n} error event${err24.n === 1 ? '' : 's'} in 24h`, d: 'Check the activity feed / ops_events' } : null,
    spentPct >= 90 ? { sev: 'high', kind: 'Budget', t: `LLM spend at ${spentPct}% of cap`, d: 'Extraction will defer until the daily reset (00:00 UTC)' } : null,
    reviewTips?.n ? { sev: 'med', kind: 'Review', t: `${reviewTips.n} tip${reviewTips.n === 1 ? '' : 's'} need review`, d: 'Unresolved security — no position opened' } : null,
    pendPos?.n ? { sev: 'med', kind: 'Pipeline', t: `${pendPos.n} resolved tip${pendPos.n === 1 ? '' : 's'} awaiting a position`, d: 'Run the daily pass to open + value them' } : null,
    unsynced?.n ? { sev: 'low', kind: 'Newsletter', t: `${unsynced.n} subscriber${unsynced.n === 1 ? '' : 's'} not synced to beehiiv`, d: 'Runs in the daily cron, or sync now' } : null,
  ].filter(Boolean) as Array<{ sev: string; kind: string; t: string; d: string }>;
  const sevColor = (s: string) => s === 'high' ? 'var(--bad)' : s === 'med' ? '#c98a00' : 'var(--faint)';

  const dimGroups = ratings.reduce((acc: Record<string, typeof ratings>, r) => { (acc[r.dimension] ??= []).push(r); return acc; }, {});

  const body = `<div class="app">
    <nav class="rail">
      <div class="logo">S</div>
      <a class="on" href="/admin" title="Dashboard">${icon('grid')}</a>
      <a href="#sharers" title="Sharers">${icon('users')}</a>
      <a href="#shares" title="Shares">${icon('trend')}</a>
      <a href="#activity" title="Activity">${icon('pulse')}</a>
      <a href="#newsletter" title="Newsletter">${icon('mail')}</a>
      <div class="spacer"></div>
      <a href="/leaderboard" title="Public site">${icon('gauge')}</a>
      <form method="post" action="/admin/logout"><button class="ghost" style="width:42px;height:42px;border-radius:11px;padding:0" title="Sign out">${icon('settings')}</button></form>
    </nav>

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
        <!-- HERO -->
        <section class="hero">
          <svg class="gridbg" width="100%" height="100%"><defs><pattern id="g" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M 40 0 L 0 0 0 40" fill="none" stroke="#fff" stroke-width="0.5"/></pattern></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>
          <div style="position:relative;z-index:1">
            <div class="live"><i></i> Live · ${escapeHtml(navLast?.as_of || 'awaiting first run')} · hypothetical</div>
            <h1>A hypothetical<br>$1,000 is worth<br><em>$${navLast ? navLast.nav_index.toFixed(0) : '—'}</em> today.</h1>
            <p class="lede">Spread equally across ${tipsAgg?.resolved ?? 0} tracked calls from ${srcAgg?.n ?? 0} sharers. ${overallHit != null ? `${Math.round(overallHit * 100)}% of settled calls beat their market benchmark.` : 'Outcomes accrue as calls settle.'} Backward-looking, paper-traded — not advice.</p>
          </div>
          <div class="herostats">
            <div class="herostat"><div><div class="lab">$1,000 journey</div><div class="val">${navLast ? navLast.nav_index.toFixed(0) : '–'}</div><div class="sub">indexed off $1,000</div></div>${delta(navRet)}</div>
            <div class="herostat"><div><div class="lab">Hit rate</div><div class="val">${overallHit == null ? '–' : Math.round(overallHit * 100) + '%'}</div><div class="sub">${hitAgg?.n ?? 0} settled outcomes</div></div></div>
            <div class="herostat"><div><div class="lab">Avg alpha</div><div class="val">${hitAgg?.alpha == null ? '–' : pct(hitAgg.alpha)}</div><div class="sub">excess vs benchmark</div></div>${delta(hitAgg?.alpha ?? null)}</div>
          </div>
        </section>

        <!-- META STRIP -->
        <div style="display:flex;gap:26px;flex-wrap:wrap;font-size:13px;color:var(--muted);padding:0 2px">
          <span><b style="color:var(--text);font-family:var(--font-mono)">${secAgg?.n ?? 0}</b> shares followed</span>
          <span><b style="color:var(--text);font-family:var(--font-mono)">${(posAgg?.open ?? 0) + (posAgg?.closed ?? 0)}</b> positions · ${posAgg?.open ?? 0} open</span>
          <span><b style="color:var(--text);font-family:var(--font-mono)">${tipsAgg?.total ?? 0}</b> tips · ${tipsAgg?.resolved ?? 0} resolved</span>
          <span><b style="color:var(--text);font-family:var(--font-mono)">${subAgg?.total ?? 0}</b> subscribers · ${subAgg?.synced ?? 0} synced</span>
        </div>

        <!-- TREND + RING -->
        <div class="row r-trend">
          <section class="card"><header><div><h3>The $1,000 journey</h3><p class="csub">Equal-weighted across every tracked call · indexed off $1,000</p></div>
            <div class="bignum">${navLast ? navLast.nav_index.toFixed(0) : '–'}</div></header>
            <div class="body">${navChart(navSeries.map((n) => n.nav_index))}</div></section>
          <section class="card"><header><div><h3>Hit rate</h3><p class="csub">Calls that beat the market, by horizon</p></div></header>
            <div class="body ring-wrap">
              ${ring(overallHit ?? 0, 'overall')}
              <div style="flex:1;display:flex;flex-direction:column;gap:9px">
                ${horizons.length === 0 ? '<span class="muted">No settled horizons yet.</span>' : horizons.map((h) => {
                  const hr = h.n ? h.hits / h.n : 0;
                  return `<div style="display:flex;align-items:center;gap:8px;font-size:12px"><span style="width:7px;height:7px;border-radius:50%;background:${hr >= 0.5 ? 'var(--good)' : 'var(--bad)'}"></span>
                    <span style="flex:1;font-weight:600">${h.horizon_days}-day</span><span class="mono muted">${h.n} · ${Math.round(hr * 100)}%</span></div>`;
                }).join('')}
              </div></div></section>
        </div>

        <!-- NEEDS ATTENTION -->
        <section class="card"><header><div><h3>Needs attention</h3><p class="csub">Operational items, sorted by severity</p></div></header>
          <div class="body">${triage.length === 0 ? '<p class="muted">All clear — nothing needs attention. ✓</p>' :
            `<div class="triage">${triage.map((it) => `<div class="ti"><div class="accent" style="background:${sevColor(it.sev)}"></div>
              <div class="mid"><div style="display:flex;align-items:center;gap:8px;margin-bottom:3px"><span class="sev" style="color:${sevColor(it.sev)};background:color-mix(in srgb, ${sevColor(it.sev)} 14%, transparent)">${it.sev}</span><span class="mono muted" style="font-size:10px;text-transform:uppercase;letter-spacing:.06em">${escapeHtml(it.kind)}</span></div>
              <div style="font-size:13px;font-weight:600">${escapeHtml(it.t)}</div><div style="font-size:12px;color:var(--muted)">${escapeHtml(it.d)}</div></div>
              <span style="padding-right:14px;color:var(--faint)">›</span></div>`).join('')}</div>`}</div></section>

        <!-- SHARERS + SHARES -->
        <div class="row r-half" id="sharers">
          <section class="card"><header><div><h3>Tip sharers · reputation</h3><p class="csub">Ranked by 90-day Wilson lower bound</p></div><a href="/leaderboard" class="mono muted" style="font-size:12px">Full board →</a></header>
            <div class="body barlist">${sharers.length === 0 ? '<p class="muted">No sharers yet.</p>' : sharers.map((s) => {
              const score = s.score_lower ?? 0;
              return `<div class="b"><span style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis">${escapeHtml(s.name)} ${s.tier ? `<span class="tier">${escapeHtml(s.tier)}</span>` : ''}</span>
                <div class="track"><span style="width:${Math.min(100, score)}%"></span></div>
                <span class="num" style="font-size:12px">${s.score_lower == null ? '–' : `<b>${score.toFixed(0)}</b>`}</span>
                <span class="num muted" style="font-size:11px">${s.tips} tip${s.tips === 1 ? '' : 's'}</span></div>`;
            }).join('')}</div></section>
          <section class="card" id="shares"><header><div><h3>Shares we follow</h3><p class="csub">By tip volume</p></div></header>
            <div class="body barlist">${shares.length === 0 ? '<p class="muted">No tracked shares yet.</p>' : shares.map((s) => `<div class="b" style="grid-template-columns:120px 1fr 54px 56px">
              <span style="font-size:13px"><b>${escapeHtml(s.ticker)}</b></span>
              <div class="track"><span style="width:${(s.tips / maxTips) * 100}%"></span></div>
              <span class="num muted" style="font-size:12px">${s.tips}</span>
              <span class="num ${(s.avg_alpha ?? 0) >= 0 ? 'pos' : 'neg'}" style="font-size:11px">${s.avg_alpha == null ? '–' : pct(s.avg_alpha)}</span></div>`).join('')}</div></section>
        </div>

        <!-- REPUTATION BY DIMENSION + ACTIVITY -->
        <div class="row r-half" id="activity">
          <section class="card"><header><div><h3>Reputation leaderboard</h3><p class="csub">Every dimension — horizon-keyed &amp; conviction-weighted</p></div></header>
            <div class="body">${Object.keys(dimGroups).length === 0 ? '<p class="muted">No rated sources yet — reputation accrues as tips settle.</p>' :
              Object.entries(dimGroups).map(([dim, rs]) => `<div style="margin-bottom:14px"><div class="pill" style="margin-bottom:6px">${escapeHtml(DIM[dim] || dim)}</div>
                <table><thead><tr><th>#</th><th>Sharer</th><th class="num">Tips</th><th class="num">Hit</th><th class="num">Alpha</th><th class="num">Score</th></tr></thead><tbody>
                ${rs.map((r) => `<tr><td class="num">${r.rank}</td><td>${escapeHtml(r.source_name)}</td><td class="num">${r.n_tips}</td><td class="num">${Math.round(r.hit_rate * 100)}%</td>${sign(r.avg_excess_pct)}<td class="num"><b>${r.score_lower.toFixed(0)}</b></td></tr>`).join('')}
                </tbody></table></div>`).join('')}</div></section>
          <section class="card dark"><header><div><h3>Live activity</h3><p class="csub">Recent ops events</p></div><span style="display:inline-flex;align-items:center;gap:6px;font-size:11px;color:rgba(255,255,255,.6)"><span style="width:6px;height:6px;border-radius:50%;background:#5bbb6b;box-shadow:0 0 0 3px rgba(91,187,107,.18)"></span>Live</span></header>
            <div class="body feed">${ops.map((o) => `<div class="f"><div class="ic">${icon('pulse', 14)}</div>
              <div style="min-width:0"><div style="font-size:13px;${o.kind === 'error' ? 'color:var(--bad-soft)' : ''}">${escapeHtml(o.kind)}</div><div class="mono" style="font-size:11px;color:rgba(255,255,255,.45);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(o.detail || '')}</div></div>
              <span class="mono" style="font-size:10px;color:rgba(255,255,255,.45)">${escapeHtml(o.created_at.slice(11, 16))}</span></div>`).join('')}</div></section>
        </div>

        <!-- JOBS -->
        <section class="card" id="newsletter"><header><div><h3>Run a job</h3><p class="csub">Spend today: $${(spent / 100).toFixed(2)} / $${(cap / 100).toFixed(0)} · ${spentPct}% of cap</p></div></header>
          <div class="body"><div class="actions">
            <button data-act="/admin/run-daily">Run daily</button>
            <button data-act="/admin/poll" class="ghost">Poll producers</button>
            <button data-act="/admin/backfill-tip-type?limit=500" class="ghost">Backfill tip types</button>
            <button data-act="/admin/sync-subscribers" class="ghost">Sync subscribers</button>
            <button data-act="/admin/publish-digest" class="ghost">Publish digest draft</button>
          </div><pre id="out" class="muted" style="margin-top:12px">Action results appear here · refresh to see updated metrics.</pre></div></section>
      </div>
    </div>
  </div>
  <script>
    document.querySelectorAll('button[data-act]').forEach(function (b) {
      b.addEventListener('click', function () {
        var out = document.getElementById('out');
        out.textContent = b.textContent.trim() + '… running'; b.disabled = true;
        fetch(b.getAttribute('data-act'), { method: 'POST' }).then(function (r) { return r.text(); })
          .then(function (t) { out.textContent = t; b.disabled = false; })
          .catch(function (e) { out.textContent = 'Error: ' + e; b.disabled = false; });
      });
    });
  </script>`;
  return shell('Dashboard', body);
}
