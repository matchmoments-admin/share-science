/**
 * Pure adjusted-close series resolver — no runtime imports, so it is unit-testable under the node
 * test runner (which can't resolve the `.js`→`.ts` imports in prices.ts). The fetch lives in
 * prices.ts (getAdjCloseSeries); this is just the local lookup that replaces per-position EODHD calls.
 */
import type { Bar } from './prices.js'; // type-only — stripped at runtime, no module load

/** A security's adjusted-close history over a range, ascending by date, indexed for as-of lookups. */
export interface AdjSeries { bars: Bar[] }

/**
 * Adjusted close on `dateISO`, or the most recent bar at/before it within the series. Null if none.
 * Identical semantics to getAdjCloseAsOf ("most recent trading day at/before the date", no look-ahead)
 * — just sourced from pre-fetched bars instead of a fresh EODHD call.
 */
export function adjCloseFromSeries(series: AdjSeries, dateISO: string): Bar | null {
  const cut = dateISO.slice(0, 10); // date-only (matches db.dateOnly)
  let found: Bar | null = null;
  for (const b of series.bars) { // ascending — keep the last bar with date <= cut
    if (b.date <= cut) found = b; else break;
  }
  return found;
}
