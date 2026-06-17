// Unit goldens for the ratings statistics. Run: npm test
// Uses Node's built-in test runner with type-stripping to import the .ts module.
import test from 'node:test';
import assert from 'node:assert/strict';
import { wilson, median, mean, convictionWeight, weightedMean } from '../src/lib/stats.ts';

test('Buffett property: an established record outranks a perfect small sample', () => {
  const streak = wilson(5, 5).lower; // 5/5 lucky streak
  const established = wilson(100, 130).lower; // 77% over 130 calls
  assert.ok(established > streak, `established (${established.toFixed(3)}) must beat streak (${streak.toFixed(3)})`);
  assert.ok(streak < 0.6, `5/5 lower bound should be modest, got ${streak.toFixed(3)}`);
});

test('wilson shrinks toward 0 as n shrinks at the same hit rate', () => {
  const big = wilson(80, 100).lower; // 80% over 100
  const small = wilson(8, 10).lower; // 80% over 10
  assert.ok(big > small, `more evidence at same rate → higher lower bound (${big.toFixed(3)} vs ${small.toFixed(3)})`);
});

test('wilson handles n=0', () => {
  assert.deepEqual(wilson(0, 0), { point: 0, lower: 0, upper: 0 });
});

test('median + mean', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(mean([1, 2, 3, 4]), 2.5);
});

test('convictionWeight maps low/med/high → 1/2/3, unknown → 1', () => {
  assert.equal(convictionWeight('high'), 3);
  assert.equal(convictionWeight('medium'), 2);
  assert.equal(convictionWeight('low'), 1);
  assert.equal(convictionWeight(null), 1);
});

test('weightedMean weights high-conviction calls more', () => {
  // a winning high-conviction call (+10%, w3) vs a losing low call (-10%, w1) → net positive
  assert.equal(weightedMean([0.1, -0.1], [3, 1]), (0.1 * 3 - 0.1 * 1) / 4);
  assert.equal(weightedMean([], []), 0);
});
