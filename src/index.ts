/**
 * share-science Worker entry point.
 *
 *  - fetch()     : /healthz · /ingest/{human,producer} · /admin/* · public read API
 *  - queue()     : tips-ingest consumer — extract (multi-tip) → resolve (abstain) → record tips
 *  - scheduled() : hourly = producers (RSS…); daily = open+value+rate; weekly = newsletter draft
 */
import type { Env, TipIngestMessage } from './types.js';
import { uid, nowISO, logOps, timingSafeEqual } from './lib/db.js';
import { spentTodayCents, withinBudget, recordSpend } from './lib/usage.js';
import { ingest, verifyHmac, type IngestInput } from './lib/ingest.js';
import { extractTips } from './lib/extract.js';
import { resolveSecurity } from './lib/resolve.js';
import { seedExchange } from './lib/securities.js';
import { openPendingPositions } from './lib/trade.js';
import { valueOpenPositions } from './lib/track.js';
import { recomputeRatings } from './lib/ratings.js';
import { pollRssSources } from './lib/producers/rss.js';
import { pollBlueskySources } from './lib/producers/bluesky.js';
import { pollPodcastSources } from './lib/producers/podcast.js';
import { leaderboard, leaderboardJson, sourcePage, tipPage, securityPage } from './lib/pages.js';
import { landingPage, handleSubscribe } from './lib/landing.js';
import { generateAndStoreDigest } from './lib/content.js';

const EXTRACT_BUDGET_CENTS = 5; // headroom before an extraction call (multi-tip ≈ a few cents)
const MAX_TIPS_PER_ITEM = 35; // covers a full multi-analyst episode (e.g. The Call ~13 stocks × 2); still bounded
const MAX_LAZY_LOOKUPS_PER_ITEM = 12; // bound EODHD lazy-resolution calls per message

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function authed(req: Request, env: Env): boolean {
  const tok = req.headers.get('x-admin-token');
  return !!env.ADMIN_TOKEN && !!tok && timingSafeEqual(tok, env.ADMIN_TOKEN);
}

