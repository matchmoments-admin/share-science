/**
 * share-science Worker entry point.
 *
 *  - fetch()     : /healthz · /ingest/{human,producer} · /admin/* · public read API
 *  - queue()     : tips-ingest consumer — extract (multi-tip) → resolve (abstain) → record tips
 *  - scheduled() : hourly = producers (RSS…); daily = open+value+rate; weekly = newsletter draft
 */
import type { Env, TipIngestMessage } from './types.js';
import { uid, nowISO, logOps, timingSafeEqual, isSafePublicUrl } from './lib/db.js';
import { spentTodayCents, withinBudget, recordSpend, eodhdCallsToday, eodhdCallBudget } from './lib/usage.js';
import { ingest, verifyHmac, type IngestInput } from './lib/ingest.js';
import { extractTips } from './lib/extract.js';
import { resolveSecurity } from './lib/resolve.js';
import { seedExchange } from './lib/securities.js';
import { openPendingPositions, executeApprovedTrades } from './lib/trade.js';
import { valueOpenPositions, recomputeRiskMetrics } from './lib/track.js';
import { recomputeRatings } from './lib/ratings.js';
import { snapshotNav } from './lib/nav.js';
import { classifyHorizon } from './lib/horizon.js';
import { pollRssSources } from './lib/producers/rss.js';
import { pollBlueskySources } from './lib/producers/bluesky.js';
import { pollPodcastSources } from './lib/producers/podcast.js';
import { leaderboard, leaderboardJson, navJson, sourcePage, tipPage, securityPage, methodologyPage } from './lib/pages.js';
import { landingPage, handleSubscribe, syncSubscribersToBeehiiv } from './lib/landing.js';
import { generateAndStoreDigest, publishDigestToBeehiiv } from './lib/content.js';
import { adminCookie, adminDashboard, adminApprovals, adminTrading, adminErrors, adminSources, adminAddTip, adminNewsletter, adminSubscribers, adminLoginPage, handleAdminLogin, handleAdminLogout } from './lib/admin.js';

const EXTRACT_BUDGET_CENTS = 5; // headroom before an extraction call (multi-tip ≈ a few cents)
const MAX_TIPS_PER_ITEM = 35; // covers a full multi-analyst episode (e.g. The Call ~13 stocks × 2); still bounded
const MAX_LAZY_LOOKUPS_PER_ITEM = 12; // bound EODHD lazy-resolution calls per message

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function authed(req: Request, env: Env): boolean {
  if (!env.ADMIN_TOKEN) return false;
  const tok = req.headers.get('x-admin-token');
  if (tok && timingSafeEqual(tok, env.ADMIN_TOKEN)) return true;
  // Browser session: the admin console sets an HttpOnly cookie holding the same token.
  const cookie = adminCookie(req);
  return !!cookie && timingSafeEqual(cookie, env.ADMIN_TOKEN);
}

