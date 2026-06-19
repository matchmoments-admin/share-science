-- 0013_digest_send_state.sql
-- Phase 1 (newsletter observability): record when an issue was actually SENT, distinct from
-- when its beehiiv draft was created. Until Phase 2 wires send-state, this stays NULL and the
-- status column ('drafted' | 'failed') is unchanged; a future 'sent' status + sent_at close the
-- loop. Additive + apply-once (CLAUDE.md invariant).
ALTER TABLE digest_publications ADD COLUMN sent_at TEXT; -- ISO-8601 when the issue was sent (NULL until sent)
