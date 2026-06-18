-- 0012_trade_approvals.sql — human-in-the-loop gate for REAL (live) Alpaca orders.
-- A resolved+eligible tip no longer auto-executes: it becomes a trade_intent that must be
-- 'approved' (by an operator in live mode; auto-approved in paper) before the single submitBuy
-- caller (executeApprovedTrades) will place the order. Additive; continues the 000N_ sequence.

CREATE TABLE IF NOT EXISTS trade_intents (
  id              TEXT PRIMARY KEY,
  tip_id          TEXT NOT NULL,
  security_id     TEXT NOT NULL,
  ticker          TEXT NOT NULL,
  notional_cents  INTEGER NOT NULL,          -- clamped $ size at propose time (×100)
  mode            TEXT NOT NULL,             -- alpacaMode at propose time: paper | live
  status          TEXT NOT NULL DEFAULT 'proposed', -- proposed|approved|executing|executed|rejected|failed
  reason          TEXT,                      -- failure / skip reason
  broker_order_id TEXT,
  approved_at     TEXT,
  executed_at     TEXT,
  created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_trade_intent_tip ON trade_intents(tip_id);
CREATE INDEX IF NOT EXISTS idx_trade_intent_status ON trade_intents(status);
-- Supports the per-run live-exposure tally (status + mode + executed_at) at scale. Retention/prune
-- of old executed/rejected rows lands with the Ops slice; growth is one row per resolved-eligible tip.
CREATE INDEX IF NOT EXISTS idx_trade_intent_status_mode ON trade_intents(status, mode);

ALTER TABLE positions ADD COLUMN real_buy_status TEXT; -- placed | failed | NULL (paper-only)
ALTER TABLE tips ADD COLUMN resolve_reason TEXT;       -- why resolve.ts matched/abstained (audit + review queue)
