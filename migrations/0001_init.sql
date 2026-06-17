-- migrations/0001_init.sql  (Cloudflare D1 / SQLite — additive + idempotent)
-- The ONE canonical ledger. Every published number ties back to a row here.
-- Apply: npm run migrate:remote   (or :local)

-- ── Canonical spine: the SHARE/security ──────────────────────────────
CREATE TABLE IF NOT EXISTS securities (
  id          TEXT PRIMARY KEY,              -- canonical id, e.g. 'AAPL.US'
  ticker      TEXT NOT NULL,                 -- exchange-local ticker
  exchange    TEXT NOT NULL,                 -- 'XNAS','XASX','XLON'
  isin        TEXT,                          -- encodes domicile
  figi        TEXT,
  name        TEXT NOT NULL,
  sec_type    TEXT NOT NULL DEFAULT 'share', -- share|etf|adr|trust
  domicile    TEXT,                          -- 'US','AU','IE'
  currency    TEXT,                          -- 'USD','AUD'
  sector      TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,    -- keep delisted (=0) — no survivorship bias
  created_at  TEXT NOT NULL,
  UNIQUE(exchange, ticker)
);
CREATE INDEX IF NOT EXISTS idx_securities_isin ON securities(isin);

-- alias table for entity resolution (LLM proposes → master confirms; never the reverse)
CREATE TABLE IF NOT EXISTS security_aliases (
  alias       TEXT NOT NULL,                 -- 'vanguard s&p 500','triple q'
  security_id TEXT NOT NULL REFERENCES securities(id),
  kind        TEXT NOT NULL DEFAULT 'name',  -- name|cashtag|phonetic
  PRIMARY KEY (alias, security_id)
);

-- ── Sources: tipsters / channels / authors ───────────────────────────
CREATE TABLE IF NOT EXISTS sources (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  medium      TEXT NOT NULL,                 -- podcast|x|bluesky|blog|web|youtube
  handle      TEXT,
  home_url    TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE(medium, handle)
);

-- ── Ingest items: raw captured artefacts + the dedup boundary ────────
-- Producers INSERT OR IGNORE here (content_hash UNIQUE) BEFORE enqueue. `detected_at`
-- is stamped ONCE here and copied (never recomputed) onto tips — the look-ahead-bias anchor.
CREATE TABLE IF NOT EXISTS ingest_items (
  id           TEXT PRIMARY KEY,
  source_id    TEXT NOT NULL REFERENCES sources(id),
  source_type  TEXT NOT NULL,               -- podcast|x|bluesky|blog|web|youtube|human
  external_id  TEXT,                         -- platform id / episode+offset
  content_hash TEXT NOT NULL UNIQUE,         -- sha256(normalised text) — dedup
  raw_text     TEXT,
  url          TEXT,                         -- deep link w/ timestamp where available
  raw_ref      TEXT,                         -- R2 key for audio/transcript evidence
  detected_at  TEXT NOT NULL,               -- immutable UTC of first capture
  ingested_at  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'new'   -- new|extracted|review|dropped
);

