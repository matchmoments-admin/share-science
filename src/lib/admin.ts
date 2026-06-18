/**
 * Token-gated admin console — a browsable dashboard over the same data the /admin/* JSON endpoints
 * expose, styled with the shared brand tokens (src/lib/theme.ts). Auth is the existing ADMIN_TOKEN:
 * POST it once at /admin/login, which sets an HttpOnly + Secure + SameSite=Strict cookie (`ss_admin`)
 * holding the token; authed() (index.ts) accepts that cookie OR the x-admin-token header. This surface
 * is PRIVATE (token-gated), so it may show internal operational data — never a public payload, and
 * not subject to assertNoRawPrices.
 */
import type { Env } from '../types.js';
import { escapeHtml, pct } from './render.js';
import { spentTodayCents } from './usage.js';
import { timingSafeEqual } from './db.js';
import { BRAND_HEAD } from './theme.js';

const COOKIE = 'ss_admin';
const COOKIE_TTL_S = 8 * 3600; // 8h session

/** Read the admin session token from the request cookie, if present. */
export function adminCookie(req: Request): string | null {
  const c = req.headers.get('cookie') || '';
  const m = c.match(/(?:^|;\s*)ss_admin=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function shell(title: string, body: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · Shareo admin</title>
${BRAND_HEAD}
<style>
  .wrap { max-width: 1180px; margin: 0 auto; padding: 0 1.25rem 4rem; }
  header.top { display: flex; align-items: center; gap: 1rem; padding: 1.1rem 0; border-bottom: 1px solid var(--line); margin-bottom: 1.4rem; position: sticky; top: 0; background: var(--paper); z-index: 5; }
  .brand { font-family: var(--font-display); font-size: 1.45rem; text-transform: uppercase; letter-spacing: .01em; text-decoration: none; }
  .brand .tag { font-family: var(--font-mono); font-size: .6rem; letter-spacing: .12em; color: var(--muted); margin-left: .5rem; vertical-align: middle; border: 1px solid var(--line); border-radius: var(--r-pill); padding: .15rem .5rem; }
  header nav { margin-left: auto; display: flex; gap: 1.1rem; align-items: center; font-size: .84rem; font-weight: 600; }
  header nav a { text-decoration: none; color: var(--text-2); } header nav a:hover { color: var(--text); }
  h2 { font-family: var(--font-display); font-weight: 400; text-transform: uppercase; letter-spacing: .03em; font-size: 1rem; color: var(--text-2); margin: 2rem 0 .7rem; }
  .grid { display: grid; gap: .8rem; }
  .stats { grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 1rem 1.1rem; box-shadow: var(--shadow-sm); }
  .card .k { font-family: var(--font-mono); font-size: .68rem; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
  .card .v { font-family: var(--font-display); font-size: 2.1rem; line-height: 1; margin-top: .4rem; }
  .card .v small { font-family: var(--font-body); font-size: .9rem; color: var(--muted); font-weight: 600; }
  .card .sub { font-size: .78rem; color: var(--muted); margin-top: .35rem; }
  .bar { height: 6px; border-radius: var(--r-pill); background: var(--line); overflow: hidden; margin-top: .55rem; }
  .bar > span { display: block; height: 100%; background: var(--good); }
  .panel { background: var(--card); border: 1px solid var(--line); border-radius: var(--r-lg); padding: .4rem 1rem 1rem; box-shadow: var(--shadow-sm); }
  table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: .5rem .55rem; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th { font-family: var(--font-mono); font-size: .66rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); font-weight: 600; }
  tbody tr:hover { background: var(--line-soft); }
  td.num, th.num { text-align: right; font-family: var(--font-mono); }
  .pos { color: var(--good); } .neg { color: var(--bad); } .muted { color: var(--muted); }
  .tier { font-family: var(--font-mono); font-size: .62rem; text-transform: uppercase; letter-spacing: .04em; padding: .12rem .45rem; border-radius: var(--r-pill); border: 1px solid var(--line); color: var(--muted); }
  .pill { font-family: var(--font-mono); font-size: .6rem; text-transform: uppercase; letter-spacing: .05em; padding: .15rem .5rem; border-radius: var(--r-pill); border: 1px solid var(--line); color: var(--muted); }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: .9rem; } @media (max-width: 820px){ .two { grid-template-columns: 1fr; } }
  .actions { display: flex; gap: .55rem; flex-wrap: wrap; align-items: center; }
  button { font: inherit; font-weight: 600; padding: .5rem .95rem; border: none; border-radius: var(--r-pill); background: var(--ink); color: var(--on-dark); cursor: pointer; }
  button.ghost { background: transparent; color: var(--text); border: 1px solid var(--line); }
  button:hover { opacity: .9; } button:disabled { opacity: .5; cursor: default; }
  pre#out { font-family: var(--font-mono); font-size: .74rem; background: var(--paper-2); border: 1px solid var(--line); border-radius: var(--r-md); padding: .7rem; white-space: pre-wrap; word-break: break-word; min-height: 1.1rem; margin-top: .7rem; color: var(--text-2); }
  .spark { display: block; }
</style></head><body><div class="wrap">${body}</div></body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

/** Login form. */
export function adminLoginPage(error?: string): Response {
  return shell('Sign in', `
    <header class="top"><span class="brand">Shareo<span class="tag">admin</span></span></header>
    <div style="max-width:400px;margin:3rem auto 0;text-align:center">
      <div class="display" style="font-size:2.2rem;margin-bottom:.4rem">Sign in</div>
      <p class="muted">Enter the admin token to continue.</p>
      ${error ? `<p class="neg" style="font-weight:600">${escapeHtml(error)}</p>` : ''}
      <form method="post" action="/admin/login" style="margin-top:1.2rem">
        <input name="token" type="password" placeholder="admin token" autocomplete="current-password" required
          style="width:100%;padding:.75rem;border:1px solid var(--line);border-radius:var(--r-md);font:inherit;background:var(--card);color:var(--text);margin-bottom:.7rem">
        <button type="submit" style="width:100%">Sign in</button>
      </form>
    </div>`);
}

/** Validate the posted token, set the session cookie, redirect to /admin. */
export async function handleAdminLogin(req: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_TOKEN) return adminLoginPage('Admin token is not configured on the server.');
  let token = '';
  try {
    const form = await req.formData();
    const t = form.get('token');
    if (typeof t === 'string') token = t;
  } catch {
    return adminLoginPage('Invalid request.');
  }
  if (!token || !timingSafeEqual(token, env.ADMIN_TOKEN)) return adminLoginPage('Incorrect token.');
  const cookie = `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=${COOKIE_TTL_S}`;
  return new Response(null, { status: 302, headers: { location: '/admin', 'set-cookie': cookie } });
}

/** Clear the session cookie. */
export function handleAdminLogout(): Response {
  const cookie = `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=0`;
  return new Response(null, { status: 302, headers: { location: '/admin', 'set-cookie': cookie } });
}

async function rows<T = Record<string, unknown>>(env: Env, sql: string): Promise<T[]> {
  return (await env.DB.prepare(sql).all<T>()).results ?? [];
}

/** Minimal SVG sparkline for the NAV series (index values; base 1000 reference line). */
function sparkline(values: number[], w = 560, h = 80): string {
  if (values.length === 0) return '<p class="muted">No NAV points yet — run the daily pass.</p>';
  const min = Math.min(...values, 1000);
  const max = Math.max(...values, 1000);
  const range = max - min || 1;
  const x = (i: number) => (values.length > 1 ? (i / (values.length - 1)) * w : w / 2);
  const y = (v: number) => h - ((v - min) / range) * h;
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const baseY = y(1000).toFixed(1);
  const lastV = values[values.length - 1];
  const up = lastV >= 1000;
  return `<svg class="spark" width="100%" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <line x1="0" y1="${baseY}" x2="${w}" y2="${baseY}" stroke="var(--line)" stroke-dasharray="3 3"/>
    <polyline points="${pts}" fill="none" stroke="${up ? 'var(--good)' : 'var(--bad)'}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(values.length - 1).toFixed(1)}" cy="${y(lastV).toFixed(1)}" r="3" fill="${up ? 'var(--good)' : 'var(--bad)'}"/>
  </svg>`;
}

/** The dashboard. Caller has already checked auth. */
export async function adminDashboard(env: Env): Promise<Response> {
  const cap = Number(env.MAX_DAILY_COST_CENTS) || 0;
  const spent = await spentTodayCents(env).catch(() => 0);
  const spentPct = cap > 0 ? Math.min(100, Math.round((spent / cap) * 100)) : 0;

  const [tipsAgg] = await rows<{ total: number; resolved: number }>(env,
    `SELECT COUNT(*) total, SUM(CASE WHEN security_id IS NOT NULL THEN 1 ELSE 0 END) resolved FROM tips`);
  const [posAgg] = await rows<{ open: number; closed: number }>(env,
    `SELECT SUM(status='open') open, SUM(status='closed') closed FROM positions`);
  const [subAgg] = await rows<{ total: number; synced: number }>(env,
    `SELECT COUNT(*) total, SUM(CASE WHEN beehiiv_synced_at IS NOT NULL THEN 1 ELSE 0 END) synced FROM subscribers`);
  const [srcAgg] = await rows<{ n: number }>(env, `SELECT COUNT(*) n FROM sources WHERE active IS NULL OR active = 1`);
  const [secAgg] = await rows<{ n: number }>(env, `SELECT COUNT(DISTINCT security_id) n FROM tips WHERE security_id IS NOT NULL`);
  const [settledAgg] = await rows<{ n: number }>(env, `SELECT COUNT(*) n FROM tip_returns WHERE is_hit IS NOT NULL`);
  const [hitAgg] = await rows<{ hits: number; n: number }>(env, `SELECT SUM(is_hit) hits, COUNT(*) n FROM tip_returns WHERE is_hit IS NOT NULL`);
  const ingest = await rows<{ status: string; n: number }>(env, `SELECT status, COUNT(*) n FROM ingest_items GROUP BY status ORDER BY n DESC`);
  const tipTypes = await rows<{ tt: string; n: number }>(env, `SELECT COALESCE(tip_type,'unknown') tt, COUNT(*) n FROM tips GROUP BY tt ORDER BY n DESC`);

  const navSeries = await rows<{ as_of: string; nav_index: number }>(env,
    `SELECT as_of, nav_index FROM portfolio_nav WHERE scope='all' ORDER BY as_of ASC LIMIT 90`);
  const navLast = navSeries[navSeries.length - 1];
  const navRet = navLast ? navLast.nav_index / 1000 - 1 : null;

  // Tip sharers + reputation (default reputation = the established 90-day window).
  const sharers = await rows<{ name: string; medium: string; tips: number; settled: number | null; hit_rate: number | null; score_lower: number | null; tier: string | null }>(env,
    `SELECT s.name, s.medium, COUNT(t.id) tips,
            sr.n_tips settled, sr.hit_rate, sr.score_lower, sr.tier
       FROM sources s
       LEFT JOIN tips t ON t.source_id = s.id
       LEFT JOIN source_ratings sr ON sr.source_id = s.id AND sr.dimension = 'horizon:90'
      GROUP BY s.id ORDER BY (sr.score_lower IS NULL), sr.score_lower DESC, tips DESC LIMIT 25`);

  // Shares we follow (securities) with tip volume + average alpha + hit count.
  const shares = await rows<{ ticker: string; name: string; exchange: string; tips: number; hits: number; avg_alpha: number | null }>(env,
    `SELECT sec.ticker, sec.name, sec.exchange, COUNT(t.id) tips,
            SUM(CASE WHEN p.is_hit = 1 THEN 1 ELSE 0 END) hits, AVG(p.excess_return_pct) avg_alpha
       FROM securities sec JOIN tips t ON t.security_id = sec.id
       LEFT JOIN positions p ON p.tip_id = t.id
      GROUP BY sec.id ORDER BY tips DESC, sec.ticker LIMIT 25`);

  const ratings = await rows<{ dimension: string; source_name: string; tier: string; n_tips: number; hit_rate: number; avg_excess_pct: number; score_lower: number; rank: number }>(env,
    `SELECT sr.dimension, s.name source_name, sr.tier, sr.n_tips, sr.hit_rate, sr.avg_excess_pct, sr.score_lower, sr.rank
       FROM source_ratings sr JOIN sources s ON s.id = sr.source_id ORDER BY sr.dimension, sr.rank LIMIT 80`);

  const recentPos = await rows<{ ticker: string; source: string; status: string; return_pct: number | null; excess_return_pct: number | null; is_hit: number | null; max_drawdown_pct: number | null }>(env,
    `SELECT sec.ticker, s.name source, p.status, p.return_pct, p.excess_return_pct, p.is_hit, p.max_drawdown_pct
       FROM positions p JOIN tips t ON t.id=p.tip_id JOIN sources s ON s.id=t.source_id JOIN securities sec ON sec.id=p.security_id
      ORDER BY p.last_valued_at DESC LIMIT 14`);
  const ops = await rows<{ kind: string; created_at: string; detail: string }>(env,
    `SELECT kind, created_at, substr(detail,1,150) detail FROM ops_events ORDER BY created_at DESC LIMIT 16`);

  const overallHit = hitAgg && hitAgg.n ? (hitAgg.hits / hitAgg.n) * 100 : null;
  const card = (k: string, v: string, sub = '') => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  const num = (v: number | null, suffix = '') => (v == null ? '<span class="muted">–</span>' : `${v}${suffix}`);
  const sign = (frac: number | null | undefined) => (frac == null ? '<td class="num muted">–</td>' : `<td class="num ${frac >= 0 ? 'pos' : 'neg'}">${pct(frac)}</td>`);

  const dimGroups = ratings.reduce((acc: Record<string, typeof ratings>, r) => {
    (acc[r.dimension] ??= []).push(r); return acc;
  }, {});
  const DIM_LABEL: Record<string, string> = { 'horizon:30': '30-day', 'horizon:90': '90-day', 'horizon:365': '365-day', primary: 'Primary horizon', 'conviction:90': 'Conviction-weighted' };

  const body = `
  <header class="top">
    <a href="/admin" class="brand">Shareo<span class="tag">admin</span></a>
    <nav>
      <a href="/admin">↻ Refresh</a>
      <a href="/leaderboard">Public site</a>
      <a href="/methodology">Methodology</a>
      <form method="post" action="/admin/logout"><button class="ghost" style="padding:.35rem .8rem;font-size:.82rem">Sign out</button></form>
    </nav>
  </header>

  <div class="grid stats">
    ${card('$1,000 journey', navLast ? `${navLast.nav_index.toFixed(0)}` : '–',
      navLast ? `${navRet != null ? pct(navRet) : ''} · ${escapeHtml(navLast.as_of)}` : 'awaiting daily run')}
    ${card('Overall hit rate', overallHit == null ? '–' : `${overallHit.toFixed(0)}<small>%</small>`, `${settledAgg?.n ?? 0} settled outcomes`)}
    ${card('Shares tracked', String(secAgg?.n ?? 0), `${tipsAgg?.total ?? 0} tips · ${tipsAgg?.resolved ?? 0} resolved`)}
    ${card('Tip sharers', String(srcAgg?.n ?? 0), `${posAgg?.open ?? 0} open · ${posAgg?.closed ?? 0} closed positions`)}
    ${card('Subscribers', String(subAgg?.total ?? 0), `${subAgg?.synced ?? 0} synced to beehiiv`)}
    ${card('Spend today', `${(spent / 100).toFixed(2)}<small>/$${(cap / 100).toFixed(0)}</small>`,
      `<div class="bar"><span style="width:${spentPct}%;${spentPct >= 90 ? 'background:var(--bad)' : ''}"></span></div>`)}
  </div>

  <h2>The $1,000 journey</h2>
  <div class="panel" style="padding:1rem 1.1rem">${sparkline(navSeries.map((n) => n.nav_index))}
    <div class="muted" style="font-size:.78rem;margin-top:.4rem">$1,000 spread equally across every tracked call (open + closed), indexed off a 1,000 base. Dashed line = $1,000. Hypothetical / paper-traded.</div>
  </div>

  <div class="two" style="margin-top:1.4rem">
    <div>
      <h2 style="margin-top:0">Tip sharers · reputation</h2>
      <div class="panel"><table><thead><tr><th>Sharer</th><th class="num">Tips</th><th class="num">Settled</th><th class="num">Hit</th><th class="num">Score</th></tr></thead><tbody>
        ${sharers.length === 0 ? '<tr><td colspan="5" class="muted">No sharers yet.</td></tr>' : sharers.map((s) => `<tr>
          <td>${escapeHtml(s.name)} <span class="muted" style="font-size:.78rem">${escapeHtml(s.medium || '')}</span> ${s.tier ? `<span class="tier">${escapeHtml(s.tier)}</span>` : ''}</td>
          <td class="num">${s.tips}</td><td class="num">${num(s.settled)}</td>
          <td class="num">${s.hit_rate == null ? '<span class="muted">–</span>' : (s.hit_rate * 100).toFixed(0) + '%'}</td>
          <td class="num">${s.score_lower == null ? '<span class="muted">–</span>' : `<b>${s.score_lower.toFixed(0)}</b>`}</td></tr>`).join('')}
      </tbody></table><div class="muted" style="font-size:.74rem;padding:.3rem .2rem 0">Reputation shown for the 90-day window. Full per-dimension ranking below.</div></div>
    </div>
    <div>
      <h2 style="margin-top:0">Shares we follow</h2>
      <div class="panel"><table><thead><tr><th>Ticker</th><th class="num">Tips</th><th class="num">Hits</th><th class="num">Avg alpha</th></tr></thead><tbody>
        ${shares.length === 0 ? '<tr><td colspan="4" class="muted">No tracked shares yet.</td></tr>' : shares.map((s) => `<tr>
          <td><b>${escapeHtml(s.ticker)}</b> <span class="muted" style="font-size:.76rem">${escapeHtml((s.name || '').slice(0, 22))}</span></td>
          <td class="num">${s.tips}</td><td class="num">${s.hits ?? 0}</td>${sign(s.avg_alpha)}</tr>`).join('')}
      </tbody></table></div>
    </div>
  </div>

  <h2>Reputation leaderboard · by horizon &amp; conviction</h2>
  <div class="panel">
    ${Object.keys(dimGroups).length === 0 ? '<p class="muted">No rated sources yet — reputation accrues as tips settle at their horizon.</p>' :
      Object.entries(dimGroups).map(([dim, rs]) => `<div style="margin:.5rem 0 1rem">
        <div class="pill" style="margin-bottom:.4rem">${escapeHtml(DIM_LABEL[dim] || dim)}</div>
        <table><thead><tr><th>#</th><th>Sharer</th><th>Tier</th><th class="num">Tips</th><th class="num">Hit</th><th class="num">Avg alpha</th><th class="num">Score (LB)</th></tr></thead><tbody>
        ${rs.map((r) => `<tr><td class="num">${r.rank}</td><td>${escapeHtml(r.source_name)}</td><td><span class="tier">${escapeHtml(r.tier)}</span></td>
          <td class="num">${r.n_tips}</td><td class="num">${(r.hit_rate * 100).toFixed(0)}%</td>${sign(r.avg_excess_pct)}<td class="num"><b>${r.score_lower.toFixed(0)}</b></td></tr>`).join('')}
        </tbody></table></div>`).join('')}
  </div>

  <div class="two" style="margin-top:1.4rem">
    <div>
      <h2 style="margin-top:0">Recent calls</h2>
      <div class="panel"><table><thead><tr><th>Ticker</th><th>Sharer</th><th>Status</th><th class="num">Return</th><th class="num">Alpha</th><th class="num">Max DD</th><th>Hit</th></tr></thead><tbody>
        ${recentPos.length === 0 ? '<tr><td colspan="7" class="muted">No positions yet.</td></tr>' : recentPos.map((p) => `<tr>
          <td><b>${escapeHtml(p.ticker)}</b></td><td class="muted" style="font-size:.8rem">${escapeHtml((p.source || '').slice(0, 16))}</td>
          <td><span class="pill">${escapeHtml(p.status)}</span></td>${sign(p.return_pct)}${sign(p.excess_return_pct)}
          <td class="num">${p.max_drawdown_pct == null ? '–' : (p.max_drawdown_pct * 100).toFixed(1) + '%'}</td>
          <td>${p.is_hit == null ? '<span class="muted">–</span>' : p.is_hit ? '✓' : '✗'}</td></tr>`).join('')}
      </tbody></table></div>
    </div>
    <div>
      <h2 style="margin-top:0">Activity</h2>
      <div class="panel"><table><thead><tr><th>When</th><th>Kind</th><th>Detail</th></tr></thead><tbody>
        ${ops.map((o) => `<tr><td class="muted">${escapeHtml(o.created_at.slice(5, 16).replace('T', ' '))}</td>
          <td class="${o.kind === 'error' ? 'neg' : ''}">${escapeHtml(o.kind)}</td><td class="muted" style="font-size:.78rem;white-space:normal">${escapeHtml(o.detail || '')}</td></tr>`).join('')}
      </tbody></table></div>
    </div>
  </div>
  <p class="muted" style="font-size:.8rem;margin-top:1rem">Ingest: ${ingest.map((r) => `${escapeHtml(r.status)} ${r.n}`).join(' · ') || 'none'} &nbsp;|&nbsp; Tip types: ${tipTypes.map((r) => `${escapeHtml(r.tt)} ${r.n}`).join(' · ')}</p>

  <h2>Run a job</h2>
  <div class="actions">
    <button data-act="/admin/run-daily">Run daily</button>
    <button data-act="/admin/poll" class="ghost">Poll producers</button>
    <button data-act="/admin/backfill-tip-type?limit=500" class="ghost">Backfill tip types</button>
    <button data-act="/admin/sync-subscribers" class="ghost">Sync subscribers</button>
    <button data-act="/admin/publish-digest" class="ghost">Publish digest draft</button>
  </div>
  <pre id="out" class="muted">Action results appear here. Refresh the page to see updated metrics.</pre>

  <script>
    document.querySelectorAll('button[data-act]').forEach(function (b) {
      b.addEventListener('click', function () {
        var out = document.getElementById('out');
        out.textContent = b.textContent.trim() + '… running';
        b.disabled = true;
        fetch(b.getAttribute('data-act'), { method: 'POST' })
          .then(function (r) { return r.text(); })
          .then(function (t) { out.textContent = t; b.disabled = false; })
          .catch(function (e) { out.textContent = 'Error: ' + e; b.disabled = false; });
      });
    });
  </script>`;
  return shell('Dashboard', body);
}
