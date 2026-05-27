-- CO-025: Remove chain_commit_events table (Pattern B removal)
-- This table was write-only; no application code reads from it.
DROP TABLE IF EXISTS chain_commit_events;

UPDATE watcher_state
SET watcher_name = 'chain_watcher'
WHERE watcher_name = 'chain_commit_events';
