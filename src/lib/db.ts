/** Small shared helpers for IDs, time, and dates. */

export function uid(): string {
  return crypto.randomUUID();
}

export function nowISO(): string {
  return new Date().toISOString();
}

/** YYYY-MM-DD portion of an ISO timestamp. */
export function dateOnly(iso: string): string {
  return iso.slice(0, 10);
}

/** Add `n` days to a YYYY-MM-DD date, returning YYYY-MM-DD (UTC). */
export function addDays(dateISO: string, n: number): string {
  const d = new Date(`${dateOnly(dateISO)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole days between two YYYY-MM-DD dates (b - a). */
export function daysBetween(aISO: string, bISO: string): number {
  const a = Date.parse(`${dateOnly(aISO)}T00:00:00Z`);
  const b = Date.parse(`${dateOnly(bISO)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** Constant-time string compare (avoids timing attacks on token/secret checks). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Block SSRF: only allow https to public hosts (no loopback/private/link-local). */
export function isSafePublicUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h)) return false;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return false;
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return false;
  return true;
}

/** Hex SHA-256 of a string (content-hash for dedup). */
export async function sha256hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Log to ops_events; never throws (logging must not break the caller). */
export async function logOps(env: { DB: D1Database }, kind: string, detail: unknown): Promise<void> {
  try {
    await env.DB.prepare('INSERT INTO ops_events (id, kind, detail, created_at) VALUES (?, ?, ?, ?)')
      .bind(uid(), kind, JSON.stringify(detail), nowISO())
      .run();
  } catch {
    /* swallow */
  }
}
