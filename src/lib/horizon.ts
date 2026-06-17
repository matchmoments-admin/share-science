/**
 * Horizon classification — pure, I/O-free so it's unit-testable and reusable.
 *
 * A tip's STATED horizon should govern which window scores it: judging a 5-year buy-and-hold at 30
 * days is unfair; judging a "pops this week" call at 365 days is meaningless. We normalise the
 * free-text `tips.horizon` (plus an optional LLM tip_type hint) into a bucket + an approximate
 * numeric target, then map that to the standard {30,90,365} window used as the PRIMARY score.
 */

export type TipType = 'short' | 'swing' | 'buy_hold';

export interface HorizonClass {
  tip_type: TipType | null; // null = unknown
  horizon_days_target: number | null; // approximate stated horizon in days, null if unstated
}

/** Standard settled-return horizons (must match track.ts HORIZONS). */
export const STANDARD_HORIZONS = [30, 90, 365] as const;

/** The window a tip is scored on PRIMARILY. Unknown → 90 (preserves the historical default). */
export function primaryHorizon(tipType: TipType | null, horizonDaysTarget: number | null): number {
  if (horizonDaysTarget && horizonDaysTarget > 0) {
    return STANDARD_HORIZONS.reduce((best, h) =>
      Math.abs(h - horizonDaysTarget) < Math.abs(best - horizonDaysTarget) ? h : best, STANDARD_HORIZONS[0]);
  }
  switch (tipType) {
    case 'short': return 30;
    case 'buy_hold': return 365;
    case 'swing': return 90;
    default: return 90;
  }
}

/** Parse a stated horizon string to an approximate number of days, else null. */
export function parseHorizonDays(text: string | null): number | null {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/\b(intraday|overnight|day\s*trade|same[\s-]*day|eod|end of day|scalp)\b/.test(t)) return 1;
  const m = t.match(/(\d+(?:\.\d+)?)\s*(days?|d|weeks?|wks?|w|months?|mos?|m|years?|yrs?|y)\b/);
  if (m) {
    const n = parseFloat(m[1]);
    const unit = m[2];
    if (unit[0] === 'd') return Math.round(n);
    if (unit[0] === 'w') return Math.round(n * 7);
    if (unit[0] === 'y') return Math.round(n * 365);
    return Math.round(n * 30); // m / mo / month(s)
  }
  if (/\b(a|one)\s+year\b/.test(t)) return 365;
  if (/\b(a|one)\s+month\b/.test(t)) return 30;
  if (/\bquarter\b/.test(t)) return 90;
  return null;
}

/**
 * Classify a tip's horizon. Prefers an explicit tip_type hint (the LLM has the most context), then
 * a numeric target, then keyword heuristics over the free-text horizon. Deterministic — the same
 * parser powers the no-LLM backfill of historical rows.
 */
export function classifyHorizon(horizonText: string | null, tipTypeHint?: string | null): HorizonClass {
  const horizon_days_target = parseHorizonDays(horizonText);
  let tip_type: TipType | null =
    tipTypeHint === 'short' || tipTypeHint === 'swing' || tipTypeHint === 'buy_hold' ? tipTypeHint : null;

  if (!tip_type && horizon_days_target !== null) {
    tip_type = horizon_days_target <= 21 ? 'short' : horizon_days_target <= 270 ? 'swing' : 'buy_hold';
  }
  if (!tip_type && horizonText) {
    const t = horizonText.toLowerCase();
    if (/\b(intraday|overnight|day[\s-]*trade|scalp|this week|next week|short[\s-]*term|catalyst)\b/.test(t)) tip_type = 'short';
    else if (/\b(long[\s-]*term|buy[\s-]*and[\s-]*hold|hold forever|multi[\s-]*year|decade|retirement|leaps?|years)\b/.test(t)) tip_type = 'buy_hold';
    else if (/\b(swing|weeks|months|quarter|near[\s-]*term)\b/.test(t)) tip_type = 'swing';
  }
  return { tip_type, horizon_days_target };
}
