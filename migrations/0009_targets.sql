-- 0009_targets.sql — stated price targets + time-to-target tracking.
-- target_price_raw is the target as stated by the source (raw price → INTERNAL ONLY, never published).
-- target_hit_at / days_to_target record when (and how fast) the price first crossed it. Additive.

ALTER TABLE tips ADD COLUMN target_price_raw REAL;  -- target as stated (raw price; internal only)
ALTER TABLE tips ADD COLUMN target_currency TEXT;   -- currency of the target, if stated

ALTER TABLE positions ADD COLUMN target_hit_at TEXT;     -- first date the price crossed the target (NULL = not yet)
ALTER TABLE positions ADD COLUMN days_to_target INTEGER; -- calendar days from entry to first cross
