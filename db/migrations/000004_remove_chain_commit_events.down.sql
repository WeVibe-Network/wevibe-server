-- Recreate chain_commit_events for rollback (data is not recoverable)
CREATE TABLE chain_commit_events (
    id                          BIGSERIAL   PRIMARY KEY,
    tx_hash                     TEXT        NOT NULL,
    block_height                BIGINT      NOT NULL,
    block_timestamp             TIMESTAMPTZ NOT NULL,
    action_type                 TEXT        NOT NULL CHECK (action_type IN ('memory_approved', 'report_upheld')),
    org_id                      TEXT        NOT NULL,
    memory_hash                 BYTEA       NOT NULL,
    contributor_pubkey          TEXT        NOT NULL,
    approving_moderators        TEXT[]      NOT NULL DEFAULT '{}',
    upholding_moderators        TEXT[]      NOT NULL DEFAULT '{}',
    committing_leader_pubkey    TEXT        NOT NULL,
    reporter_pubkey             TEXT,
    raw_msg_json                JSONB       NOT NULL,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_tx_memory UNIQUE (tx_hash, memory_hash)
);

CREATE INDEX idx_chain_commit_events_tx_hash ON chain_commit_events(tx_hash);
CREATE INDEX idx_chain_commit_events_org ON chain_commit_events(org_id);
CREATE INDEX idx_chain_commit_events_moderators ON chain_commit_events USING GIN(approving_moderators);
CREATE INDEX idx_chain_commit_events_leader ON chain_commit_events(committing_leader_pubkey);
CREATE INDEX idx_chain_commit_events_action ON chain_commit_events(action_type, created_at DESC);

UPDATE watcher_state
SET watcher_name = 'chain_commit_events'
WHERE watcher_name = 'chain_watcher';
