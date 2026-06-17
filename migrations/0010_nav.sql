-- 0010_nav.sql — first-class cumulative portfolio NAV ("$1,000 invested") equity curve.
-- One row per (scope, day). nav_index is an INDEX normalised to a 1000 base — NOT a price, so it
-- is safe to publish while PUBLIC_PRICES=off. scope is extensible ('all' today; 'source:<id>' later).
-- Additive + idempotent (CREATE IF NOT EXISTS); continues the 000N_ sequence.

CREATE TABLE IF NOT EXISTS portfolio_nav (
  scope       TEXT NOT NULL,             -- 'all' | 'source:<id>' | 'horizon:<n>' (extensible)
  as_of       TEXT NOT NULL,             -- YYYY-MM-DD (one row per day per scope)
  nav_index   REAL NOT NULL,             -- $1,000 base × (1 + equal-weighted mean return); an index, not a price
  return_pct  REAL,                      -- equal-weighted mean return across constituents that day
  n_positions INTEGER NOT NULL,          -- constituents contributing to the snapshot
  created_at  TEXT NOT NULL,
  PRIMARY KEY (scope, as_of)
);