async function handleHealthz(env: Env): Promise<Response> {
  let dbOk = false;
  try {
    await env.DB.prepare('SELECT 1').first();
    dbOk = true;
  } catch {
    dbOk = false;
  }
  // Newsletter funnel health (Phase 1 observability). Best-effort — never fails the probe.
  let newsletter: unknown = null;
  if (dbOk) {
    try {
      const lastDigest = await env.DB.prepare(
        `SELECT week, status, beehiiv_post_id, sent_at, created_at FROM digest_publications ORDER BY week DESC LIMIT 1`,
      ).first<{ week: string; status: string; beehiiv_post_id: string | null; sent_at: string | null; created_at: string }>();
      const subs = await env.DB.prepare(
        `SELECT
           SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) active,
           SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending,
           SUM(CASE WHEN status='unsubscribed' THEN 1 ELSE 0 END) unsubscribed,
           SUM(CASE WHEN status='active' AND beehiiv_synced_at IS NULL THEN 1 ELSE 0 END) active_unsynced
         FROM subscribers`,
      ).first<{ active: number; pending: number; unsubscribed: number; active_unsynced: number }>();
      newsletter = {
        last_digest_week: lastDigest?.week ?? null,
        draft_status: lastDigest?.status ?? null, // 'drafted' | 'failed' | 'sent'
        beehiiv_post_id: lastDigest?.beehiiv_post_id ?? null,
        last_sent_at: lastDigest?.sent_at ?? null, // NULL until Phase 2 wires send-state
        subscribers: {
          active: subs?.active ?? 0,
          pending: subs?.pending ?? 0, // 0 until Phase 4 double opt-in
          unsubscribed: subs?.unsubscribed ?? 0,
          active_unsynced: subs?.active_unsynced ?? 0,
        },
        // D1 is the CAPTURE record; beehiiv→D1 reconciliation lands in Phase 5, so active may over-count.
        list_note: 'D1 capture (pre-reconciliation)',
      };
    } catch {
      newsletter = null;
    }
  }
  return json({
    status: dbOk ? 'ok' : 'degraded',
    service: 'share-science',
    public_prices: env.PUBLIC_PRICES,
    spend_today_cents: await spentTodayCents(env).catch(() => null),
    daily_cap_cents: Number(env.MAX_DAILY_COST_CENTS) || null,
    eodhd_calls_today: await eodhdCallsToday(env).catch(() => null),
    eodhd_call_budget: eodhdCallBudget(env) || null,
    newsletter,
    time: nowISO(),
  });
}

