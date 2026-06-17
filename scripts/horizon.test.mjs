// Unit goldens for horizon classification. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyHorizon, parseHorizonDays, primaryHorizon } from '../src/lib/horizon.ts';

test('parseHorizonDays handles common phrasings', () => {
  assert.equal(parseHorizonDays('3 months'), 90);
  assert.equal(parseHorizonDays('6mo'), 180);
  assert.equal(parseHorizonDays('2 weeks'), 14);
  assert.equal(parseHorizonDays('5 years'), 1825);
  assert.equal(parseHorizonDays('intraday'), 1);
  assert.equal(parseHorizonDays('a quarter'), 90);
  assert.equal(parseHorizonDays(null), null);
  assert.equal(parseHorizonDays('whenever'), null);
});

test('classifyHorizon prefers an explicit hint', () => {
  assert.equal(classifyHorizon('3 months', 'buy_hold').tip_type, 'buy_hold');
});

test('classifyHorizon derives a bucket from the numeric target', () => {
  assert.equal(classifyHorizon('1 week').tip_type, 'short');
  assert.equal(classifyHorizon('3 months').tip_type, 'swing');
  assert.equal(classifyHorizon('5 years').tip_type, 'buy_hold');
});

test('classifyHorizon falls back to keywords', () => {
  assert.equal(classifyHorizon('long-term hold').tip_type, 'buy_hold');
  assert.equal(classifyHorizon('day trade this').tip_type, 'short');
  assert.equal(classifyHorizon('swing trade').tip_type, 'swing');
  assert.equal(classifyHorizon('no idea stated').tip_type, null);
});

test('primaryHorizon maps buckets and snaps targets to {30,90,365}', () => {
  assert.equal(primaryHorizon('short', null), 30);
  assert.equal(primaryHorizon('swing', null), 90);
  assert.equal(primaryHorizon('buy_hold', null), 365);
  assert.equal(primaryHorizon(null, null), 90); // unknown → default
  assert.equal(primaryHorizon(null, 300), 365); // 300d nearer 365 than 90
  assert.equal(primaryHorizon(null, 45), 30); // 45d nearer 30 than 90
});
