-- 0015_source_ingest_from.sql
-- Forward-only ingestion (additive, apply-once). A source only ingests items published at/after its
-- ingest_from anchor — stamped when the source is ToS-checked/started, so a new source never pulls
-- its entire back-catalogue (esp. podcasts → no Deepgram on the archive). NULL = unbounded (legacy
-- rows; they're paused/ToS-unchecked until started, at which point this is stamped). An opt-in
-- Backfill moves this back a bounded window (30/90/365d) when historical track record is wanted.
ALTER TABLE sources ADD COLUMN ingest_from TEXT; -- ISO; only ingest items with publish date >= this. NULL = unbounded
