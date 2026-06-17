-- migrations/0005_ingest_dedup.sql  (additive — episode-level dedup guard)
-- Prevents duplicate ingest_items rows for the same external item (podcast episode guid, etc.).
-- Partial index: only enforced when external_id is set (human/blog items leave it null).
CREATE UNIQUE INDEX IF NOT EXISTS uq_ingest_external
  ON ingest_items(source_id, external_id) WHERE external_id IS NOT NULL;
