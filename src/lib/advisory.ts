/**
 * Compliance guards — the report-outcomes-never-recommend line, enforced in code.
 *
 * - assertFactual(text): rejects forward-looking / recommendation language before anything is
 *   published (newsletter draft, public copy). NECESSARY-not-sufficient: a human still approves.
 * - assertNoRawPrices(obj): keeps public payloads on the EODHD personal tier — derived
 *   returns/alpha only, never raw price/OHLC fields — unless PUBLIC_PRICES === "on".
 *
 * Both throw ComplianceError so a violation fails loudly (and can be caught + logged to ops_events).
 */
import type { Env } from '../types.js';

export class ComplianceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ComplianceError';
  }
}

// Recommendation / forward-looking phrases that move us from "what happened" to "what to do".
const BANNED_PHRASES: RegExp[] = [
  /\bbuy now\b/i,
  /\byou should (buy|sell|hold)\b/i,
  /\b(our|my|top|best) pick(s)?\b/i,
  /\b(strong )?(buy|sell) rating\b/i,
  /\bwe recommend\b/i,
  /\bprice target\b/i,
  /\bwill (rise|fall|soar|surge|crash|moon|double)\b/i,
  /\bguaranteed (return|profit|gain)\b/i,
  /\bget rich\b/i,
  /\bdon'?t miss\b/i,
  /\bload up\b/i,
];

export interface FactualResult {
  ok: boolean;
  violations: string[];
}

/** Returns the verdict without throwing — use for logging/CI reporting. */
export function checkFactual(text: string): FactualResult {
  const violations = BANNED_PHRASES.filter((re) => re.test(text)).map((re) => re.source);
  return { ok: violations.length === 0, violations };
}

/** Throws ComplianceError if any banned recommendation phrase is present. */
export function assertFactual(text: string): void {
  const { ok, violations } = checkFactual(text);
  if (!ok) {
    throw new ComplianceError('ADVICE_LANGUAGE', `Recommendation language detected: ${violations.join(', ')}`);
  }
}

// Raw market-data field names that constitute redistribution if shown publicly.
const RAW_PRICE_FIELDS = new Set([
  'price',
  'open',
  'high',
  'low',
  'close',
  'adjusted_close',
  'entry_price_raw',
  'entry_price_adj',
  'exit_price_adj',
  'price_adj',
  'ohlc',
  'last',
  'bid',
  'ask',
  'target_price_raw',
  'target_price',
  'target',
]);

function findRawPriceKeys(value: unknown, hits: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) findRawPriceKeys(v, hits);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (RAW_PRICE_FIELDS.has(k)) hits.add(k);
      findRawPriceKeys(v, hits);
    }
  }
}

/**
 * Guards every public payload. When PUBLIC_PRICES !== "on", any raw-price field is a breach
 * of the EODHD personal-tier licence — throw so it can never ship by accident.
 */
export function assertNoRawPrices(env: Env, payload: unknown): void {
  if (env.PUBLIC_PRICES === 'on') return; // commercial licence active — allowed
  const hits = new Set<string>();
  findRawPriceKeys(payload, hits);
  if (hits.size > 0) {
    throw new ComplianceError(
      'RAW_PRICE_LEAK',
      `Raw price fields in a public payload while PUBLIC_PRICES=off: ${[...hits].join(', ')}`,
    );
  }
}
