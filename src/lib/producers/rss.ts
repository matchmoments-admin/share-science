/**
 * Full-text RSS producer — blogs + Substacks. The buy/sell verdict is in the article body, so no
 * transcript is needed. Each item → ingest() (content-hash dedup means re-polls don't re-extract).
 */
import type { Env } from '../../types.js';
import { ingest } from '../ingest.js';
import { logOps, isSafePublicUrl } from '../db.js';

const MAX_ITEMS_PER_FEED = 10; // bound cost; older items already ingested earlier
// Per-run cap (automation-safety rule): keep one poll invocation well under the Workers
// subrequest limit. Beyond this many feeds, add a last_polled rotation cursor.
const MAX_FEEDS_PER_RUN = 25;

export interface RssItem {
  title: string;
  link: string;
  pubDate: string;
  content: string;
  enclosure: string; // audio URL for podcast items ('' for blogs)
  guid: string; // stable item id for dedup
}

interface RssSource {
  id: string;
  feed_url: string;
}

export async function pollRssSources(env: Env): Promise<{ feeds: number; items: number; ingested: number }> {
  const sources = (await env.DB.prepare(
    `SELECT id, feed_url FROM sources WHERE active = 1 AND ingest_method = 'rss_fulltext' AND feed_url IS NOT NULL
      ORDER BY last_cursor ASC LIMIT ?`,
  ).bind(MAX_FEEDS_PER_RUN).all<RssSource>()).results ?? [];

  let items = 0;
  let ingested = 0;
  for (const s of sources) {
    try {
      const parsed = await fetchFeed(env, s);
      for (const it of parsed.slice(0, MAX_ITEMS_PER_FEED)) {
        items++;
        const text = `${it.title}\n\n${stripHtml(it.content)}`.trim();
        const detected_at = toISO(it.pubDate);
        if (!text || !detected_at) continue;
        const r = await ingest(env, { source_id: s.id, source_type: 'blog', text, url: it.link, detected_at });
        if (r.ok && !r.duplicate) ingested++;
      }
    } catch (err) {
      // External feed fetch/parse failure — transient and out of our control. Log as 'warn' so it
      // doesn't inflate the HIGH "Errors" alarm; the next poll retries.
      await logOps(env, 'warn', { at: 'pollRssSources', source: s.id, err: String(err) });
    }
    await env.DB.prepare('UPDATE sources SET last_cursor = ? WHERE id = ?').bind(new Date().toISOString(), s.id).run();
  }
  await logOps(env, 'cron', { job: 'pollRssSources', feeds: sources.length, items, ingested });
  return { feeds: sources.length, items, ingested };
}

const BACKOFF_MS = 6 * 60 * 60 * 1000; // skip a feed for 6h after a 429/5xx — don't hammer it

/**
 * Polite fetch: honors a KV backoff after rate-limits/errors, sends conditional-GET headers
 * (ETag / If-Modified-Since), and returns [] on 304/backoff/soft-error (logged, never throws for
 * an HTTP status). Only a network exception bubbles to the caller's per-source try/catch.
 */
async function fetchFeed(env: Env, s: RssSource): Promise<RssItem[]> {
  if (!isSafePublicUrl(s.feed_url)) {
    await logOps(env, 'error', { at: 'fetchFeed', source: s.id, err: 'unsafe_feed_url' });
    return []; // SSRF guard — only https public hosts
  }
  const boKey = `feedbackoff:${s.id}`;
  const bo = await env.KV.get(boKey);
  if (bo && Date.now() < Number(bo)) return []; // still backing off

  const metaKey = `feedmeta:${s.id}`;
  const meta = (await env.KV.get(metaKey, 'json')) as { etag?: string; lastmod?: string } | null;
  const headers: Record<string, string> = { 'user-agent': 'shareo/0.1 (+https://shareo.co)' };
  if (meta?.etag) headers['if-none-match'] = meta.etag;
  if (meta?.lastmod) headers['if-modified-since'] = meta.lastmod;

  const resp = await fetch(s.feed_url, { headers });
  if (resp.status === 304) return []; // unchanged since last poll
  if (resp.status === 429 || resp.status >= 500) {
    await env.KV.put(boKey, String(Date.now() + BACKOFF_MS), { expirationTtl: Math.ceil(BACKOFF_MS / 1000) });
    // Transient feed rate-limit (429) / outage (5xx) — we back off 6h. Log as 'warn', not 'error'.
    await logOps(env, 'warn', { at: 'fetchFeed', source: s.id, status: resp.status, action: 'backoff_6h' });
    return [];
  }
  if (!resp.ok) return []; // 4xx (e.g. 404) — skip quietly this run

  const etag = resp.headers.get('etag');
  const lastmod = resp.headers.get('last-modified');
  if (etag || lastmod) await env.KV.put(metaKey, JSON.stringify({ etag, lastmod }), { expirationTtl: 30 * 86400 });
  return parseRss(await resp.text());
}

/** Minimal RSS 2.0 / Atom item parser (no DOM in Workers). Handles CDATA + common tags. */
export function parseRss(xml: string): RssItem[] {
  const blocks = matchAll(xml, /<(item|entry)\b[\s\S]*?<\/\1>/gi);
  return blocks.map((b) => ({
    title: decode(tag(b, 'title')),
    link: tag(b, 'link') || attr(b, 'link', 'href'),
    pubDate: tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date'),
    content: tag(b, 'content:encoded') || tag(b, 'content') || tag(b, 'description') || tag(b, 'summary'),
    enclosure: attr(b, 'enclosure', 'url') || attr(b, 'media:content', 'url'),
    guid: tag(b, 'guid') || tag(b, 'id'),
  }));
}

function matchAll(s: string, re: RegExp): string[] {
  return [...s.matchAll(re)].map((m) => m[0]);
}

function tag(block: string, name: string): string {
  const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i');
  const m = block.match(re);
  return m ? unwrapCdata(m[1]).trim() : '';
}

function attr(block: string, name: string, attrName: string): string {
  const re = new RegExp(`<${name}\\b[^>]*\\b${attrName}="([^"]*)"`, 'i');
  const m = block.match(re);
  return m ? m[1].trim() : '';
}

function unwrapCdata(s: string): string {
  const m = s.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return m ? m[1] : s;
}

export function stripHtml(s: string): string {
  return decode(s.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

export function toISO(pubDate: string): string | null {
  const t = Date.parse(pubDate);
  return isFinite(t) ? new Date(t).toISOString() : null;
}
