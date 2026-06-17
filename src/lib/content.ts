/**
 * Weekly newsletter draft. Deterministic facts pack from the ledger → Claude drafts factual copy
 * → assertFactual() gate (report-not-recommend) → store HTML in R2 for manual paste into beehiiv.
 * Direct beehiiv API push is deferred (needs creds); founder reviews + sends the stored draft.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { Env } from '../types.js';
import { nowISO, logOps } from './db.js';
import { withinBudget, recordSpend } from './usage.js';
import { assertFactual, checkFactual } from './advisory.js';

const DRAFT_BUDGET_CENTS = 10;
const DEFAULT_MODEL = 'claude-opus-4-8';

export interface FactsPack {
  week: string;
  generated_at: string;
  top_sources: Array<{ tie_back_id: string; name: string; tier: string; n_tips: number; hit_rate: number; score_lower: number }>;
  closed_this_week: Array<{ tie_back_id: string; ticker: string; source: string; direction: string; return_pct: number | null; excess_pct: number | null; is_hit: number | null }>;
  opened_this_week: Array<{ tie_back_id: string; ticker: string; source: string; direction: string }>;
}

/** ISO-ish week label YYYY-Www based on a date (UTC). */
export function isoWeek(d = new Date()): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((date.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export async function assembleFactsPack(env: Env, week = isoWeek()): Promise<FactsPack> {
  const top = (await env.DB.prepare(
    `SELECT sr.source_id AS tie_back_id, s.name, sr.tier, sr.n_tips, sr.hit_rate, sr.score_lower
       FROM source_ratings sr JOIN sources s ON s.id = sr.source_id
      WHERE sr.dimension = 'horizon:90' ORDER BY sr.rank ASC LIMIT 5`,
  ).all()).results as FactsPack['top_sources'] ?? [];

  const closed = (await env.DB.prepare(
    `SELECT t.id AS tie_back_id, sec.ticker, s.name AS source, t.direction,
            p.return_pct, p.excess_return_pct AS excess_pct, p.is_hit
       FROM positions p JOIN tips t ON t.id = p.tip_id
       JOIN sources s ON s.id = t.source_id JOIN securities sec ON sec.id = p.security_id
      WHERE p.status = 'closed' AND p.exit_at >= date('now','-7 day') ORDER BY p.exit_at DESC LIMIT 20`,
  ).all()).results as FactsPack['closed_this_week'] ?? [];

  const opened = (await env.DB.prepare(
    `SELECT t.id AS tie_back_id, sec.ticker, s.name AS source, t.direction
       FROM tips t JOIN sources s ON s.id = t.source_id JOIN securities sec ON sec.id = t.security_id
      WHERE t.security_id IS NOT NULL AND t.detected_at >= date('now','-7 day') ORDER BY t.detected_at DESC LIMIT 20`,
  ).all()).results as FactsPack['opened_this_week'] ?? [];

  return { week, generated_at: nowISO(), top_sources: top, closed_this_week: closed, opened_this_week: opened };
}

export async function draftDigest(env: Env, pack: FactsPack): Promise<{ text: string; costCents: number }> {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: env.EXTRACT_MODEL || DEFAULT_MODEL,
    max_tokens: 1500,
    system:
      'You write a weekly newsletter for "share-science", which empirically tracks how public ' +
      'share tips perform vs the market. STRICT RULES: report only the facts in the provided JSON. ' +
      'Backward-looking and factual ONLY. Never tell the reader to buy, sell, or hold; never call ' +
      'anything a "pick" or "best"; never predict; never use numbers not present in the JSON. Plain, ' +
      'concise prose. End with one neutral line: "General information only — outcomes, not advice."',
    messages: [{ role: 'user', content: `Write this week's issue from these facts:\n\n${JSON.stringify(pack, null, 2)}` }],
  });
  const costCents = (msg.usage.input_tokens / 1e6) * 500 + (msg.usage.output_tokens / 1e6) * 2500;
  const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
  return { text, costCents };
}

/** Assemble → draft → assertFactual → store HTML in R2. Returns the stored key + verdict. */
export async function generateAndStoreDigest(env: Env, week = isoWeek()): Promise<{ ok: boolean; week: string; key?: string; reason?: string }> {
  if (!(await withinBudget(env, DRAFT_BUDGET_CENTS))) {
    await logOps(env, 'publish', { skipped: 'over_budget', week });
    return { ok: false, week, reason: 'over_budget' };
  }
  const pack = await assembleFactsPack(env, week);
  const { text, costCents } = await draftDigest(env, pack);
  await recordSpend(env, costCents);

  const verdict = checkFactual(text);
  if (!verdict.ok) {
    await logOps(env, 'compliance', { week, blocked: 'advice_language', violations: verdict.violations });
    return { ok: false, week, reason: `advice_language: ${verdict.violations.join(', ')}` };
  }
  assertFactual(text); // belt-and-suspenders

  const key = `digests/${week}.html`;
  const html = `<!doctype html><meta charset="utf-8"><title>share-science ${week}</title>` +
    `<article style="font:16px/1.6 system-ui;max-width:680px;margin:2rem auto">` +
    text.split('\n').map((p) => (p.trim() ? `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>` : '')).join('') +
    `</article>`;
  await env.RAW_MEDIA.put(key, html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
  await logOps(env, 'publish', { week, key, top_sources: pack.top_sources.length, closed: pack.closed_this_week.length });
  return { ok: true, week, key };
}
