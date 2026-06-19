// Unit goldens for the pre-fetched price series resolver. Run: npm test
// Guards the EODHD call-reduction refactor: adjCloseFromSeries must reproduce getAdjCloseAsOf's
// "most recent trading day at/before the date" semantics exactly (CLAUDE.md empirical-integrity rule).
import test from 'node:test';
import assert from 'node:assert/strict';
import { adjCloseFromSeries } from '../src/lib/series.ts';

// Ascending series with a weekend gap (Fri 03 → Mon 06) and a holiday-style gap.
const series = {
  bars: [
    { date: '2026-01-02', raw: 100, adj: 100 },
    { date: '2026-01-03', raw: 101, adj: 101 },
    { date: '2026-01-06', raw: 103, adj: 103 },
    { date: '2026-01-07', raw: 104, adj: 104 },
  ],
};

test('exact-date hit returns that bar', () => {
  assert.equal(adjCloseFromSeries(series, '2026-01-06').adj, 103);
});

test('as-of falls back to the most recent bar at/before the date (weekend → Friday)', () => {
  // Sun 2026-01-04 and Sat 2026-01-05 have no bar → use Fri 2026-01-03.
  assert.equal(adjCloseFromSeries(series, '2026-01-04').date, '2026-01-03');
  assert.equal(adjCloseFromSeries(series, '2026-01-05').adj, 101);
});

test('a date after the last bar returns the last bar', () => {
  assert.equal(adjCloseFromSeries(series, '2026-02-01').date, '2026-01-07');
});

test('a date before the first bar returns null (no look-ahead)', () => {
  assert.equal(adjCloseFromSeries(series, '2025-12-31'), null);
});

test('accepts a full ISO timestamp (date-only comparison)', () => {
  assert.equal(adjCloseFromSeries(series, '2026-01-06T09:30:00Z').adj, 103);
});

test('empty series returns null', () => {
  assert.equal(adjCloseFromSeries({ bars: [] }, '2026-01-06'), null);
});
