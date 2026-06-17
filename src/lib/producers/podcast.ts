/**
 * Podcast producer — for shows whose buy/sell verdicts are spoken (e.g. The Call). Fetches the
 * podcast RSS, and for each NEW episode transcribes the audio via Deepgram (URL-based, no download),
 * then feeds show-notes + transcript into the same multi-tip extraction pipeline.
 *
 * Automation-safety: dedups on the episode guid BEFORE paying Deepgram; budget-gated; capped at a
 * few episodes per run; SSRF-checked feed; fails gracefully per source.
 */
import type { Env } from '../../types.js';
import { ingest } from '../ingest.js';
import { logOps, isSafePublicUrl } from '../db.js';
import { withinBudget, recordSpend } from '../usage.js';
import { parseRss, stripHtml, toISO } from './rss.js';

const MAX_PODCASTS_PER_RUN = 5;
const MAX_EPISODES_PER_RUN = 3; // bound Deepgram spend per invocation
const RESERVE_CENTS = 50; // headroom per episode (worst-case ~90min transcribe ~39c + extract ~10c)
const DEEPGRAM_CENTS_PER_MIN = 0.43; // Nova-3 pay-as-you-go ≈ $0.0043/min

interface PodSource {
  id: string;
  feed_url: string;
}

export async function pollPodcastSources(env: Env): Promise<{ sources: number; episodes: number; ingested: number; skipped?: string }> {
  if (!env.DEEPGRAM_API_KEY) return { sources: 0, episodes: 0, ingested: 0, skipped: 'no_deepgram_key' };

  const sources = (await env.DB.prepare(
    `SELECT id, feed_url FROM sources
      WHERE active = 1 AND ingest_method = 'podcast_transcript' AND feed_url IS NOT NULL
      ORDER BY last_cursor ASC LIMIT ?`,
  ).bind(MAX_PODCASTS_PER_RUN).all<PodSource>()).results ?? [];

  let episodes = 0;
  let ingested = 0;
  let budget = MAX_EPISODES_PER_RUN;
  for (const s of sources) {
    try {
      if (!isSafePublicUrl(s.feed_url)) {
        await logOps(env, 'error', { at: 'pollPodcastSources', source: s.id, err: 'unsafe_feed_url' });
        continue;
      }
      const resp = await fetch(s.feed_url, { headers: { 'user-agent': 'share-science/0.1' } });
      if (!resp.ok) continue;
      const items = parseRss(await resp.text());
      for (const it of items) {
        if (budget <= 0) break;
        const key = it.guid || it.enclosure || it.link;
        if (!it.enclosure || !key) continue;
        if (!isSafePublicUrl(it.enclosure)) continue;
        const detected_at = toISO(it.pubDate);
        if (!detected_at) { // never fall back to now() — that would fake a look-ahead-free entry
          await logOps(env, 'error', { at: 'pollPodcastSources', source: s.id, err: 'unparseable_pubDate' });
          continue;
        }
        if (await alreadyIngested(env, s.id, key)) continue; // dedup BEFORE paying Deepgram
        if (!(await withinBudget(env, RESERVE_CENTS))) {
          await logOps(env, 'publish', { at: 'pollPodcastSources', skipped: 'over_budget', source: s.id });
          budget = 0;
          break;
        }
        const tr = await transcribe(env, it.enclosure);
        await recordSpend(env, tr.costCents);
        episodes++;
        budget--;
        if (!tr.transcript) continue;
        const text = `${it.title}\n\n${stripHtml(it.content)}\n\nTRANSCRIPT:\n${tr.transcript}`;
        const r = await ingest(env, {
          source_id: s.id, source_type: 'podcast', text, url: it.link,
          detected_at, external_id: key,
        });
        if (r.ok && !r.duplicate) ingested++;
      }
    } catch (err) {
      await logOps(env, 'error', { at: 'pollPodcastSources', source: s.id, err: String(err) });
    }
    await env.DB.prepare('UPDATE sources SET last_cursor = ? WHERE id = ?').bind(new Date().toISOString(), s.id).run();
  }
  await logOps(env, 'cron', { job: 'pollPodcastSources', sources: sources.length, episodes, ingested });
  return { sources: sources.length, episodes, ingested };
}

async function alreadyIngested(env: Env, sourceId: string, externalId: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT 1 FROM ingest_items WHERE source_id = ? AND external_id = ? LIMIT 1')
    .bind(sourceId, externalId).first();
  return !!row;
}

interface Transcription {
  transcript: string;
  costCents: number;
}

/** Deepgram URL transcription (Deepgram fetches the audio itself — no download on our side). */
async function transcribe(env: Env, audioUrl: string): Promise<Transcription> {
  if (!isSafePublicUrl(audioUrl)) throw new Error('unsafe_audio_url'); // defense-in-depth (SSRF)
  const resp = await fetch('https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true', {
    method: 'POST',
    headers: { authorization: `Token ${env.DEEPGRAM_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ url: audioUrl }),
  });
  if (!resp.ok) throw new Error(`deepgram ${resp.status}`);
  const data = (await resp.json()) as {
    metadata?: { duration?: number };
    results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
  };
  const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
  const minutes = (data.metadata?.duration ?? 0) / 60;
  return { transcript, costCents: minutes * DEEPGRAM_CENTS_PER_MIN };
}