-- ── TIP: the core event — links a SHARE to a SOURCE ──────────────────
CREATE TABLE IF NOT EXISTS tips (
  id              TEXT PRIMARY KEY,
  security_id     TEXT REFERENCES securities(id),  -- NULL => abstained; never auto-trades
  source_id       TEXT NOT NULL REFERENCES sources(id),
  ingest_item_id  TEXT REFERENCES ingest_items(id),
  direction       TEXT NOT NULL,             -- buy|bullish|sell|bearish|hold
  conviction      TEXT,                       -- low|medium|high
  horizon         TEXT,                       -- 'short','12m'
  rationale       TEXT,
  evidence_span   TEXT,                       -- verbatim quote (provenance)
  confidence      REAL,                       -- extraction confidence 0..1
  extractor       TEXT,                       -- model/version (provenance)
  detected_at     TEXT NOT NULL,             -- COPIED from ingest_items; drives entry timing
  status          TEXT NOT NULL DEFAULT 'new',-- new|resolved|tracking|closed|abstained|review
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tips_security ON tips(security_id);
CREATE INDEX IF NOT EXISTS idx_tips_source   ON tips(source_id);
-- collapse the same tip re-clipped across sources/episodes:
CREATE UNIQUE INDEX IF NOT EXISTS uq_tip_dedup ON tips(security_id, direction, evidence_span);

-- ── Validations: corroborating mentions (distinct speaker = real) ─────
CREATE TABLE IF NOT EXISTS validations (
  id              TEXT PRIMARY KEY,
  tip_id          TEXT NOT NULL REFERENCES tips(id),
  source_id       TEXT NOT NULL REFERENCES sources(id),  -- must differ from the tip's source
  ingest_item_id  TEXT REFERENCES ingest_items(id),
  similarity      REAL,                       -- match score
  detected_at     TEXT NOT NULL,
  UNIQUE(tip_id, source_id)                  -- one corroboration per distinct source
);

-- ── Benchmarks (one per market) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS benchmarks (
  id          TEXT PRIMARY KEY,              -- 'US','AU'
  name        TEXT NOT NULL,
  security_id TEXT REFERENCES securities(id) -- e.g. SPY.US, A200.AX
);

-- ── Positions: the OUTCOME test of a tip ─────────────────────────────
-- One position PER TIP (UNIQUE tip_id) — multiple sources tipping the same security each
-- get their own tracked position; that per-source attribution IS the product.
CREATE TABLE IF NOT EXISTS positions (
  id                TEXT PRIMARY KEY,
  tip_id            TEXT NOT NULL REFERENCES tips(id),
  security_id       TEXT NOT NULL REFERENCES securities(id),
  mode              TEXT NOT NULL,           -- real|paper
  broker            TEXT,                    -- 'alpaca' | NULL for paper
  benchmark_id      TEXT REFERENCES benchmarks(id),
  entry_rule        TEXT NOT NULL DEFAULT 'next_open_after_detection',
  entry_at          TEXT NOT NULL,           -- the bar used
  entry_price_raw   REAL NOT NULL,           -- frozen unadjusted (evidence)
  entry_price_adj   REAL NOT NULL,           -- adjusted (return math)
  quantity          REAL NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open',  -- open|closed
  exit_at           TEXT,
  exit_price_adj    REAL,
  return_pct        REAL,
  bench_return_pct  REAL,
  excess_return_pct REAL,                    -- alpha = the credibility metric
  eval_horizon_days INTEGER,
  is_hit            INTEGER,                 -- direction-aware (NULL until evaluated)
  last_valued_at    TEXT,
  idempotency_key   TEXT NOT NULL UNIQUE,    -- claim-before-submit / at-least-once safe
  created_at        TEXT NOT NULL,
  UNIQUE(tip_id)
);
CREATE INDEX IF NOT EXISTS idx_positions_open ON positions(status);

-- standard-horizon return snapshots per tip (30/90/365d), from valuations
CREATE TABLE IF NOT EXISTS tip_returns (
  tip_id        TEXT NOT NULL REFERENCES tips(id),
  horizon_days  INTEGER NOT NULL,            -- 30|90|365
  return_pct    REAL,
  excess_pct    REAL,
  is_hit        INTEGER,                     -- direction-aware at this horizon
  as_of         TEXT NOT NULL,
  PRIMARY KEY (tip_id, horizon_days)
);

-- ── Valuation history (Cron writes; powers track record) ─────────────
CREATE TABLE IF NOT EXISTS valuations (
  position_id TEXT NOT NULL REFERENCES positions(id),
  as_of       TEXT NOT NULL,
  price_adj   REAL NOT NULL,
  return_pct  REAL,
  excess_pct  REAL,
  PRIMARY KEY (position_id, as_of)
);

-- ── Corporate actions (integrity; from EODHD feed) ───────────────────
CREATE TABLE IF NOT EXISTS corporate_actions (
  security_id TEXT NOT NULL REFERENCES securities(id),
  type        TEXT NOT NULL,                 -- split|dividend|bonus|delist
  ex_date     TEXT NOT NULL,
  ratio       REAL,
  amount      REAL,
  PRIMARY KEY (security_id, type, ex_date)
);

-- ── Source ratings (derived leaderboard — confidence-aware) ──────────
-- Full recompute by Cron (TRUNCATE+INSERT). Rank by score_lower (CI lower bound).
CREATE TABLE IF NOT EXISTS source_ratings (
  source_id         TEXT NOT NULL REFERENCES sources(id),
  dimension         TEXT NOT NULL,           -- 'overall' | 'horizon:90' (v1: overall + by-horizon)
  n_tips            INTEGER NOT NULL,
  n_hits            INTEGER NOT NULL,
  hit_rate          REAL,
  avg_excess_pct    REAL,                    -- mean alpha
  median_excess_pct REAL,
  stdev_excess_pct  REAL,
  rating_score      REAL,                    -- 0..100, confidence-adjusted (shrinks when n small)
  score_lower       REAL,                    -- lower CI bound — the published/ranked number
  score_upper       REAL,
  tier              TEXT NOT NULL,           -- 'provisional' | 'established'
  rank              INTEGER,
  best_tip_id       TEXT REFERENCES tips(id),
  worst_tip_id      TEXT REFERENCES tips(id),
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (source_id, dimension)
);
CREATE INDEX IF NOT EXISTS idx_ratings_rank ON source_ratings(dimension, rank);

-- ── Ops/compliance events (one table; folds compliance as a kind) ────
CREATE TABLE IF NOT EXISTS ops_events (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,                  -- cron|extract|trade|publish|compliance|error
  detail     TEXT,                           -- JSON
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ops_kind ON ops_events(kind, created_at);
