// Unit goldens for the trade-cap money guard. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { tradeCaps, capDecision } from '../src/lib/tradecaps.ts';

test('tradeCaps fail closed — misconfig (0/blank) falls back to code defaults, never unlimited', () => {
  assert.deepEqual(tradeCaps({}), { maxDailyTrades: 5, maxOpenNotionalCents: 20000 });
  assert.deepEqual(tradeCaps({ MAX_DAILY_TRADES: '0', MAX_OPEN_REAL_NOTIONAL_CENTS: '0' }), { maxDailyTrades: 5, maxOpenNotionalCents: 20000 });
  assert.deepEqual(tradeCaps({ MAX_DAILY_TRADES: '3', MAX_OPEN_REAL_NOTIONAL_CENTS: '10000' }), { maxDailyTrades: 3, maxOpenNotionalCents: 10000 });
});

test('capDecision blocks on the daily order count', () => {
  const caps = { maxDailyTrades: 2, maxOpenNotionalCents: 100000 };
  assert.equal(capDecision(0, 0, 500, caps), 'ok');
  assert.equal(capDecision(2, 0, 500, caps), 'daily_count_cap'); // already at the cap
});

test('capDecision blocks when an order would exceed open notional', () => {
  const caps = { maxDailyTrades: 99, maxOpenNotionalCents: 1000 }; // $10 open cap
  assert.equal(capDecision(0, 600, 400, caps), 'ok');            // 600+400 = 1000, == cap, allowed
  assert.equal(capDecision(0, 600, 500, caps), 'open_notional_cap'); // 1100 > 1000
});
