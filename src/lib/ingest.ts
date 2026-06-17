/**
 * Shared ingest seam — the one path every producer (human form, /ingest/producer, RSS/Bluesky/
 * podcast pollers) funnels through. Content-hash dedups at ingest_items; only NEW items enqueue,
 * so re-polling the same feed never re-extracts (cost-safe). detected_at must be a real publish
 * time, not now() — it drives look-ahead-free entry pricing.
 */
import type { Env, TipIngestMessage } from '../types.js';
import { uid, nowISO, sha256hex } from './db.js';

export interface IngestInput {
  source_id: string;
  source_type: TipIngestMessage['source_type'];
  text: string;
  url?: string;
  detected_at: string; // real public-publish time (ISO)
  external_id?: string;
}

export interface IngestResult {
  ok: boolean;
  ingest_item_id?: string;
  duplicate?: boolean;
  reason?: string;
}

const MS_DAY = 86_400_000;

/** Validate detected_at: reject future-dated (look-ahead) and absurdly old. Returns null if OK. */
export function checkDetectedAt(detected_at: string, now = Date.now()): string | null {
  const t = Date.parse(detected_at);
  if (!isFinite(t)) return 'bad_detected_at';
  if (t > now + MS_DAY) return 'future_detected_at'; // would have no entry bar / look-ahead
  if (t < now - 3 * 365 * MS_DAY) return 'too_old'; // >3y — likely a parsing error
  return null;
}

export async function ingest(env: Env, input: IngestInput): Promise<IngestResult> {
  if (!input.source_id || !input.text?.trim()) return { ok: false, reason: 'missing source_id or text' };

  const bad = checkDetectedAt(input.detected_at);
  if (bad) return { ok: false, reason: bad };

  const src = await env.DB.prepare('SELECT id FROM sources WHERE id = ?').bind(input.source_id).first();
  if (!src) return { ok: false, reason: 'unknown source_id' };

  const id = uid();
  const content_hash = await sha256hex(`${input.source_id}|${input.text}`);
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO ingest_items
       (id, source_id, source_type, external_id, content_hash, raw_text, url, raw_ref, detected_at, ingested_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'new')`,
  ).bind(id, input.source_id, input.source_type, input.external_id ?? null, content_hash, input.text, input.url ?? null, input.detected_at, nowISO()).run();

  if (!res.meta.changes) return { ok: true, duplicate: true }; // already seen — do not re-enqueue

  const msg: TipIngestMessage = {
    ingest_item_id: id, source_id: input.source_id, source_type: input.source_type,
    text: input.text, url: input.url, detected_at: input.detected_at,
  };
  await env.TIP_INGEST.send(msg);
  return { ok: true, ingest_item_id: id };
}

/** Constant-time-ish HMAC-SHA256 hex verify for /ingest/producer. */
export async function verifyHmac(secret: string, rawBody: string, headerSigHex: string | null): Promise<boolean> {
  if (!headerSigHex || !/^[a-f0-9]+$/i.test(headerSigHex)) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const expected = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (expected.length !== headerSigHex.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ headerSigHex.charCodeAt(i);
  return diff === 0;
}
