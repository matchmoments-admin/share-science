-- migrations/0018_classification.sql  (additive — LLM-generated business taxonomy for similarity Phase 2)
-- One row per security: industry/sub-industry + business tags, produced ONCE by classify.ts (Claude).
-- "Dark until rows exist" is the gate — no classification rows ⇒ the classification signal is absent and
-- the similar-shares output is byte-identical to the correlation-only state.

CREATE TABLE IF NOT EXISTS security_classification (
  security_id   TEXT PRIMARY KEY REFERENCES securities(id),
  sector        TEXT,           -- e.g. 'Technology'
  industry      TEXT,           -- e.g. 'Semiconductors'
  sub_industry  TEXT,           -- e.g. 'Memory & Storage'
  business_tags TEXT,           -- JSON array of lowercase keyword strings, e.g. ["memory","dram","nand","chips"]
  model         TEXT,           -- model id that produced this (provenance)
  classified_at TEXT NOT NULL   -- when classified (presence = done; re-run skips existing)
);
