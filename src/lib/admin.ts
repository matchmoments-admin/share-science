/**
 * Token-gated admin console — a browsable dashboard over the same data the /admin/* JSON endpoints
 * expose. Auth is the existing ADMIN_TOKEN: POST it once at /admin/login, which sets an HttpOnly +
 * Secure + SameSite=Strict cookie (`ss_admin`) holding the token; authed() (index.ts) accepts that
 * cookie OR the x-admin-token header. This surface is PRIVATE (token-gated), so it may show internal
 * operational data — it is never a public payload and is not subject to assertNoRawPrices.
 */
import type { Env } from '../types.js';
import { escapeHtml, pct } from './render.js';
import { spentTodayCents } from './usage.js';
import { timingSafeEqual } from './db.js';

const COOKIE = 'ss_admin';
const COOKIE_TTL_S = 8 * 3600; // 8h session

/** Read the admin session token from the request cookie, if present. */
export function adminCookie(req: Request): string | null {
  const c = req.headers.get('cookie') || '';
  const m = c.match(/(?:^|;\s*)ss_admin=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function adminLayout(title: string, body: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · admin</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; max-width: 1080px; margin: 0 auto; padding: 1.25rem; }
  h1 { font-size: 1.3rem; margin: 0; } h2 { font-size: .95rem; text-transform: uppercase; letter-spacing: .05em; opacity: .7; margin: 1.6rem 0 .5rem; }
  a { color: inherit; }
  table { border-collapse: collapse; width: 100%; margin: .4rem 0; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: .35rem .55rem; border-bottom: 1px solid #8883; white-space: nowrap; }
  th { font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; opacity: .6; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: .6rem; margin: .5rem 0; }
  .card { border: 1px solid #8884; border-radius: .5rem; padding: .7rem .8rem; }
  .card .k { font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; opacity: .6; }
  .card .v { font-size: 1.4rem; font-weight: 700; margin-top: .15rem; }
  .pos { color: #1a7f37; } .neg { color: #c0392b; } .warn { color: #c0392b; } .muted { opacity: .6; }
  .bar { height: 7px; border-radius: 4px; background: #8883; overflow: hidden; margin-top: .4rem; }
  .bar > span { display: block; height: 100%; background: #1a7f37; }
  button { font: inherit; padding: .45rem .8rem; border: 1px solid #8886; border-radius: .45rem; background: #8881; cursor: pointer; }
  button:hover { background: #8883; }
  .actions { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; }
  nav { font-size: .82rem; margin-bottom: 1rem; display: flex; gap: 1rem; }
  pre#out { background: #8881; border: 1px solid #8884; border-radius: .45rem; padding: .6rem; white-space: pre-wrap; word-break: break-word; min-height: 1.2rem; margin-top: .6rem; }
</style></head><body>${body}</body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

/** Login form. */
export function adminLoginPage(error?: string): Response {
  return adminLayout('Sign in', `
    <h1>share-science admin</h1>
    <p class="muted">Enter the admin token to continue.</p>
    ${error ? `<p class="warn">${escapeHtml(error)}</p>` : ''}
    <form method="post" action="/admin/login" style="max-width:380px;margin-top:1rem">
      <input name="token" type="password" placeholder="admin token" autocomplete="current-password" required
        style="width:100%;padding:.6rem;border:1px solid #8886;border-radius:.45rem;font:inherit;margin-bottom:.6rem">
      <button type="submit">Sign in</button>
    </form>`);
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
  const [settledAgg] = await rows<{ n: number }>(env, `SELECT COUNT(*) n FROM tip_returns WHERE is_hit IS NOT NULL`);
  const ingest = await rows<{ status: string; n: number }>(env, `SELECT status, COUNT(*) n FROM ingest_items GROUP BY status ORDER BY n DESC`);
  const tipTypes = await rows<{ tt: string; n: number }>(env, `SELECT COALESCE(tip_type,'(unknown)') tt, COUNT(*) n FROM tips GROUP BY tt ORDER BY n DESC`);
  const nav = (await rows<{ as_of: string; nav_index: number; n_positions: number; return_pct: number }>(env,
    `SELECT as_of, nav_index, n_positions, return_pct FROM portfolio_nav WHERE scope='all' ORDER BY as_of DESC LIMIT 1`))[0];
  const ratings = await rows<{ dimension: string; source_name: string; tier: string; n_tips: number; hit_rate: number; score_lower: number; rank: number }>(env,
    `SELECT sr.dimension, s.name source_name, sr.tier, sr.n_tips, sr.hit_rate, sr.score_lower, sr.rank
       FROM source_ratings sr JOIN sources s ON s.id = sr.source_id ORDER BY sr.dimension, sr.rank LIMIT 60`);
  const recentPos = await rows<{ ticker: string; source: string; status: string; return_pct: number | null; excess_return_pct: number | null; is_hit: number | null }>(env,
    `SELECT sec.ticker, s.name source, p.status, p.return_pct, p.excess_return_pct, p.is_hit
       FROM positions p JOIN tips t ON t.id=p.tip_id JOIN sources s ON s.id=t.source_id JOIN securities sec ON sec.id=p.security_id
      ORDER BY p.last_valued_at DESC LIMIT 12`);
  const ops = await rows<{ kind: string; created_at: string; detail: string }>(env,
    `SELECT kind, created_at, substr(detail,1,140) detail FROM ops_events ORDER BY created_at DESC LIMIT 15`);

  const card = (k: string, v: string | number, extra = '') => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div>${extra}</div>`;
  const navRet = nav ? pct(nav.return_pct) : '–';

  const body = `
    <nav><a href="/admin">↻ Refresh</a><a href="/leaderboard">Public leaderboard</a><a href="/methodology">Methodology</a>
      <form method="post" action="/admin/logout" style="margin-left:auto"><button>Sign out</button></form></nav>
    <h1>Dashboard</h1>

    <h2>System</h2>
    <div class="cards">
      ${card('Spend today', `${(spent / 100).toFixed(2)}<span class="muted" style="font-size:.9rem">/$${(cap / 100).toFixed(0)}</span>`,
        `<div class="bar"><span style="width:${spentPct}%;${spentPct >= 90 ? 'background:#c0392b' : ''}"></span></div>`)}
      ${card('Public prices', escapeHtml(env.PUBLIC_PRICES))}
      ${card('Settled outcomes', settledAgg?.n ?? 0)}
      ${card('$1,000 journey', nav ? nav.nav_index.toFixed(0) : '–', nav ? `<div class="muted" style="font-size:.8rem">${navRet} · ${nav.n_positions} pos · ${escapeHtml(nav.as_of)}</div>` : '')}
    </div>

    <h2>Pipeline</h2>
    <div class="cards">
      ${card('Tips', tipsAgg?.total ?? 0, `<div class="muted" style="font-size:.8rem">${tipsAgg?.resolved ?? 0} resolved</div>`)}
      ${card('Positions', `${posAgg?.open ?? 0}<span class="muted" style="font-size:.9rem"> open</span>`, `<div class="muted" style="font-size:.8rem">${posAgg?.closed ?? 0} closed</div>`)}
      ${card('Sources', srcAgg?.n ?? 0)}
      ${card('Subscribers', subAgg?.total ?? 0, `<div class="muted" style="font-size:.8rem">${subAgg?.synced ?? 0} synced to beehiiv</div>`)}
    </div>
    <p class="muted" style="font-size:.82rem">Ingest: ${ingest.map((r) => `${escapeHtml(r.status)} ${r.n}`).join(' · ') || 'none'} &nbsp;|&nbsp; Tip types: ${tipTypes.map((r) => `${escapeHtml(r.tt)} ${r.n}`).join(' · ')}</p>

    <h2>Actions</h2>
    <div class="actions">
      <button data-act="/admin/run-daily">Run daily</button>
      <button data-act="/admin/poll">Poll producers</button>
      <button data-act="/admin/backfill-tip-type?limit=500">Backfill tip types</button>
      <button data-act="/admin/sync-subscribers">Sync subscribers → beehiiv</button>
      <button data-act="/admin/publish-digest">Publish digest draft</button>
    </div>
    <pre id="out" class="muted">Action results appear here.</pre>

    <h2>Leaderboard (all dimensions)</h2>
    ${ratings.length === 0 ? '<p class="muted">No rated sources yet — outcomes accrue as tips settle.</p>' :
      `<table><thead><tr><th>Dimension</th><th>#</th><th>Source</th><th>Tier</th><th>Tips</th><th>Hit rate</th><th>Score (LB)</th></tr></thead><tbody>
      ${ratings.map((r) => `<tr><td>${escapeHtml(r.dimension)}</td><td>${r.rank}</td><td>${escapeHtml(r.source_name)}</td>
        <td>${escapeHtml(r.tier)}</td><td>${r.n_tips}</td><td>${(r.hit_rate * 100).toFixed(0)}%</td><td><b>${r.score_lower.toFixed(0)}</b></td></tr>`).join('')}
      </tbody></table>`}

    <h2>Recent positions</h2>
    ${recentPos.length === 0 ? '<p class="muted">No positions yet.</p>' :
      `<table><thead><tr><th>Ticker</th><th>Source</th><th>Status</th><th>Return</th><th>Alpha</th><th>Hit?</th></tr></thead><tbody>
      ${recentPos.map((p) => `<tr><td>${escapeHtml(p.ticker)}</td><td>${escapeHtml(p.source)}</td><td>${escapeHtml(p.status)}</td>
        <td class="${(p.return_pct ?? 0) >= 0 ? 'pos' : 'neg'}">${pct(p.return_pct)}</td>
        <td class="${(p.excess_return_pct ?? 0) >= 0 ? 'pos' : 'neg'}">${pct(p.excess_return_pct)}</td>
        <td>${p.is_hit == null ? '<span class="muted">–</span>' : p.is_hit ? '✓' : '✗'}</td></tr>`).join('')}
      </tbody></table>`}

    <h2>Recent activity</h2>
    <table><thead><tr><th>When</th><th>Kind</th><th>Detail</th></tr></thead><tbody>
      ${ops.map((o) => `<tr><td class="muted">${escapeHtml(o.created_at.slice(5, 16).replace('T', ' '))}</td>
        <td class="${o.kind === 'error' ? 'warn' : ''}">${escapeHtml(o.kind)}</td><td class="muted">${escapeHtml(o.detail || '')}</td></tr>`).join('')}
    </tbody></table>

    <script>
      document.querySelectorAll('button[data-act]').forEach(function (b) {
        b.addEventListener('click', function () {
          var out = document.getElementById('out');
          out.textContent = b.textContent + '… running';
          b.disabled = true;
          fetch(b.getAttribute('data-act'), { method: 'POST' })
            .then(function (r) { return r.text(); })
            .then(function (t) { out.textContent = t; b.disabled = false; })
            .catch(function (e) { out.textContent = 'Error: ' + e; b.disabled = false; });
        });
      });
    </script>`;
  return adminLayout('Dashboard', body);
}
