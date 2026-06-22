-- migrations/0017_similar.sql  (additive — fundamentals columns + precomputed peer table)
-- For the "Find Similar Shares" feature. sector column already exists (0001); add the rest.

ALTER TABLE securities ADD COLUMN industry TEXT;
ALTER TABLE securities ADD COLUMN market_cap REAL;
ALTER TABLE securities ADD COLUMN pe REAL;
ALTER TABLE securities ADD COLUMN pb REAL;
ALTER TABLE securities ADD COLUMN ps REAL;
ALTER TABLE securities ADD COLUMN profit_margin REAL;
ALTER TABLE securities ADD COLUMN roe REAL;
ALTER TABLE securities ADD COLUMN rev_growth REAL;
ALTER TABLE securities ADD COLUMN debt_equity REAL;
ALTER TABLE securities ADD COLUMN beta REAL;
ALTER TABLE securities ADD COLUMN description TEXT;
ALTER TABLE securities ADD COLUMN fundamentals_at TEXT; -- when fundamentals were last fetched (NULL = never)

-- Precomputed peers: one row per (security, method, peer). Rebuilt by the weekly Cron.
CREATE TABLE IF NOT EXISTS similar_securities (
  security_id TEXT NOT NULL REFERENCES securities(id),
  peer_id     TEXT NOT NULL REFERENCES securities(id),
  method      TEXT NOT NULL,           -- 'fundamental' | 'correlation' | 'blended'
  score       REAL NOT NULL,           -- similarity (higher = more similar), 0..1
  rank        INTEGER NOT NULL,        -- 1..N within (security, method)
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (security_id, method, peer_id)
);
CREATE INDEX IF NOT EXISTS idx_similar_lookup ON similar_securities(security_id, method, rank);