async function handleHealthz(env: Env): Promise<Response> {
  let dbOk = false;
  try {
    await env.DB.prepare('SELECT 1').first();
    dbOk = true;
  } catch {
    dbOk = false;
  }
  return json({
    status: dbOk ? 'ok' : 'degraded',
    service: 'share-science',
    public_prices: env.PUBLIC_PRICES,
    spend_today_cents: await spentTodayCents(env).catch(() => null),
    daily_cap_cents: Number(env.MAX_DAILY_COST_CENTS) || null,
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
  const r = await ingest(env, {
    source_id: body.source_id, source_type: 'human', text: body.text, url: body.url,
    detected_at: body.detected_at || nowISO(),
  });
  return json(r, r.ok ? 200 : 400);
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
  if (!(await withinBudget(env, EXTRACT_BUDGET_CENTS))) {
    await env.DB.prepare(`UPDATE ingest_items SET status = 'review' WHERE id = ?`).bind(m.ingest_item_id).run();
    await logOps(env, 'extract', { skipped: 'over_budget', ingest_item: m.ingest_item_id });
    return;
  }

  const { tips, costCents } = await extractTips(env, m.text);
  await recordSpend(env, costCents);

  if (tips.length === 0) {
    await env.DB.prepare(`UPDATE ingest_items SET status = 'dropped' WHERE id = ?`).bind(m.ingest_item_id).run();
    return;
  }

  let resolved = 0;
  let lazyBudget = MAX_LAZY_LOOKUPS_PER_ITEM;
  const model = env.EXTRACT_MODEL || 'claude-opus-4-8';
  for (const tip of tips.slice(0, MAX_TIPS_PER_ITEM)) {
    const { security, reason } = await resolveSecurity(env, tip, lazyBudget > 0);
    if (reason === 'eodhd_lazy') lazyBudget--;
    if (security) resolved++;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO tips
         (id, security_id, source_id, ingest_item_id, direction, conviction, horizon, rationale,
          evidence_span, speaker, confidence, extractor, detected_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      uid(), security?.id ?? null, m.source_id, m.ingest_item_id, tip.direction, tip.conviction, tip.horizon,
      tip.rationale, tip.evidence_span, tip.speaker, tip.confidence, model, m.detected_at,
      security ? 'resolved' : 'review', nowISO(),
    ).run();
  }

  await env.DB.prepare(`UPDATE ingest_items SET status = 'extracted' WHERE id = ?`).bind(m.ingest_item_id).run();
  await logOps(env, 'extract', { ingest_item: m.ingest_item_id, tips: tips.length, resolved });
}

async function handleRunDaily(req: Request, env: Env): Promise<Response> {
  if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
  const opened = await openPendingPositions(env);
  const valued = await valueOpenPositions(env);
  const rated = await recomputeRatings(env);
  await logOps(env, 'cron', { job: 'manual-daily', ...opened, ...valued, ...rated });
  return json({ ok: true, ...opened, ...valued, rated });
}

async function handleRunWeekly(req: Request, env: Env): Promise<Response> {
  if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
  return json(await generateAndStoreDigest(env));
}

async function handleDigest(req: Request, env: Env): Promise<Response> {
  if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
  const week = new URL(req.url).searchParams.get('week');
  if (!week) return json({ error: 'missing ?week=YYYY-Www' }, 400);
  const obj = await env.RAW_MEDIA.get(`digests/${week}.html`);
  if (!obj) return json({ error: 'not_found', week }, 404);
  return new Response(obj.body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/** Admin: bulk-seed the security master from an EODHD exchange (?exchange=AU|US). */
async function handleSeedSecurities(req: Request, env: Env): Promise<Response> {
  if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
  const exchange = (new URL(req.url).searchParams.get('exchange') || 'AU').toUpperCase();
  return json(await seedExchange(env, exchange));
}

/** Admin: run the producer pollers on demand (same as the hourly cron). */
async function handlePoll(req: Request, env: Env): Promise<Response> {
  if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
  const rss = await pollRssSources(env);
  const bluesky = await pollBlueskySources(env);
  const podcast = await pollPodcastSources(env);
  return json({ ok: true, rss, bluesky, podcast });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/healthz') return handleHealthz(env);
    if (url.pathname === '/ingest/human' && req.method === 'POST') return handleIngestHuman(req, env);
    if (url.pathname === '/ingest/producer' && req.method === 'POST') return handleIngestProducer(req, env);
    if (url.pathname === '/admin/run-daily' && req.method === 'POST') return handleRunDaily(req, env);
    if (url.pathname === '/admin/run-weekly' && req.method === 'POST') return handleRunWeekly(req, env);
    if (url.pathname === '/admin/digest' && req.method === 'GET') return handleDigest(req, env);
    if (url.pathname === '/admin/seed-securities' && req.method === 'POST') return handleSeedSecurities(req, env);
    if (url.pathname === '/admin/poll' && req.method === 'POST') return handlePoll(req, env);

    // Public landing page (newsletter signup) + signup endpoint.
    if (url.pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) return landingPage();
    if (url.pathname === '/api/subscribe' && req.method === 'POST') return handleSubscribe(req, env);

    // Public, crawlable read surface (derived returns only — assertNoRawPrices-guarded).
    if (url.pathname === '/leaderboard') return leaderboard(env);
    if (url.pathname === '/api/public/leaderboard') return leaderboardJson(env);
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
        await logOps(env, 'error', { at: 'queue', ingest_item: msg.body.ingest_item_id, err: String(err) });
        msg.retry(); // DLQ after max_retries
      }
    }
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron === '0 * * * *') {
      const rss = await pollRssSources(env);
      const bsky = await pollBlueskySources(env);
      const pod = await pollPodcastSources(env);
      await logOps(env, 'cron', { job: 'hourly', rss, bsky, pod });
    } else if (controller.cron === '0 6 * * *') {
      const opened = await openPendingPositions(env);
      const valued = await valueOpenPositions(env);
      const rated = await recomputeRatings(env);
      await logOps(env, 'cron', { job: 'daily', ...opened, ...valued, ...rated });
    } else {
      const digest = await generateAndStoreDigest(env);
      await logOps(env, 'cron', { job: 'weekly', ...digest });
    }
  },
};
