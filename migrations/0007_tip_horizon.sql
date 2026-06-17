-- 0007_tip_horizon.sql — classify each tip's stated horizon so it can be scored on its OWN window.
-- tip_type buckets the call (short / swing / buy_hold); horizon_days_target is the parsed numeric
-- horizon when stated. Both nullable (NULL = unknown → treated as the 90-day default downstream).
-- Additive; continues the 000N_ sequence.

ALTER TABLE tips ADD COLUMN tip_type TEXT;             -- 'short' | 'swing' | 'buy_hold' | NULL(unknown)
ALTER TABLE tips ADD COLUMN horizon_days_target INTEGER; -- parsed numeric horizon in days, NULL if unstated
CREATE INDEX IF NOT EXISTS idx_tips_tip_type ON tips(tip_type);
