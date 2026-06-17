-- migrations/0006_subscribers.sql  (additive — newsletter signups from the landing page)
-- Stores email signups captured by the public landing page (/) hero + footer forms.
-- Email is normalised (trim + lowercase) before insert; UNIQUE makes re-signup idempotent
-- (INSERT OR IGNORE). No PII beyond the email itself; status lets us soft-unsubscribe later.
CREATE TABLE IF NOT EXISTS subscribers (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  source     TEXT,                            -- 'hero' | 'footer' (which form captured it)
  status     TEXT NOT NULL DEFAULT 'active',  -- active | unsubscribed
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_subscribers_email ON subscribers(email);
CREATE INDEX IF NOT EXISTS idx_subscribers_created ON subscribers(created_at);
