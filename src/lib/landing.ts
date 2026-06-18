/**
 * Public landing page (/) — newsletter signup.
 *
 * Faithful server-rendered recreation of the "Shareo Landing v2" design handoff
 * (warm monochrome / Stake palette, condensed Anton display type, three phone screens,
 * email capture front and centre). The design prototype was a client-side templated
 * `.dc.html`; here it's static HTML + a small inline script for the signup forms.
 *
 * Compliance: copy is backward-looking / educational only and carries the standard
 * "general information, not financial advice" disclaimer — no buy/sell recommendation.
 */
import type { Env } from '../types.js';
import { uid, nowISO, logOps } from './db.js';
import { rateLimit } from './usage.js';
import { configured as beehiivConfigured, createSubscriber } from './beehiiv.js';

const MAX_BEEHIIV_SYNC_PER_RUN = 100; // bound the daily subscriber sync

/**
 * Push not-yet-synced active subscribers to beehiiv. Bounded (LIMIT) + idempotent
 * (beehiiv_synced_at guard). No-op when beehiiv isn't configured. Per-item isolation: one bad
 * email is logged and skipped, never crashes the run.
 */
export async function syncSubscribersToBeehiiv(env: Env): Promise<{ synced: number; failed: number; skipped?: string }> {
  if (!beehiivConfigured(env)) return { synced: 0, failed: 0, skipped: 'not_configured' };
  const rows = (await env.DB.prepare(
    `SELECT id, email, source FROM subscribers
      WHERE status = 'active' AND beehiiv_synced_at IS NULL ORDER BY created_at ASC LIMIT ?`,
  ).bind(MAX_BEEHIIV_SYNC_PER_RUN).all<{ id: string; email: string; source: string | null }>()).results ?? [];

  let synced = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      const res = await createSubscriber(env, r.email, r.source || 'unknown');
      if (res.ok) {
        await env.DB.prepare('UPDATE subscribers SET beehiiv_synced_at = ? WHERE id = ?').bind(nowISO(), r.id).run();
        synced++;
      } else {
        failed++;
        await logOps(env, 'error', { at: 'beehiiv_sync', status: res.status, err: res.error });
      }
    } catch (err) {
      failed++;
      await logOps(env, 'error', { at: 'beehiiv_sync', subscriber: r.id, err: String(err) });
    }
  }
  await logOps(env, 'subscribe', { job: 'beehiiv-sync', synced, failed });
  return { synced, failed };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LEN = 254; // RFC 5321 practical maximum
const SUBSCRIBE_MAX_PER_HOUR = 5; // per-IP cap on signups

/** Escape a value for use inside a double-quoted HTML attribute. */
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  if (e.length === 0 || e.length > MAX_EMAIL_LEN || !EMAIL_RE.test(e)) return null;
  return e;
}

/**
 * Verify a Cloudflare Turnstile token. Fail-OPEN when TURNSTILE_SECRET_KEY is unset (so the
 * landing page keeps working before the secret is provisioned); once set, a bad/absent token
 * is rejected. One bounded call to a fixed Cloudflare host — no budget needed.
 */
