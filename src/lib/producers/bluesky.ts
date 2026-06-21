/**
 * Bluesky producer — polls a curated author list via the public, unauthenticated AppView. The tip
 * text is in the post itself (no transcript). Read-only; honors deletions implicitly (we only
 * ingest what the feed currently returns). Bounded per run per the automation-safety rule.
 */
import type { Env } from '../../types.js';
import { ingest } from '../ingest.js';
import { logOps, recordSourceHealth } from '../db.js';

const APPVIEW = 'https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed';
const MAX_SOURCES_PER_RUN = 25;
const MAX_ITEMS_PER_SOURCE = 15;

interface BskySource {
  id: string;
  bluesky_did: string;
}

interface FeedPost {
  post?: {
    uri?: string;
    author?: { did?: string };
    record?: { text?: string; createdAt?: string; $type?: string };
  };
  reason?: { $type?: string }; // present on reposts
}

export async function pollBlueskySources(env: Env): Promise<{ sources: number; items: number; ingested: number }> {
  const sources = (await env.DB.prepare(
    `SELECT id, bluesky_did FROM sources
      WHERE active = 1 AND tos_checked = 1 AND ingest_method = 'bluesky' AND bluesky_did IS NOT NULL
      ORDER BY last_cursor ASC LIMIT ?`,
  ).bind(MAX_SOURCES_PER_RUN).all<BskySource>()).results ?? [];

  let items = 0;
  let ingested = 0;
  for (const s of sources) {
    try {
      const posts = await fetchAuthorFeed(s.bluesky_did);
      for (const fp of posts.slice(0, MAX_ITEMS_PER_SOURCE)) {
        const p = fp.post;
        // own original posts only — skip reposts (have a `reason`) and other-author items.
        if (fp.reason || !p?.record?.text || !p.record.createdAt) continue;
        if (p.author?.did && p.author.did !== s.bluesky_did) continue;
        items++;
        const r = await ingest(env, {
          source_id: s.id, source_type: 'bluesky', text: p.record.text,
          url: postUrl(s.bluesky_did, p.uri), detected_at: new Date(p.record.createdAt).toISOString(),
        });
        if (r.ok && !r.duplicate) ingested++;
      }
      await recordSourceHealth(env, s.id, true);
    } catch (err) {
      await logOps(env, 'warn', { at: 'pollBlueskySources', source: s.id, err: String(err) });
      await recordSourceHealth(env, s.id, false, String(err));
    }
    await env.DB.prepare('UPDATE sources SET last_cursor = ? WHERE id = ?').bind(new Date().toISOString(), s.id).run();
  }
  await logOps(env, 'cron', { job: 'pollBlueskySources', sources: sources.length, items, ingested });
  return { sources: sources.length, items, ingested };
}

async function fetchAuthorFeed(did: string): Promise<FeedPost[]> {
  const url = `${APPVIEW}?actor=${encodeURIComponent(did)}&filter=posts_no_replies&limit=30`;
  const resp = await fetch(url, { headers: { 'user-agent': 'share-science/0.1' } });
  if (!resp.ok) throw new Error(`bsky getAuthorFeed ${did} ${resp.status}`);
  const data = (await resp.json()) as { feed?: FeedPost[] };
  return Array.isArray(data.feed) ? data.feed : [];
}

/** at://did/app.bsky.feed.post/<rkey> → https://bsky.app/profile/<did>/post/<rkey> */
function postUrl(did: string, uri?: string): string {
  const rkey = uri?.split('/').pop();
  const d = encodeURIComponent(did);
  return rkey ? `https://bsky.app/profile/${d}/post/${encodeURIComponent(rkey)}` : `https://bsky.app/profile/${d}`;
}
