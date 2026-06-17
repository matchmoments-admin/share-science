/**
 * beehiiv v2 delivery client. Two operations, both bounded and idempotent at the call sites:
 *  - createSubscriber: POST /publications/{id}/subscriptions  (generally available)
 *  - createPostDraft : POST /publications/{id}/posts (status=draft) — Enterprise beta, may 403;
 *    callers must degrade gracefully (keep the R2 draft for a manual paste).
 *
 * These are FREE API calls (not metered like the LLM/market-data paths), so they are NOT gated on
 * MAX_DAILY_COST_CENTS — gating free email sync on the LLM budget would wrongly block it.
 * configured() returns false when creds are absent, so every call site no-ops cleanly pre-setup.
 */
import type { Env } from '../types.js';

const BASE = 'https://api.beehiiv.com/v2';

export function configured(env: Env): boolean {
  return !!env.BEEHIIV_API_KEY && !!env.BEEHIIV_PUBLICATION_ID;
}

interface BeehiivResult {
  ok: boolean;
  id?: string;
  status: number;
  error?: string;
}

async function call(env: Env, path: string, body: unknown): Promise<BeehiivResult> {
  try {
    const res = await fetch(`${BASE}/publications/${env.BEEHIIV_PUBLICATION_ID}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.BEEHIIV_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: text.slice(0, 300) };
    }
    const json = (await res.json().catch(() => ({}))) as { data?: { id?: string } };
    return { ok: true, status: res.status, id: json.data?.id };
  } catch (err) {
    return { ok: false, status: 0, error: String(err) };
  }
}

/** Add an email to the publication (single opt-in; no welcome email — the weekly issue is the welcome). */
export async function createSubscriber(env: Env, email: string, source: string): Promise<BeehiivResult> {
  return call(env, '/subscriptions', {
    email,
    reactivate_existing: false,
    send_welcome_email: false,
    utm_source: 'shareo-landing',
    utm_medium: source,
  });
}

/** Create a DRAFT post from pre-vetted HTML (founder reviews + sends in beehiiv). Never auto-sends. */
export async function createPostDraft(env: Env, title: string, bodyHtml: string): Promise<BeehiivResult> {
  return call(env, '/posts', { title, body_content: bodyHtml, status: 'draft' });
}
