// Unit goldens for the similarity math (within-sector z-score + cosine). Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { zScoreGroup, cosine, correlation } from '../src/lib/similar-math.ts';

// Build a FundRow from a partial; unset factors are null (the "missing" case).
function mk(id, f) {
  return {
    id, ticker: id, sector: 'Tech',
    mcap_log: null, pe: null, pb: null, ps: null, margin: null, roe: null, growth: null, de: null, beta: null,
    ...f,
  };
}

test('within-sector cosine ranks the near-twin above the outlier', () => {
  // A and B have near-identical fundamentals; C is a different beast (huge, cheap, low growth).
  const members = [
    mk('A', { mcap_log: 11.0, pe: 22, pb: 5, ps: 6, margin: 0.25, roe: 0.30, growth: 0.20, de: 0.4, beta: 1.3 }),
    mk('B', { mcap_log: 11.2, pe: 23, pb: 5.2, ps: 6.3, margin: 0.24, roe: 0.29, growth: 0.19, de: 0.45, beta: 1.25 }),
    mk('C', { mcap_log: 14.0, pe: 8, pb: 1.1, ps: 1.0, margin: 0.05, roe: 0.08, growth: 0.01, de: 2.0, beta: 0.7 }),
    mk('D', { mcap_log: 13.0, pe: 12, pb: 2.0, ps: 2.0, margin: 0.10, roe: 0.12, growth: 0.05, de: 1.2, beta: 0.9 }),
    mk('E', { mcap_log: 10.5, pe: 30, pb: 7, ps: 9, margin: 0.30, roe: 0.35, growth: 0.30, de: 0.2, beta: 1.5 }),
  ];
  const z = zScoreGroup(members);
  const get = (x, y) => cosine(z.get(x), z.get(y));
  assert.ok(get('A', 'B') > get('A', 'C'), `A~B (${get('A','B').toFixed(3)}) should beat A~C (${get('A','C').toFixed(3)})`);
  assert.ok(get('A', 'B') > get('A', 'D'), 'the near-twin is the nearest neighbour');
});

test('missing factors are treated as the sector mean (z=0), never crash', () => {
  const members = [
    mk('A', { mcap_log: 11, pe: 20 }),       // only two factors known
    mk('B', { mcap_log: 11, pe: 20 }),       // identical knowns
    mk('C', { mcap_log: 14, pe: 8, beta: 0.7 }),
  ];
  const z = zScoreGroup(members);
  // A and B share identical known factors → cosine 1 (or 0 if both vectors collapse to origin); never NaN.
  const ab = cosine(z.get('A'), z.get('B'));
  assert.ok(Number.isFinite(ab), `cosine must be finite, got ${ab}`);
  assert.ok(ab >= 0, 'identical known factors → non-negative similarity');
});

test('cosine of a zero vector is 0, not NaN', () => {
  const empty = new Map();
  assert.equal(cosine(empty, empty), 0);
});

test('correlation: identical return series → +1; needs minimum overlap', () => {
  const a = new Map();
  const b = new Map();
  const c = new Map();
  for (let i = 0; i < 80; i++) {
    const d = `2026-01-${String(i).padStart(2, '0')}`;
    const r = Math.sin(i); // arbitrary but deterministic
    a.set(d, r);
    b.set(d, r);        // identical → corr +1
    c.set(d, -r);       // inverted → corr -1
  }
  assert.ok(Math.abs(correlation(a, b, 60) - 1) < 1e-9, 'identical series correlate at +1');
  assert.ok(Math.abs(correlation(a, c, 60) + 1) < 1e-9, 'inverted series correlate at -1');
  assert.equal(correlation(a, b, 200), null, 'too little overlap → null');
});
