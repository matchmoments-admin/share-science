-- 0011_beehiiv.sql — wire newsletter delivery: track which signups have synced to beehiiv and
-- which weekly digests have been pushed as a beehiiv draft. Additive + idempotent.

ALTER TABLE subscribers ADD COLUMN beehiiv_synced_at TEXT; -- set once the email is pushed to beehiiv

CREATE TABLE IF NOT EXISTS digest_publications (
  week            TEXT PRIMARY KEY,   -- 'YYYY-Www' — one publish attempt of record per week (idempotency key)
  beehiiv_post_id TEXT,               -- beehiiv post id when the draft was created
  status          TEXT NOT NULL,      -- 'drafted' | 'failed'
  detail          TEXT,               -- error/context
  created_at      TEXT NOT NULL
);