/** Admin: submit a tip by hand. Body: { source_id, text, url?, detected_at? }. */
async function handleIngestHuman(req: Request, env: Env): Promise<Response> {
  if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
  let body: Partial<IngestInput>;
  try {
    body = (await req.json()) as Partial<IngestInput>;
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  if (!body.source_id || !body.text) return json({ error: 'missing source_id or text' }, 400);
  // detected_at is the look-ahead anchor (entry = first bar AFTER it). Defaulting to now() silently
  // back-stamps a tip found after its publish date — so we keep the default for API compatibility but
  // LOG it, making any today-stamped manual tip auditable. The admin form always sends a real date.
  if (!body.detected_at) await logOps(env, 'warn', { at: 'ingest_human', warn: 'detected_at_defaulted_to_now', source_id: body.source_id });
  const r = await ingest(env, {
    source_id: body.source_id, source_type: 'human', text: body.text, url: body.url,
    detected_at: body.detected_at || nowISO(),
  });
  return json(r, r.ok ? 200 : 400);
}

/** Admin: create a source. Body: { name, home_url?, feed_url?, bluesky_did?, locale?, ingest_method }. */
async function handleAddSource(req: Request, env: Env): Promise<Response> {
  if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
  let b: Record<string, string | undefined>;
  try { b = (await req.json()) as Record<string, string>; } catch { return json({ error: 'invalid_json' }, 400); }

  const name = (b.name || '').trim();
  const method = (b.ingest_method || 'manual').trim();
  const ALLOWED = ['rss_fulltext', 'podcast_transcript', 'bluesky', 'manual'];
  if (!name) return json({ error: 'missing name' }, 400);
  if (!ALLOWED.includes(method)) return json({ error: 'bad ingest_method' }, 400);
  if ((method === 'rss_fulltext' || method === 'podcast_transcript') && !b.feed_url) return json({ error: 'feed_url required for this method' }, 400);
  if (method === 'bluesky' && !b.bluesky_did) return json({ error: 'bluesky_did required for bluesky' }, 400);
  if (b.feed_url && !/^https:\/\//.test(b.feed_url)) return json({ error: 'feed_url must be https' }, 400);
  if (b.home_url && !/^https?:\/\//.test(b.home_url)) return json({ error: 'home_url must be http(s)' }, 400);

  const id = uid();
  const medium = method === 'bluesky' ? 'bluesky' : method === 'podcast_transcript' ? 'podcast' : method === 'rss_fulltext' ? 'blog' : 'web';
  try {
    await env.DB.prepare(
      `INSERT INTO sources (id, name, medium, home_url, created_at, feed_url, bluesky_did, locale, ingest_method, tos_checked, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1)`,
    ).bind(id, name, medium, b.home_url ?? null, nowISO(), b.feed_url ?? null, b.bluesky_did ?? null, b.locale ?? null, method).run();
  } catch (err) {
    return json({ error: 'insert_failed', detail: String(err) }, 400);
  }
  await logAdmin(env, '/admin/add-source', { id, method });
  return json({ ok: true, id });
}

/** Admin: record (or clear) the per-source ToS sign-off. Pollers only poll tos_checked=1 sources. */
async function handleSetTos(req: Request, env: Env): Promise<Response> {
  if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
  const u = new URL(req.url);
  const id = u.searchParams.get('id');
  if (!id) return json({ error: 'missing ?id=' }, 400);
  const checked = u.searchParams.get('checked') === '0' ? 0 : 1;
  const note = (u.searchParams.get('note') || '').slice(0, 300);
  // Starting a source anchors forward-only ingestion at this moment (COALESCE so a backfill window
  // already set is never clobbered). detected_at < ingest_from items are skipped by the pollers.
  const r = await env.DB.prepare(
    'UPDATE sources SET tos_checked=?, tos_checked_at=?, tos_checked_by=?, tos_note=?, ingest_from=COALESCE(ingest_from, ?) WHERE id=?',
  ).bind(checked, checked ? nowISO() : null, checked ? 'admin' : null, note || null, checked ? nowISO() : null, id).run();
  await logAdmin(env, '/admin/set-tos', { id, checked });
  return json({ ok: !!r.meta.changes, id, tos_checked: checked });
}

/** Admin: backfill a bounded history window for a source by moving ingest_from back N days. The
 * normal poller then fills it, paced by per-run caps + the daily budget. N clamped + floored at 3y. */
async function handleBackfillSource(req: Request, env: Env): Promise<Response> {
  if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
  const u = new URL(req.url);
  const id = u.searchParams.get('id');
  if (!id) return json({ error: 'missing ?id=' }, 400);
  const ALLOWED = new Set([30, 90, 365]);
  const days = Number(u.searchParams.get('days'));
  if (!ALLOWED.has(days)) return json({ error: 'days must be 30, 90 or 365' }, 400);
  // Never older than ~3y (checkDetectedAt rejects older anyway) — days is already <= 365 so this is safe.
  const from = new Date(Date.now() - days * 86_400_000).toISOString();
  const r = await env.DB.prepare('UPDATE sources SET ingest_from=? WHERE id=?').bind(from, id).run();
  await logAdmin(env, '/admin/backfill-source', { id, days });
  return json({ ok: !!r.meta.changes, id, ingest_from: from });
}

/** Admin: pause/resume a source (active flag). */
async function handleToggleSource(req: Request, env: Env): Promise<Response> {
  if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
  const u = new URL(req.url);
  const id = u.searchParams.get('id');
  const active = u.searchParams.get('active') === '1' ? 1 : 0;
  if (!id) return json({ error: 'missing ?id=' }, 400);
  const r = await env.DB.prepare('UPDATE sources SET active=? WHERE id=?').bind(active, id).run();
  await logAdmin(env, '/admin/toggle-source', { id, active });
  return json({ ok: !!r.meta.changes, id, active });
}

/** Admin: best-effort RSS/Atom discovery for a page URL (SSRF-guarded). Never blocks source creation. */
async function handleFindFeed(req: Request, env: Env): Promise<Response> {
  if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
  let url = '';
  try { url = (((await req.json()) as { url?: string }).url || '').trim(); } catch { return json({ error: 'invalid_json' }, 400); }
  if (!url) return json({ error: 'missing url' }, 400);
  // Upgrade http→https before validating (the guard + the output filter are https-only anyway).
  url = url.replace(/^http:\/\//i, 'https://');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  if (!isSafePublicUrl(url)) return json({ error: 'unsafe_url' }, 400);

  // Follow redirects MANUALLY, re-running the SSRF guard on every hop — a guard-passing URL could
  // 30x to a private/internal host, which the default redirect:'follow' would reach unchecked.
  // Bounded hops + an 8s timeout so a slow/hung host can't pin the invocation.
  let html = '';
  try {
    let target = url;
    for (let hop = 0; hop < 4; hop++) {
      const resp = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'shareo/0.1 (+https://shareo.co)' } });
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get('location');
        if (!loc) break;
        target = new URL(loc, target).toString();
        if (!isSafePublicUrl(target)) return json({ ok: true, feeds: [], note: 'unsafe_redirect' });
        continue; // re-fetch the validated redirect target
      }
      if (!resp.ok) return json({ ok: true, feeds: [], note: `fetch ${resp.status}` });
      if (Number(resp.headers.get('content-length') || 0) > 2_000_000) return json({ ok: true, feeds: [], note: 'too_large' });
      html = (await resp.text()).slice(0, 200_000); // bound the parse
      break;
    }
  } catch (err) {
    return json({ ok: true, feeds: [], note: String(err) });
  }
  const feeds = new Set<string>();
  const linkTags = html.match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of linkTags) {
    const isFeed = /type=["']application\/(rss|atom)\+xml["']/i.test(tag) ||
      (/rel=["'][^"']*alternate[^"']*["']/i.test(tag) && /(rss|atom|feed)/i.test(tag));
    if (!isFeed) continue;
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    try { feeds.add(new URL(href, url).toString()); } catch { /* skip bad href */ }
  }
  const out = [...feeds].filter((f) => /^https:\/\//i.test(f)).slice(0, 5);
  return json({ ok: true, feeds: out, note: out.length ? undefined : 'no <link rel=alternate> feed found — paste the feed URL manually' });
}

/** Producer endpoint for out-of-Worker producers. HMAC over the raw body via INGEST_HMAC_SECRET. */
async function handleIngestProducer(req: Request, env: Env): Promise<Response> {
  if (!env.INGEST_HMAC_SECRET) return json({ error: 'producer ingest not configured' }, 503);
  const raw = await req.text();
  if (!(await verifyHmac(env.INGEST_HMAC_SECRET, raw, req.headers.get('x-ingest-hmac-sha256')))) {
    return json({ error: 'bad_signature' }, 401);
  }
  let body: Partial<IngestInput>;
  try {
    body = JSON.parse(raw) as Partial<IngestInput>;
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  if (!body.source_id || !body.text || !body.detected_at) return json({ error: 'missing source_id, text or detected_at' }, 400);
  const r = await ingest(env, {
    source_id: body.source_id, source_type: body.source_type ?? 'web', text: body.text,
    url: body.url, detected_at: body.detected_at, external_id: body.external_id,
  });
  return json(r, r.ok ? 200 : 400);
}

/** Consume one queued item: one multi-tip extraction → resolve + insert each tip. */
async function consumeOne(env: Env, m: TipIngestMessage): Promise<void> {
  // Idempotency / no-re-pay guard: if a prior delivery already extracted (or dropped) this item, a
  // queue retry must NOT pay for the LLM call again. The paid `extractTips` below is the only
  // metered work, so this guard + the early status mark together bound extraction cost to once-per-item.
  const cur = await env.DB.prepare('SELECT status FROM ingest_items WHERE id = ?')
    .bind(m.ingest_item_id).first<{ status: string }>();
  if (cur && (cur.status === 'extracted' || cur.status === 'dropped')) {
    await logOps(env, 'extract', { ingest_item: m.ingest_item_id, skipped: 'already_processed' });
    return;
  }

  if (!(await withinBudget(env, EXTRACT_BUDGET_CENTS))) {
    await env.DB.prepare(`UPDATE ingest_items SET status = 'review' WHERE id = ?`).bind(m.ingest_item_id).run();
    await logOps(env, 'extract', { skipped: 'over_budget', ingest_item: m.ingest_item_id });
    return;
  }

  const { tips, costCents } = await extractTips(env, m.text);
  await recordSpend(env, costCents);

  // Mark the item processed IMMEDIATELY after paying, BEFORE the resolve/insert loop — so any later
  // failure + queue retry hits the guard above instead of re-running (and re-paying for) extraction.
  await env.DB.prepare(`UPDATE ingest_items SET status = ? WHERE id = ?`)
    .bind(tips.length === 0 ? 'dropped' : 'extracted', m.ingest_item_id).run();
  if (tips.length === 0) return;

  let resolved = 0;
  let lazyBudget = MAX_LAZY_LOOKUPS_PER_ITEM;
  const model = env.EXTRACT_MODEL || 'claude-opus-4-8';
  for (const tip of tips.slice(0, MAX_TIPS_PER_ITEM)) {
    try {
      const { security, reason } = await resolveSecurity(env, tip, lazyBudget > 0);
      if (reason === 'eodhd_lazy') lazyBudget--;
      if (security) resolved++;
      await env.DB.prepare(
        `INSERT OR IGNORE INTO tips
           (id, security_id, source_id, ingest_item_id, direction, conviction, horizon, tip_type,
            horizon_days_target, target_price_raw, target_currency, rationale, evidence_span, speaker,
            confidence, extractor, detected_at, status, resolve_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        uid(), security?.id ?? null, m.source_id, m.ingest_item_id, tip.direction, tip.conviction, tip.horizon,
        tip.tip_type, tip.horizon_days_target, tip.target_price, tip.target_currency, tip.rationale,
        tip.evidence_span, tip.speaker, tip.confidence, model, m.detected_at,
        security ? 'resolved' : 'review', reason ?? null, nowISO(),
      ).run();
    } catch (err) {
      // One bad tip is logged and skipped — never throw the consumer into a retry (which would re-pay).
      await logOps(env, 'error', { at: 'consumeOne.tip', ingest_item: m.ingest_item_id, err: String(err) });
    }
  }

  await logOps(env, 'extract', { ingest_item: m.ingest_item_id, tips: tips.length, resolved });
}

async function handleRunDaily(req: Request, env: Env): Promise<Response> {
  if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
  const opened = await openPendingPositions(env);
  const trades = await executeApprovedTrades(env);
  const valued = await valueOpenPositions(env);
  const risk = await recomputeRiskMetrics(env);
  const nav = await snapshotNav(env);
  const rated = await recomputeRatings(env);
  await logOps(env, 'cron', { job: 'manual-daily', ...opened, ...valued, ...risk, ...rated });
  return json({ ok: true, ...opened, trades, ...valued, risk, nav, rated });
}

async function handleRunWeekly(req: Request, env: Env): Promise<Response> {
  if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
  const url = new URL(req.url);
  // Idempotent by default (returns the cached draft, no LLM spend); ?force=1 deliberately regenerates.
  return json(await generateAndStoreDigest(env, url.searchParams.get('week') || undefined, url.searchParams.get('force') === '1'));
}

async function handleDigest(req: Request, env: Env): Promise<Response> {
  if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
  const week = new URL(req.url).searchParams.get('week');
  if (!week) return json({ error: 'missing ?week=YYYY-Www' }, 400);
  const obj = await env.RAW_MEDIA.get(`digests/${week}.html`);
  if (!obj) return json({ error: 'not_found', week }, 404);
  return new Response(obj.body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/** Admin: push the stored weekly digest to beehiiv as a draft (human reviews + sends). */
async function handlePublishDigest(req: Request, env: Env): Promise<Response> {
  if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
  const week = new URL(req.url).searchParams.get('week') || undefined;
  return json(await publishDigestToBeehiiv(env, week));
}

/** Admin: push not-yet-synced subscribers to beehiiv (same bounded pass as the daily cron). */
async function handleSyncSubscribers(req: Request, env: Env): Promise<Response> {
  if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
  return json(await syncSubscribersToBeehiiv(env));
}

/** Admin: bulk-seed the security master from an EODHD exchange (?exchange=AU|US). */
async function handleSeedSecurities(req: Request, env: Env): Promise<Response> {
  if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
  const exchange = (new URL(req.url).searchParams.get('exchange') || 'AU').toUpperCase();
  return json(await seedExchange(env, exchange));
}

/**
 * Admin: backfill tip_type/horizon_days_target on pre-0007 rows from their stored free-text horizon.
 * Deterministic parser only (no LLM, no cost). Bounded by ?limit (default 200) — re-run to continue.
 */
async function handleBackfillTipType(req: Request, env: Env): Promise<Response> {
  if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
  const limit = Math.min(Math.max(Number(new URL(req.url).searchParams.get('limit')) || 200, 1), 1000);
  const rows = (await env.DB.prepare(
    `SELECT id, horizon FROM tips WHERE tip_type IS NULL ORDER BY created_at ASC LIMIT ?`,
  ).bind(limit).all<{ id: string; horizon: string | null }>()).results ?? [];
  const upd = env.DB.prepare('UPDATE tips SET tip_type = ?, horizon_days_target = ? WHERE id = ?');
  let updated = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    await env.DB.batch(chunk.map((r) => {
      const { tip_type, horizon_days_target } = classifyHorizon(r.horizon);
      return upd.bind(tip_type, horizon_days_target, r.id);
    }));
    updated += chunk.length;
  }
  await logOps(env, 'cron', { job: 'backfill-tip-type', scanned: rows.length, updated });
  return json({ ok: true, scanned: rows.length, updated, more: rows.length === limit });
}

/** Admin: run the producer pollers on demand (same as the hourly cron). */
async function handlePoll(req: Request, env: Env): Promise<Response> {
  if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
  const rss = await pollRssSources(env);
  const bluesky = await pollBlueskySources(env);
  const podcast = await pollPodcastSources(env);
  return json({ ok: true, rss, bluesky, podcast });
}

/** Audit trail: every admin mutation logs an ops_events kind='admin' row (one shared token = one actor). */
async function logAdmin(env: Env, endpoint: string, detail: Record<string, unknown> = {}): Promise<void> {
  await logOps(env, 'admin', { endpoint, ...detail, at: nowISO() });
}

/** Approve a proposed LIVE trade intent, then run the (only) executor for it. */
async function handleApproveTrade(req: Request, env: Env): Promise<Response> {
  if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
  const tip = new URL(req.url).searchParams.get('tip');
  if (!tip) return json({ error: 'missing ?tip=' }, 400);
  // CAS: only a 'proposed' intent can be approved (idempotent — a re-click finds nothing to move).
  const r = await env.DB.prepare(`UPDATE trade_intents SET status='approved', approved_at=? WHERE tip_id=? AND status='proposed'`)
    .bind(nowISO(), tip).run();
  await logAdmin(env, '/admin/approve-trade', { tip, approved: !!r.meta.changes });
  if (!r.meta.changes) return json({ ok: false, error: 'not_in_proposed_state', tip }, 409);
  const trades = await executeApprovedTrades(env);
  return json({ ok: true, tip, trades });
}

/** Reject a proposed trade intent — no broker call ever; the paper position remains the scoring record. */
async function handleRejectTrade(req: Request, env: Env): Promise<Response> {
  if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
  const tip = new URL(req.url).searchParams.get('tip');
  if (!tip) return json({ error: 'missing ?tip=' }, 400);
  const r = await env.DB.prepare(`UPDATE trade_intents SET status='rejected' WHERE tip_id=? AND status IN ('proposed','failed')`).bind(tip).run();
  await logAdmin(env, '/admin/reject-trade', { tip, rejected: !!r.meta.changes });
  return json({ ok: !!r.meta.changes, tip });
}

/** Kill-switch: flip KV trading:enabled. eligibleForRealBuy + executeApprovedTrades read it (fail-closed). */
async function handleTradingToggle(req: Request, env: Env, pause: boolean): Promise<Response> {
  if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
  await env.KV.put('trading:enabled', pause ? '0' : '1');
  await logAdmin(env, pause ? '/admin/trading-pause' : '/admin/trading-resume');
  return json({ ok: true, trading_enabled: !pause });
}

/** Set the effective broker mode via KV override (off|paper|live). live requires live keys present. */
async function handleSetAlpacaMode(req: Request, env: Env): Promise<Response> {
  if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
  const mode = (new URL(req.url).searchParams.get('mode') || '').toLowerCase();
  if (!['off', 'paper', 'live'].includes(mode)) return json({ error: 'mode must be off|paper|live' }, 400);
  if (mode === 'live' && (!env.ALPACA_KEY_ID || !env.ALPACA_SECRET_KEY)) {
    return json({ ok: false, error: 'live keys (ALPACA_KEY_ID/SECRET) not configured' }, 400);
  }
  await env.KV.put('alpaca:mode', mode);
  await logAdmin(env, '/admin/set-alpaca-mode', { mode });
  return json({ ok: true, alpaca_mode: mode });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/healthz') return handleHealthz(env);
    // Admin console (browser): token login → cookie session → dashboard.
    if (url.pathname === '/admin/login' && req.method === 'POST') return handleAdminLogin(req, env);
    if (url.pathname === '/admin/logout' && req.method === 'POST') return handleAdminLogout();
    if (url.pathname === '/admin' && (req.method === 'GET' || req.method === 'HEAD')) {
      return authed(req, env) ? adminDashboard(env) : adminLoginPage();
    }
    // Admin drill-down views (token-gated).
    if (url.pathname === '/admin/approvals' && req.method === 'GET') return authed(req, env) ? adminApprovals(env) : adminLoginPage();
    if (url.pathname === '/admin/trading' && req.method === 'GET') return authed(req, env) ? adminTrading(env) : adminLoginPage();
    if (url.pathname === '/admin/errors' && req.method === 'GET') return authed(req, env) ? adminErrors(env) : adminLoginPage();
    if (url.pathname === '/admin/sources' && req.method === 'GET') return authed(req, env) ? adminSources(env) : adminLoginPage();
    if (url.pathname === '/admin/add-tip' && req.method === 'GET') return authed(req, env) ? adminAddTip(env) : adminLoginPage();
    if (url.pathname === '/admin/newsletter' && req.method === 'GET') return authed(req, env) ? adminNewsletter(env) : adminLoginPage();
    if (url.pathname === '/admin/subscribers' && req.method === 'GET') return authed(req, env) ? adminSubscribers(env) : adminLoginPage();
    if (url.pathname === '/admin/add-source' && req.method === 'POST') return handleAddSource(req, env);
    if (url.pathname === '/admin/toggle-source' && req.method === 'POST') return handleToggleSource(req, env);
    if (url.pathname === '/admin/set-tos' && req.method === 'POST') return handleSetTos(req, env);
    if (url.pathname === '/admin/backfill-source' && req.method === 'POST') return handleBackfillSource(req, env);
    if (url.pathname === '/admin/find-feed' && req.method === 'POST') return handleFindFeed(req, env);
    // Trade approval + brokerage controls (mutations).
    if (url.pathname === '/admin/approve-trade' && req.method === 'POST') return handleApproveTrade(req, env);
    if (url.pathname === '/admin/reject-trade' && req.method === 'POST') return handleRejectTrade(req, env);
    if (url.pathname === '/admin/trading-pause' && req.method === 'POST') return handleTradingToggle(req, env, true);
    if (url.pathname === '/admin/trading-resume' && req.method === 'POST') return handleTradingToggle(req, env, false);
    if (url.pathname === '/admin/set-alpaca-mode' && req.method === 'POST') return handleSetAlpacaMode(req, env);
    if (url.pathname === '/ingest/human' && req.method === 'POST') return handleIngestHuman(req, env);
    if (url.pathname === '/ingest/producer' && req.method === 'POST') return handleIngestProducer(req, env);
    if (url.pathname === '/admin/run-daily' && req.method === 'POST') return handleRunDaily(req, env);
    if (url.pathname === '/admin/run-weekly' && req.method === 'POST') return handleRunWeekly(req, env);
    if (url.pathname === '/admin/digest' && req.method === 'GET') return handleDigest(req, env);
    if (url.pathname === '/admin/publish-digest' && req.method === 'POST') return handlePublishDigest(req, env);
    if (url.pathname === '/admin/sync-subscribers' && req.method === 'POST') return handleSyncSubscribers(req, env);
    if (url.pathname === '/admin/seed-securities' && req.method === 'POST') return handleSeedSecurities(req, env);
    if (url.pathname === '/admin/poll' && req.method === 'POST') return handlePoll(req, env);
    if (url.pathname === '/admin/backfill-tip-type' && req.method === 'POST') return handleBackfillTipType(req, env);

    // Public landing page (newsletter signup) + signup endpoint.
    if (url.pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) return landingPage(env);
    if (url.pathname === '/api/subscribe' && req.method === 'POST') return handleSubscribe(req, env);

    // Public, crawlable read surface (derived returns only — assertNoRawPrices-guarded).
    if (url.pathname === '/leaderboard') return leaderboard(env, url.searchParams.get('dim'));
    if (url.pathname === '/methodology') return methodologyPage();
    if (url.pathname === '/api/public/leaderboard') return leaderboardJson(env, url.searchParams.get('dim'));
    if (url.pathname === '/api/public/nav') return navJson(env, new URL(req.url).searchParams.get('scope') || 'all');
    const m = url.pathname.match(/^\/(sources|tips|securities)\/(.+)$/);
    if (m && req.method === 'GET') {
      const key = decodeURIComponent(m[2]);
      if (m[1] === 'sources') return sourcePage(env, key);
      if (m[1] === 'tips') return tipPage(env, key);
      if (m[1] === 'securities') return securityPage(env, key);
    }
    return json({ error: 'not_found', path: url.pathname }, 404);
  },

  async queue(batch: MessageBatch<TipIngestMessage>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        await consumeOne(env, msg.body);
        msg.ack();
      } catch (err) {
        // Retryable provider blips (Anthropic 429/529/503) are transient and the queue will retry —
        // log as 'warn' so they don't drive the HIGH "Errors" alarm. Reserve 'error' for the rest.
        const retryable = /\b(429|503|529)\b|overloaded|rate.?limit/i.test(String(err));
        await logOps(env, retryable ? 'warn' : 'error', { at: 'queue', ingest_item: msg.body.ingest_item_id, err: String(err), retrying: true });
        msg.retry(); // DLQ after max_retries
      }
    }
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron === '0 * * * *') {
      const rss = await pollRssSources(env);
      const bsky = await pollBlueskySources(env);
      const pod = await pollPodcastSources(env);
      // Hourly safety sweep: execute any operator-approved trade intents (bounded, fail-closed).
      const trades = await executeApprovedTrades(env);
      await logOps(env, 'cron', { job: 'hourly', rss, bsky, pod, trades });
    } else if (controller.cron === '0 6 * * *') {
      const opened = await openPendingPositions(env);
      const trades = await executeApprovedTrades(env);
      const valued = await valueOpenPositions(env);
      const risk = await recomputeRiskMetrics(env);
      const nav = await snapshotNav(env);
      const rated = await recomputeRatings(env);
      const synced = await syncSubscribersToBeehiiv(env);
      await logOps(env, 'cron', { job: 'daily', ...opened, trades, ...valued, ...risk, nav, ...rated, beehiiv: synced });
    } else {
      const digest = await generateAndStoreDigest(env);
      // On a real (non-quiet, non-cached) issue, also create the beehiiv DRAFT so the founder just
      // reviews + sends — never auto-sends. Idempotent on week, fail-closed, no-ops if beehiiv unconfigured.
      const published = digest.ok ? await publishDigestToBeehiiv(env) : null;
      await logOps(env, 'cron', { job: 'weekly', ...digest, beehiiv: published?.ok ? 'drafted' : published?.reason ?? 'skipped' });
    }
  },
};
