-- 0016_tip_mention_seconds.sql
-- Provenance Tier 2 (additive, apply-once): record WHERE in a podcast a call was made, so the
-- newsletter can deep-link "at mm:ss". Set by the extractor from [mm:ss] transcript markers
-- (Deepgram utterances) for NEW podcast episodes; NULL for text sources and pre-existing tips.
ALTER TABLE tips ADD COLUMN mention_seconds INTEGER; -- offset in seconds; NULL = unknown / not a podcast
