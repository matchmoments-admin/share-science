/**
 * Spend metering seam. Every paid call (LLM extraction, transcription, market data) is
 * tallied here and gated by withinBudget() BEFORE it runs. Over budget => the caller routes
 * to needs_review and NEVER auto-trades a degraded parse (guardrail #6).
 *
 * v1 uses a daily KV counter (cheap, lossy-tolerant). A D1-backed daily_cost table can
 * replace it later if exact accounting is needed.
 */
import type { Env } from '../types.js';

const DAY_MS = 86_400_000;

function dayKey(now: number): string {
  return `spend:${new Date(now).toISOString().slice(0, 10)}`; // spend:YYYY-MM-DD
}

/** Cents spent so far today (best-effort). */
export async function spentTodayCents(env: Env, now = Date.now()): Promise<number> {
  const raw = await env.KV.get(dayKey(now));
  return raw ? Number(raw) || 0 : 0;
}

/** True if at least `costCents` of headroom remains under MAX_DAILY_COST_CENTS. */
export async function withinBudget(env: Env, costCents: number, now = Date.now()): Promise<boolean> {
  const cap = Number(env.MAX_DAILY_COST_CENTS) || 0;
  if (cap <= 0) return false; // misconfigured cap => fail closed
  return (await spentTodayCents(env, now)) + costCents <= cap;
}

/** Record actual spend after a paid call. Best-effort increment with a 2-day TTL. */
export async function recordSpend(env: Env, costCents: number, now = Date.now()): Promise<void> {
  if (costCents <= 0) return;
  const key = dayKey(now);
  const next = (await spentTodayCents(env, now)) + costCents;
  await env.KV.put(key, String(next), { expirationTtl: Math.ceil((2 * DAY_MS) / 1000) });
}

/**
 * Best-effort fixed-window rate limit on a KV counter. Returns true if the action is allowed
 * (and increments the window), false if `bucket` has already reached `max` within `windowSec`.
 * KV is eventually consistent, so this is abuse mitigation — not a hard guarantee.
 */
export async function rateLimit(env: Env, bucket: string, max: number, windowSec: number, now = Date.now()): Promise<boolean> {
  const window = Math.floor(now / 1000 / windowSec);
  const key = `rl:${bucket}:${window}`;
  const current = Number((await env.KV.get(key)) || 0) || 0;
  if (current >= max) return false;
  await env.KV.put(key, String(current + 1), { expirationTtl: windowSec + 60 });
  return true;
}
