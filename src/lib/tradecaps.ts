/**
 * Pure money-guard logic for the real-trade path — no I/O, no relative imports, so it's unit-testable
 * the same way as stats/horizon. Caps are code-defaulted + fail-closed: a missing/zero/blank config
 * value falls back to a conservative non-zero default — a misconfiguration can never mean "unlimited".
 */
import type { Env } from '../types.js';

export interface TradeCaps {
  maxDailyTrades: number;
  maxOpenNotionalCents: number;
}

export function tradeCaps(env: Env): TradeCaps {
  return {
    maxDailyTrades: Math.max(1, Number(env.MAX_DAILY_TRADES) || 5),
    maxOpenNotionalCents: Math.max(100, Number(env.MAX_OPEN_REAL_NOTIONAL_CENTS) || 20000), // $200 default
  };
}

/** Decision for one intent given the run's running tallies. */
export function capDecision(execCount: number, openCents: number, intentCents: number, caps: TradeCaps): 'ok' | 'daily_count_cap' | 'open_notional_cap' {
  if (execCount >= caps.maxDailyTrades) return 'daily_count_cap';
  if (openCents + intentCents > caps.maxOpenNotionalCents) return 'open_notional_cap';
  return 'ok';
}
