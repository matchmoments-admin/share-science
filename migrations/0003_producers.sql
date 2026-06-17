-- migrations/0003_producers.sql  (additive — automated ingestion + multi-analyst capture)
-- Apply after 0002. Safe to re-run (ADD COLUMN guarded by try; seeds INSERT OR IGNORE).

-- Capture the analyst/author per tip (show-level attribution for v1; per-speaker leaderboards later).
ALTER TABLE tips ADD COLUMN speaker TEXT;

-- Source registry: how to automatically pull each source.
ALTER TABLE sources ADD COLUMN feed_url TEXT;            -- RSS for blogs/Substacks/podcasts
ALTER TABLE sources ADD COLUMN bluesky_did TEXT;         -- did:plc:... for Bluesky
ALTER TABLE sources ADD COLUMN youtube_channel_id TEXT;  -- UC... (deferred)
ALTER TABLE sources ADD COLUMN subreddit TEXT;           -- r/... (manual for now)
ALTER TABLE sources ADD COLUMN locale TEXT;              -- AU|US|UK|CA
ALTER TABLE sources ADD COLUMN ingest_method TEXT NOT NULL DEFAULT 'manual'; -- rss_fulltext|podcast_transcript|bluesky|manual
ALTER TABLE sources ADD COLUMN tos_checked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sources ADD COLUMN last_cursor TEXT;         -- poll cursor / last-seen marker

CREATE INDEX IF NOT EXISTS idx_sources_active_method ON sources(active, ingest_method);

-- Seed starter producer sources (from the research). feed_url/DIDs are best-effort — verify before relying.
INSERT OR IGNORE INTO sources (id, name, medium, handle, home_url, created_at, feed_url, bluesky_did, locale, ingest_method, tos_checked, active) VALUES
  ('gsdd','Growth Stock Deep Dives (Jonah Lupton)','blog','growthstockdeepdives','https://growthstockdeepdives.substack.com','2026-06-17T00:00:00Z','https://growthstockdeepdives.substack.com/feed',NULL,'US','rss_fulltext',0,1),
  ('tsoh','TSOH Investment Research (Alex Morris)','blog','thescienceofhitting','https://www.thescienceofhitting.com','2026-06-17T00:00:00Z','https://www.thescienceofhitting.com/feed',NULL,'US','rss_fulltext',0,1),
  ('arichlife','A Rich Life (Claude Walker)','blog','arichlife','https://www.arichlife.com.au','2026-06-17T00:00:00Z','https://www.arichlife.com.au/feed',NULL,'AU','rss_fulltext',0,1),
  ('unusualwhales','Unusual Whales','bluesky','unusualwhales.bsky.social','https://bsky.app/profile/unusualwhales.bsky.social','2026-06-17T00:00:00Z',NULL,'did:plc:7l75ck5g4b5k6gxqaq5rejit','US','bluesky',0,1),
  ('thecall','The Call from ausbiz','podcast','the-call','https://shows.acast.com/the-call','2026-06-17T00:00:00Z','https://feeds.acast.com/public/shows/the-call',NULL,'AU','podcast_transcript',0,1);
