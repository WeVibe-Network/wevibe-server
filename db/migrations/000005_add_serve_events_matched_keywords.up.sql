-- CO-033a: persist matched keyword intersection per serve event.
-- Column is NOT NULL, no DEFAULT — every serve_events INSERT (both serve
-- and denial event types) must supply matched_keywords explicitly. RecordServe
-- validates non-empty input from POST /v1/serves (chain x/serve enforces the
-- same constraint per CO-031 Rev 2). RecordDenial supplies an empty TEXT[]
-- because denial matched_keywords is out of CO-033a scope (DenialEntry proto
-- has no matched_keywords field at chain commit 533d18b).
--
-- Pre-MVP wipe required per D-13.9 if serve_events already contains rows —
-- this migration cannot backfill (no default). Dogfood resets state via
-- `docker compose down -v` in wevibe-meta/Makefile dogfood target.
ALTER TABLE serve_events
ADD COLUMN matched_keywords TEXT[] NOT NULL;