async function verifyTurnstile(env: Env, token: unknown, ip: string | null): Promise<boolean> {
  if (!env.TURNSTILE_SECRET_KEY) return true; // not configured → fail open (logged by caller)
  if (typeof token !== 'string' || !token) return false;
  try {
    const body = new FormData();
    body.set('secret', env.TURNSTILE_SECRET_KEY);
    body.set('response', token);
    if (ip) body.set('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    const out = (await res.json()) as { success?: boolean };
    return out.success === true;
  } catch {
    return false; // verification endpoint unreachable → fail closed (secret IS configured)
  }
}

/**
 * POST /api/subscribe — store a landing-page email signup.
 * Accepts JSON ({email, source}) from the inline fetch, or form-encoded for the no-JS
 * fallback. Idempotent (UNIQUE email + INSERT OR IGNORE): re-signing up is a no-op success.
 * No external calls, no paid work — a single bounded DB write.
 */
export async function handleSubscribe(req: Request, env: Env): Promise<Response> {
  // Per-IP rate limit first — cheap, and caps abuse before any parsing/verification work.
  const ip = req.headers.get('cf-connecting-ip');
  if (ip && !(await rateLimit(env, `subscribe:${ip}`, SUBSCRIBE_MAX_PER_HOUR, 3600))) {
    await logOps(env, 'subscribe', { rejected: 'rate_limited' });
    return wantsHtml(req)
      ? htmlResponse(noticePage('Too many attempts — please try again later.'), 429)
      : json({ ok: false, error: 'rate_limited' }, 429);
  }

  let email: string | null = null;
  let source = 'hero';
  let turnstileToken: unknown = null;
  const ctype = req.headers.get('content-type') || '';
  try {
    if (ctype.includes('application/json')) {
      const body = (await req.json()) as { email?: unknown; source?: unknown; turnstileToken?: unknown };
      email = normaliseEmail(body.email);
      if (typeof body.source === 'string') source = body.source;
      turnstileToken = body.turnstileToken;
    } else {
      const form = await req.formData();
      email = normaliseEmail(form.get('email'));
      const s = form.get('source');
      if (typeof s === 'string') source = s;
      turnstileToken = form.get('cf-turnstile-response');
    }
  } catch {
    return json({ ok: false, error: 'invalid_request' }, 400);
  }
  if (source !== 'hero' && source !== 'footer') source = 'hero';

  if (!email) {
    return wantsHtml(req)
      ? htmlResponse(noticePage('Please enter a valid email address.'), 400)
      : json({ ok: false, error: 'invalid_email' }, 400);
  }

  if (!(await verifyTurnstile(env, turnstileToken, ip))) {
    await logOps(env, 'subscribe', { rejected: 'captcha_failed', configured: !!env.TURNSTILE_SECRET_KEY });
    return wantsHtml(req)
      ? htmlResponse(noticePage('Could not verify you are human — please try again.'), 400)
      : json({ ok: false, error: 'captcha_failed' }, 400);
  }
  if (!env.TURNSTILE_SECRET_KEY) await logOps(env, 'subscribe', { warn: 'turnstile_unconfigured_fail_open' });

  try {
    const res = await env.DB.prepare(
      'INSERT OR IGNORE INTO subscribers (id, email, source, status, created_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(uid(), email, source, 'active', nowISO()).run();
    const created = (res.meta?.changes ?? 0) > 0;
    await logOps(env, 'subscribe', { source, created });
  } catch (err) {
    await logOps(env, 'error', { at: 'subscribe', err: String(err) });
    return wantsHtml(req)
      ? htmlResponse(noticePage('Something went wrong — please try again.'), 500)
      : json({ ok: false, error: 'server_error' }, 500);
  }

  return wantsHtml(req)
    ? htmlResponse(noticePage("You're in — first tips land Thursday."))
    : json({ ok: true });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function wantsHtml(req: Request): boolean {
  return (req.headers.get('accept') || '').includes('text/html');
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/** Minimal confirmation page for the no-JS fallback. */
function noticePage(msg: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Shareo</title>
<style>body{font:18px/1.6 -apple-system,system-ui,sans-serif;background:#E8E7E1;color:#1A1916;
display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;text-align:center}
a{color:#1A1916}.card{max-width:420px;padding:2rem}</style></head>
<body><div class="card"><p>${msg}</p><p><a href="/">← Back to Shareo</a></p></div></body></html>`;
}

// ── Landing page ─────────────────────────────────────────────────────

// Top-sharer leaderboard rows shown in phone 3 (illustrative — real grades come from /leaderboard).
const LEADERS = [
  { rank: '01', rankColor: '#1A1916', name: 'Marcus Chen', focus: 'US tech &amp; semis', accuracy: 94, tier: 'TIER S', tierColor: '#1A1916', av: 'linear-gradient(135deg,#f2f2ef,#b6b6af)' },
  { rank: '02', rankColor: '#9C9A90', name: 'Sofia Reyes', focus: 'Growth &amp; SaaS', accuracy: 91, tier: 'TIER S', tierColor: '#1A1916', av: 'linear-gradient(135deg,#d8d8d2,#9a9a93)' },
  { rank: '03', rankColor: '#9C9A90', name: 'Devon Park', focus: 'Dividends &amp; value', accuracy: 88, tier: 'TIER A', tierColor: '#9C9A90', av: 'linear-gradient(135deg,#e4e4df,#a8a8a1)' },
  { rank: '04', rankColor: '#9C9A90', name: 'Aisha Khan', focus: 'Energy &amp; industrials', accuracy: 87, tier: 'TIER A', tierColor: '#9C9A90', av: 'linear-gradient(135deg,#cfcfc9,#8c8c85)' },
];

const TICKER = [
  ['NVDA', '&#9650; 2.41%', true], ['AAPL', '&#9650; 0.88%', true], ['TSLA', '&#9660; 1.12%', false],
  ['MSFT', '&#9650; 1.04%', true], ['AMZN', '&#9650; 0.62%', true], ['META', '&#9650; 1.97%', true],
  ['GOOGL', '&#9660; 0.34%', false], ['AMD', '&#9650; 3.10%', true], ['SHOP', '&#9650; 0.77%', true],
  ['NFLX', '&#9660; 0.45%', false],
] as const;

function tickerRun(): string {
  return TICKER.map(([sym, chg, up]) =>
    `<span>${sym} <span style="color:${up ? '#1A1916' : '#9C9A90'};font-weight:600;">${chg}</span></span>`,
  ).join('');
}

function phoneChrome(): string {
  return `<div style="height: 28px; display: flex; align-items: center; justify-content: center; position: relative; margin: 10px 0 14px;">
    <div style="position: absolute; left: 4px; font-family: 'JetBrains Mono', monospace; font-size: 12px; color: #1A1916;">9:41</div>
    <div style="width: 86px; height: 22px; background: #1A1916; border-radius: 999px;"></div>
    <div style="position: absolute; right: 4px; display: flex; gap: 3px;"><span style="width:5px;height:5px;border-radius:50%;background:#1A1916;"></span><span style="width:5px;height:5px;border-radius:50%;background:#1A1916;"></span><span style="width:5px;height:5px;border-radius:50%;background:#1A1916;"></span></div>
  </div>`;
}

function leaderRows(): string {
  return LEADERS.map((s) => `
    <div style="display: flex; align-items: center; gap: 10px; background: #fff; border: 1px solid rgba(26,25,22,0.07); border-radius: 13px; padding: 10px 12px;">
      <span style="font-family: 'JetBrains Mono', monospace; font-size: 12.5px; font-weight: 600; color: ${s.rankColor}; width: 16px; flex-shrink: 0;">${s.rank}</span>
      <div style="width: 30px; height: 30px; border-radius: 50%; background: ${s.av}; flex-shrink: 0;"></div>
      <div style="flex: 1; min-width: 0;"><div style="font-weight: 700; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${s.name}</div><div style="font-size: 10.5px; color: #8A897F; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${s.focus}</div></div>
      <div style="text-align: right; flex-shrink: 0;"><div style="font-family: 'JetBrains Mono', monospace; font-weight: 600; font-size: 13.5px;">${s.accuracy}%</div><div style="font-size: 9.5px; color: ${s.tierColor}; font-weight: 700; letter-spacing: 0.04em; white-space: nowrap;">${s.tier}</div></div>
    </div>`).join('');
}

export function landingPage(env: Env): Response {
  const siteKey = env.TURNSTILE_SITE_KEY || '';
  const turnstileScript = siteKey
    ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>'
    : '';
  // Per-form Turnstile widget; empty when unconfigured so the page still works pre-provisioning.
  const widget = siteKey
    ? `<div class="cf-turnstile" data-sitekey="${escapeAttr(siteKey)}" data-theme="auto" style="margin-top:14px;"></div>`
    : '';
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shareo · Know who's actually right</title>
<meta name="description" content="Crowd-validated share tips in your inbox every week — graded by a transparent sharer rating system. Follow the people who are actually right. General information only, not financial advice.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Hanken+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">
${turnstileScript}
<style>
  * { box-sizing: border-box; }
  body { margin: 0; }
  @keyframes shMarquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }
  @keyframes shPulse { 0%,100% { opacity: .5; transform: scale(1); } 50% { opacity: 1; transform: scale(1.3); } }
  a[data-cta], button[data-cta] { transition: background .15s ease, color .15s ease; }
  a[data-cta]:hover, button[data-cta]:hover { background: #000 !important; }
  a[data-link]:hover { color: #fff !important; }
  @media (max-width: 880px) { .sh-phones { grid-template-columns: 1fr !important; } .sh-foot { grid-template-columns: 1fr !important; } .sh-navlinks { display: none !important; } }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
</style>
</head>
<body>
<div style="font-family: 'Hanken Grotesk', sans-serif; background: #E8E7E1; color: #1A1916; min-height: 100vh; position: relative; overflow-x: hidden; -webkit-font-smoothing: antialiased;">

  <!-- nav -->
  <nav style="position: relative; z-index: 5; max-width: 1240px; margin: 0 auto; padding: 26px 36px; display: flex; align-items: center; justify-content: space-between;">
    <div style="font-family: 'Anton', sans-serif; font-size: 26px; letter-spacing: 0.01em; text-transform: uppercase;">Shareo<span style="color:#9C9A90;">.</span></div>
    <div class="sh-navlinks" style="display: flex; align-items: center; gap: 4px; background: rgba(255,255,255,0.6); border: 1px solid rgba(26,25,22,0.08); border-radius: 999px; padding: 5px;">
      <a href="#top" style="text-decoration: none; color: #fff; background: #1A1916; padding: 9px 18px; border-radius: 999px; font-size: 13px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;">Home</a>
      <a href="#how" style="text-decoration: none; color: #4A4944; padding: 9px 18px; border-radius: 999px; font-size: 13px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;">How it works</a>
      <a href="/leaderboard" style="text-decoration: none; color: #4A4944; padding: 9px 18px; border-radius: 999px; font-size: 13px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;">Leaderboard</a>
    </div>
    <div style="display: flex; align-items: center; gap: 10px;">
      <a href="#join" style="text-decoration: none; color: #1A1916; border: 1px solid rgba(26,25,22,0.25); padding: 9px 18px; border-radius: 999px; font-size: 13px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase;">Sign in</a>
      <a href="#join" data-cta style="text-decoration: none; color: #fff; background: #1A1916; padding: 9px 16px 9px 18px; border-radius: 999px; font-size: 13px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; display: flex; align-items: center; gap: 9px;">Get tips <span style="background: #E8E7E1; color: #1A1916; padding: 2px 7px; border-radius: 999px; font-size: 11px;">FREE</span></a>
    </div>
  </nav>

  <!-- hero -->
  <header id="top" style="position: relative; z-index: 2; max-width: 1100px; margin: 0 auto; padding: 70px 36px 40px; text-align: center;">
    <div style="position: relative; z-index: 3;">
      <div style="display: inline-flex; align-items: center; gap: 9px; font-size: 12.5px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: #6A6960; margin-bottom: 30px;">
        <span style="width: 7px; height: 7px; border-radius: 50%; background: #1A1916; animation: shPulse 2s ease-in-out infinite;"></span>
        The crowd-validated share tips newsletter
      </div>
      <h1 style="font-family: 'Anton', sans-serif; font-weight: 400; font-size: clamp(52px, 9vw, 116px); line-height: 0.9; letter-spacing: 0.005em; text-transform: uppercase; margin: 0 0 28px;">Know who's<br>actually right.</h1>
      <p style="font-size: 19px; line-height: 1.55; color: #4A4944; max-width: 560px; margin: 0 auto 38px; text-wrap: pretty;">Crowd-validated share tips in your inbox every week &mdash; graded by a transparent sharer rating system. Follow the people who are actually right.</p>

      <div id="join" style="max-width: 520px; margin: 0 auto;">
        <div data-signup-wrap>
          <form data-signup-form data-source="hero" action="/api/subscribe" method="post" novalidate>
            <input type="hidden" name="source" value="hero" />
            <div style="display: flex; gap: 8px; background: #fff; border: 1px solid rgba(26,25,22,0.12); border-radius: 999px; padding: 7px 7px 7px 8px; box-shadow: 0 16px 36px rgba(26,25,22,0.1);">
              <input name="email" type="email" required placeholder="you@email.com" style="flex: 1; border: none; outline: none; padding: 13px 16px; font-size: 16px; font-family: 'Hanken Grotesk', sans-serif; background: transparent; color: #1A1916;" />
              <button type="submit" data-cta style="border: none; background: #1A1916; color: #fff; font-family: 'Hanken Grotesk', sans-serif; font-weight: 700; font-size: 15px; padding: 0 26px; border-radius: 999px; cursor: pointer; white-space: nowrap; letter-spacing: 0.02em;">Get free tips</button>
            </div>
            ${widget}
            <div data-signup-err style="color: #B0322C; font-size: 13px; margin: 10px 0 0; display: none;"></div>
          </form>
          <div data-signup-done style="display: none;">
            <div style="display: inline-flex; align-items: center; gap: 12px; background: #1A1916; color: #fff; padding: 16px 22px; border-radius: 999px;">
              <span style="width: 24px; height: 24px; border-radius: 50%; background: #fff; display: flex; align-items: center; justify-content: center; flex-shrink: 0;"><svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 8.5 L6.5 12 L13 4" stroke="#1A1916" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
              <span style="font-weight: 600; font-size: 15.5px;">You're in &mdash; first tips land Thursday.</span>
            </div>
          </div>
        </div>
        <div style="display: flex; align-items: center; justify-content: center; gap: 13px; margin-top: 22px;">
          <div style="display: flex;">
            <div style="width: 28px; height: 28px; border-radius: 50%; background: linear-gradient(135deg,#f3f3f0,#b9b9b2); border: 2px solid #E8E7E1;"></div>
            <div style="width: 28px; height: 28px; border-radius: 50%; background: linear-gradient(135deg,#d6d6d0,#9a9a93); border: 2px solid #E8E7E1; margin-left: -10px;"></div>
            <div style="width: 28px; height: 28px; border-radius: 50%; background: linear-gradient(135deg,#cfcfc9,#8c8c85); border: 2px solid #E8E7E1; margin-left: -10px;"></div>
          </div>
          <span style="font-size: 13.5px; color: #6A6960;">Free weekly &middot; No spam &middot; Unsubscribe anytime</span>
        </div>
      </div>
    </div>
  </header>

  <!-- marquee band -->
  <div style="position: relative; z-index: 2; margin-top: 56px; border-top: 1px solid rgba(26,25,22,0.1); border-bottom: 1px solid rgba(26,25,22,0.1); overflow: hidden; background: rgba(255,255,255,0.35);">
    <div style="display: flex; width: max-content; animation: shMarquee 38s linear infinite; padding: 16px 0;">
      <div style="display: flex; gap: 40px; padding-right: 40px; font-family: 'JetBrains Mono', monospace; font-size: 13px; letter-spacing: 0.02em; color: #4A4944;">
        ${tickerRun()}${tickerRun()}
      </div>
    </div>
  </div>

  <!-- how it works -->
  <section id="how" style="position: relative; z-index: 2; max-width: 1240px; margin: 0 auto; padding: 100px 36px 0;">
    <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 40px; flex-wrap: wrap; margin-bottom: 64px;">
      <div style="max-width: 640px;">
        <div style="font-size: 12.5px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: #6A6960; margin-bottom: 18px;">How shareo works</div>
        <h2 style="font-family: 'Anton', sans-serif; font-weight: 400; font-size: clamp(48px, 7vw, 92px); line-height: 0.86; letter-spacing: 0.005em; text-transform: uppercase; margin: 0 0 26px;">Follow<br>the proof.</h2>
        <p style="font-size: 17px; line-height: 1.55; color: #4A4944; max-width: 440px; margin: 0;">Three steps. Get the call, watch the crowd validate it, and follow the sharers with the best track record &mdash; no noise, no guesswork.</p>
        <p style="font-size: 12.5px; line-height: 1.5; color: #8A897F; max-width: 440px; margin: 14px 0 0;">Sample screens below are illustrative. Live grades, hit rates and the source leaderboard are published — backward-looking and hypothetical (paper-traded) — on the <a href="/leaderboard" style="color:#4A4944;">leaderboard</a>.</p>
      </div>
      <a href="#join" data-cta style="text-decoration: none; color: #fff; background: #1A1916; padding: 15px 26px; border-radius: 999px; font-size: 13px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; display: inline-flex; align-items: center; gap: 10px; white-space: nowrap;">Get free tips <span style="font-size: 15px;">&rarr;</span></a>
    </div>

    <div class="sh-phones" style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 28px;">

      <!-- phone 1: GET THE CALL -->
      <div>
        <div style="width: 100%; max-width: 300px; margin: 0 auto; background: #1A1916; border-radius: 44px; padding: 10px; box-shadow: 0 34px 70px rgba(26,25,22,0.22);">
          <div style="background: #F4F3EF; border-radius: 35px; padding: 0 16px 16px; height: 564px; display: flex; flex-direction: column; position: relative; overflow: hidden;">
            ${phoneChrome()}
            <div style="font-family: 'Anton', sans-serif; font-size: 15px; letter-spacing: 0.02em; text-transform: uppercase; color: #9C9A90;">Shareo.</div>
            <div style="font-family: 'Anton', sans-serif; font-size: 21px; letter-spacing: 0; line-height: 1.02; text-transform: uppercase; min-height: 46px; margin: 2px 0 14px; display: flex; align-items: flex-end;">Get the call</div>

            <div style="background: #fff; border: 1px solid rgba(26,25,22,0.08); border-radius: 18px; padding: 16px;">
              <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px;">
                <div style="display: flex; align-items: center; gap: 10px;">
                  <div style="width: 38px; height: 38px; border-radius: 11px; background: #1A1916; color: #fff; display: flex; align-items: center; justify-content: center; font-family: 'Anton', sans-serif; font-size: 13px;">NV</div>
                  <div><div style="font-family: 'Anton', sans-serif; font-size: 15px; letter-spacing: 0.02em;">NVDA</div><div style="font-size: 11.5px; color: #8A897F;">NVIDIA Corp</div></div>
                </div>
                <span style="background: #1A1916; color: #fff; font-weight: 700; font-size: 11px; letter-spacing: 0.05em; padding: 5px 11px; border-radius: 999px;">CALL</span>
              </div>
              <svg width="100%" height="52" viewBox="0 0 240 52" fill="none" style="display:block;"><path d="M0,42 L24,38 L48,40 L72,31 L96,34 L120,24 L144,27 L168,17 L192,20 L216,9 L240,5" stroke="#1A1916" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="240" cy="5" r="3.4" fill="#1A1916"/></svg>
              <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-top: 14px; font-family: 'JetBrains Mono', monospace;">
                <div><div style="font-size: 10px; color: #8A897F; font-family: 'Hanken Grotesk', sans-serif;">Conviction</div><div style="font-weight: 600; font-size: 14px;">High</div></div>
                <div><div style="font-size: 10px; color: #8A897F; font-family: 'Hanken Grotesk', sans-serif;">Target</div><div style="font-weight: 600; font-size: 14px;">+18.2%</div></div>
                <div><div style="font-size: 10px; color: #8A897F; font-family: 'Hanken Grotesk', sans-serif;">Horizon</div><div style="font-weight: 600; font-size: 14px;">3 mo</div></div>
              </div>
            </div>
            <div style="font-size: 12px; color: #8A897F; margin: 12px 2px;">Posted by Marcus Chen &middot; Tier S</div>
            <div style="flex: 1;"></div>
            <button style="border: none; background: #1A1916; color: #fff; font-family: 'Hanken Grotesk', sans-serif; font-weight: 600; font-size: 14px; padding: 14px; border-radius: 999px; cursor: pointer;">See the call &rarr;</button>
          </div>
        </div>
        <div style="text-align: center; margin-top: 22px;"><div style="font-family: 'JetBrains Mono', monospace; font-size: 12px; color: #9C9A90; margin-bottom: 6px;">01</div><p style="font-size: 14.5px; color: #4A4944; max-width: 260px; margin: 0 auto; line-height: 1.5;">Every tip comes with a clear entry, target and timeframe &mdash; on the record.</p></div>
      </div>

      <!-- phone 2: SEE IT VALIDATED -->
      <div>
        <div style="width: 100%; max-width: 300px; margin: 0 auto; background: #1A1916; border-radius: 44px; padding: 10px; box-shadow: 0 34px 70px rgba(26,25,22,0.22);">
          <div style="background: #F4F3EF; border-radius: 35px; padding: 0 16px 16px; height: 564px; display: flex; flex-direction: column; position: relative; overflow: hidden;">
            ${phoneChrome()}
            <div style="font-family: 'Anton', sans-serif; font-size: 15px; letter-spacing: 0.02em; text-transform: uppercase; color: #9C9A90;">Shareo.</div>
            <div style="font-family: 'Anton', sans-serif; font-size: 21px; letter-spacing: 0; line-height: 1.02; text-transform: uppercase; min-height: 46px; margin: 2px 0 14px; display: flex; align-items: flex-end;">See it validated</div>

            <div style="background: #1A1916; border-radius: 18px; padding: 20px; color: #fff; margin-bottom: 14px;">
              <div style="font-size: 11.5px; letter-spacing: 0.1em; text-transform: uppercase; color: #9C9A90; margin-bottom: 6px;">Community confidence</div>
              <div style="font-family: 'Anton', sans-serif; font-size: 52px; line-height: 1; letter-spacing: 0.01em;">92%</div>
              <div style="height: 6px; background: rgba(255,255,255,0.16); border-radius: 999px; overflow: hidden; margin: 14px 0 8px;"><div style="width: 92%; height: 100%; background: #fff; border-radius: 999px;"></div></div>
              <div style="font-size: 12.5px; color: #C8C7BF;">1,284 investors validated this call</div>
            </div>

            <div style="display: flex; flex-direction: column; gap: 10px;">
              <div style="display: flex; align-items: center; gap: 10px;"><div style="width: 26px; height: 26px; border-radius: 50%; background: linear-gradient(135deg,#dededa,#a0a099);"></div><div style="font-size: 12.5px; color: #4A4944; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;"><strong>Aisha K.</strong> validated &middot; <span style="font-family:'JetBrains Mono',monospace;color:#8A897F;">2m</span></div></div>
              <div style="display: flex; align-items: center; gap: 10px;"><div style="width: 26px; height: 26px; border-radius: 50%; background: linear-gradient(135deg,#cfcfc9,#8f8f88);"></div><div style="font-size: 12.5px; color: #4A4944; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;"><strong>Sofia R.</strong> added evidence &middot; <span style="font-family:'JetBrains Mono',monospace;color:#8A897F;">6m</span></div></div>
              <div style="display: flex; align-items: center; gap: 10px;"><div style="width: 26px; height: 26px; border-radius: 50%; background: linear-gradient(135deg,#e6e6e1,#b3b3ac);"></div><div style="font-size: 12.5px; color: #4A4944; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;"><strong>Devon P.</strong> backed the call &middot; <span style="font-family:'JetBrains Mono',monospace;color:#8A897F;">11m</span></div></div>
            </div>
            <div style="flex: 1;"></div>
            <button style="border: none; background: #1A1916; color: #fff; font-family: 'Hanken Grotesk', sans-serif; font-weight: 600; font-size: 14px; padding: 14px; border-radius: 999px; cursor: pointer; margin-top: 14px;">View evidence &rarr;</button>
          </div>
        </div>
        <div style="text-align: center; margin-top: 22px;"><div style="font-family: 'JetBrains Mono', monospace; font-size: 12px; color: #9C9A90; margin-bottom: 6px;">02</div><p style="font-size: 14.5px; color: #4A4944; max-width: 260px; margin: 0 auto; line-height: 1.5;">Thousands of members stress-test each call. You see the confidence, not just an opinion.</p></div>
      </div>

      <!-- phone 3: FOLLOW THE BEST -->
      <div>
        <div style="width: 100%; max-width: 300px; margin: 0 auto; background: #1A1916; border-radius: 44px; padding: 10px; box-shadow: 0 34px 70px rgba(26,25,22,0.22);">
          <div style="background: #F4F3EF; border-radius: 35px; padding: 0 16px 16px; height: 564px; display: flex; flex-direction: column; position: relative; overflow: hidden;">
            ${phoneChrome()}
            <div style="font-family: 'Anton', sans-serif; font-size: 15px; letter-spacing: 0.02em; text-transform: uppercase; color: #9C9A90;">Shareo.</div>
            <div style="font-family: 'Anton', sans-serif; font-size: 21px; letter-spacing: 0; line-height: 1.02; text-transform: uppercase; min-height: 46px; margin: 2px 0 14px; display: flex; align-items: flex-end;">Follow the best</div>

            <div style="display: flex; flex-direction: column; gap: 8px;">
              ${leaderRows()}
            </div>
            <div style="flex: 1;"></div>
            <button style="border: none; background: #1A1916; color: #fff; font-family: 'Hanken Grotesk', sans-serif; font-weight: 600; font-size: 14px; padding: 14px; border-radius: 999px; cursor: pointer; margin-top: 14px;">See full rankings &rarr;</button>
          </div>
        </div>
        <div style="text-align: center; margin-top: 22px;"><div style="font-family: 'JetBrains Mono', monospace; font-size: 12px; color: #9C9A90; margin-bottom: 6px;">03</div><p style="font-size: 14.5px; color: #4A4944; max-width: 260px; margin: 0 auto; line-height: 1.5;">Every sharer is graded on real, tracked accuracy. Follow the ones who deliver.</p></div>
      </div>

    </div>
  </section>

  <!-- dark CTA + footer -->
  <section style="position: relative; z-index: 2; margin-top: 110px; background: #1A1916; color: #E8E7E1; overflow: hidden;">
    <div style="position: absolute; top: 30px; left: 0; right: 0; text-align: center; font-family: 'Anton', sans-serif; font-size: clamp(110px, 22vw, 300px); line-height: 1; letter-spacing: 0.02em; color: rgba(255,255,255,0.04); text-transform: uppercase; pointer-events: none; user-select: none;">Shareo</div>
    <div style="position: relative; max-width: 1240px; margin: 0 auto; padding: 96px 36px 56px;">
      <div class="sh-foot" style="display: grid; grid-template-columns: 1.2fr 1fr; gap: 56px; align-items: end; padding-bottom: 72px; border-bottom: 1px solid rgba(255,255,255,0.1);">
        <div>
          <h2 style="font-family: 'Anton', sans-serif; font-weight: 400; font-size: clamp(52px, 8vw, 104px); line-height: 0.84; letter-spacing: 0.005em; text-transform: uppercase; margin: 0 0 28px; color: #fff;">Join the<br>movement.</h2>
          <p style="font-size: 17px; color: #B0AFA6; max-width: 420px; margin: 0 0 28px; line-height: 1.5;">Get crowd-validated, sharer-rated share tips every Thursday. Free, forever.</p>
          <div style="max-width: 460px;">
            <div data-signup-wrap>
              <form data-signup-form data-source="footer" action="/api/subscribe" method="post" novalidate>
                <input type="hidden" name="source" value="footer" />
                <div style="display: flex; align-items: center; gap: 14px; border-bottom: 2px solid rgba(255,255,255,0.4); padding-bottom: 4px;">
                  <input name="email" type="email" required placeholder="your@email.com" style="flex: 1; border: none; outline: none; background: transparent; color: #fff; font-family: 'Hanken Grotesk', sans-serif; font-size: 18px; padding: 10px 0;" />
                  <button type="submit" style="border: none; background: transparent; color: #fff; font-family: 'Hanken Grotesk', sans-serif; font-weight: 700; font-size: 14px; letter-spacing: 0.08em; text-transform: uppercase; cursor: pointer; white-space: nowrap; display: flex; align-items: center; gap: 8px;">Subscribe <span style="font-size: 16px;">&rarr;</span></button>
                </div>
                ${widget}
                <div data-signup-err style="color: #E8A6A2; font-size: 13px; margin-top: 10px; display: none;"></div>
              </form>
              <div data-signup-done style="display: none;">
                <div style="display: inline-flex; align-items: center; gap: 11px; border-bottom: 2px solid #fff; padding-bottom: 12px;">
                  <span style="width: 24px; height: 24px; border-radius: 50%; background: #fff; display: flex; align-items: center; justify-content: center;"><svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 8.5 L6.5 12 L13 4" stroke="#1A1916" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
                  <span style="font-size: 16px; font-weight: 600; color: #fff;">Subscribed &mdash; welcome aboard.</span>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div style="display: flex; gap: 64px; flex-wrap: wrap; justify-content: flex-end;">
          <div><div style="font-size: 11.5px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #6E6D64; margin-bottom: 18px;">Explore</div><div style="display: flex; flex-direction: column; gap: 13px; font-size: 15px;"><a href="#how" data-link style="color: #C8C7BF; text-decoration: none;">How it works</a><a href="/leaderboard" data-link style="color: #C8C7BF; text-decoration: none;">Leaderboard</a><a href="/methodology" data-link style="color: #C8C7BF; text-decoration: none;">Methodology</a><a href="#join" data-link style="color: #C8C7BF; text-decoration: none;">Get started</a><a href="#" data-link style="color: #C8C7BF; text-decoration: none;">Privacy</a><a href="#" data-link style="color: #C8C7BF; text-decoration: none;">Terms</a></div></div>
          <div><div style="font-size: 11.5px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #6E6D64; margin-bottom: 18px;">Follow</div><div style="display: flex; flex-direction: column; gap: 13px; font-size: 15px;"><a href="#" data-link style="color: #C8C7BF; text-decoration: none;">Instagram</a><a href="#" data-link style="color: #C8C7BF; text-decoration: none;">LinkedIn</a><a href="#" data-link style="color: #C8C7BF; text-decoration: none;">X / Twitter</a><a href="#" data-link style="color: #C8C7BF; text-decoration: none;">TikTok</a></div></div>
        </div>
      </div>
      <p style="font-size: 12.5px; color: #6E6D64; line-height: 1.6; margin: 32px 0 0; max-width: 880px;">General information only &mdash; not financial advice. Shareo provides educational information and community-sourced opinions. Nothing here is a personal recommendation or an offer to buy or sell any security. Ratings and validations reflect community sentiment and historical data, not future performance. Investing carries risk, including loss of capital. Always do your own research. &copy; 2026 Shareo.co.</p>
    </div>
  </section>

</div>

<script>
(function () {
  var EMAIL_RE = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
  document.querySelectorAll('[data-signup-form]').forEach(function (form) {
    var wrap = form.closest('[data-signup-wrap]');
    var errEl = form.querySelector('[data-signup-err]');
    var doneEl = wrap.querySelector('[data-signup-done]');
    var input = form.querySelector('input[name=email]');
    var btn = form.querySelector('button[type=submit]');
    var source = form.getAttribute('data-source') || 'hero';
    function showErr(msg) { if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; } }
    function clearErr() { if (errEl) { errEl.style.display = 'none'; } }
    input.addEventListener('input', clearErr);
    function resetWidget() {
      var w = form.querySelector('.cf-turnstile');
      if (w && window.turnstile) { try { window.turnstile.reset(w); } catch (e) {} }
    }
    function errorFor(code) {
      if (code === 'invalid_email') return 'Please enter a valid email address.';
      if (code === 'captcha_failed') return 'Could not verify you are human — please try again.';
      if (code === 'rate_limited') return 'Too many attempts — please try again later.';
      return 'Something went wrong — please try again.';
    }
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var email = (input.value || '').trim();
      if (!EMAIL_RE.test(email)) { showErr('Please enter a valid email address.'); return; }
      var tokenEl = form.querySelector('[name="cf-turnstile-response"]');
      var token = tokenEl ? tokenEl.value : null;
      clearErr();
      if (btn) btn.disabled = true;
      fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email, source: source, turnstileToken: token })
      }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (res.ok && res.j && res.j.ok) { form.style.display = 'none'; doneEl.style.display = 'block'; }
          else { showErr(errorFor(res.j && res.j.error)); if (btn) btn.disabled = false; resetWidget(); }
        })
        .catch(function () { showErr('Network error — please try again.'); if (btn) btn.disabled = false; resetWidget(); });
    });
  });
})();
</script>
</body>
</html>`;
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
  });
}
