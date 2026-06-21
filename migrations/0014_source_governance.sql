-- 0014_source_governance.sql
-- Source governance, slices 1+2 (additive, apply-once). Makes the ToS sign-off load-bearing and
-- gives each source data-driven health so keep/retire is evidence-based. No behaviour change to
-- existing rows beyond the new poller ToS gate (see app code) — all columns default to safe values.

-- Slice 1 — ToS gate: record WHO/WHEN/WHY a source passed its terms-of-service check. The poller
-- now requires tos_checked=1 (set via /admin/set-tos), so an unvetted feed is never polled.
ALTER TABLE sources ADD COLUMN tos_checked_at TEXT;   -- ISO when the ToS check was recorded
ALTER TABLE sources ADD COLUMN tos_checked_by TEXT;   -- who signed off (admin)
ALTER TABLE sources ADD COLUMN tos_note TEXT;         -- short note / evidence of the check

-- Slice 2 — per-source health: set by the pollers so the Sources view can show dead/failing feeds.
ALTER TABLE sources ADD COLUMN last_success_at TEXT;                     -- last poll that fetched OK
ALTER TABLE sources ADD COLUMN last_error TEXT;                          -- last poll error summary
ALTER TABLE sources ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0; -- streak of failed polls
