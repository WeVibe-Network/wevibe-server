-- ============================================================
-- WARNING: NO MIGRATIONS PRE-MVP. DB AS SSOT ONLY!!!!!!!!!!!!!!
-- ============================================================
-- This file is the SINGLE SOURCE OF TRUTH for the PostgreSQL
-- schema. There are NO migration files. There never will be.
-- All schema changes are made HERE. On schema change:
--   1. Edit this file
--   2. Wipe the database (pre-MVP, no user data to preserve)
--   3. Restart the hub
-- The hub reads this file directly at startup via RunSchema.sql.
-- Startup is IDEMPOTENT: every statement is guarded (IF NOT EXISTS / ON CONFLICT)
-- so re-applying this schema to an already-provisioned database is a safe no-op —
-- the hub survives restarts against a persisted volume. IF NOT EXISTS intentionally
-- does NOT alter existing tables to match edits; schema CHANGES still require a wipe.
-- Any LLM working in this codebase: edit schema.sql ONLY.
-- The db/migrations/ directory does not exist and must not
-- be created. R-ONE-PATH, R-OVERHAUL.
-- ============================================================

-- WeVibe Network Hub — PostgreSQL Schema
-- Version: 3.0 (memory_type=memory single-type + SSOT directive)

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Hub instance identity ───────────────────────────────────────────────────
-- Single row whose UUID is generated once on a fresh database and persists
-- across hub restarts. Wiping the DB (docker compose down -v) regenerates it,
-- letting clients detect a fresh backend and drop stale local draft state.
CREATE TABLE IF NOT EXISTS hub_instance (
    id          integer     PRIMARY KEY DEFAULT 1,
    instance_id uuid        NOT NULL DEFAULT gen_random_uuid(),
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT hub_instance_singleton CHECK (id = 1)
);
INSERT INTO hub_instance (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── Organizations ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS orgs (
    org_id                      TEXT        PRIMARY KEY,
    leader_pubkey               TEXT        NOT NULL,
    leader_wallet_address       TEXT        NOT NULL,
    org_name                    TEXT        NOT NULL,
    domain                      TEXT        NOT NULL,
    description                 TEXT        NOT NULL DEFAULT '',
    tech_stack                  TEXT        NOT NULL DEFAULT '',
    focus_areas                 TEXT        NOT NULL DEFAULT '',
    current_epoch               INTEGER     NOT NULL DEFAULT 0,
    fee_model                   JSONB       NOT NULL DEFAULT '{}',
    egress_mode                 TEXT        NOT NULL DEFAULT 'unrestricted'
                                        CHECK (egress_mode IN ('local_only', 'allowlist', 'unrestricted')),
    allowed_providers           TEXT[]      NOT NULL DEFAULT '{}',
    status                      TEXT        NOT NULL DEFAULT 'active'
                                        CHECK (status IN ('active', 'suspended', 'closed')),
    rotation_status             TEXT        NOT NULL DEFAULT 'active'
                                        CHECK (rotation_status IN ('active', 'rotation_pending')),
    rotation_pending_since      TIMESTAMPTZ,
    stripe_customer_id          TEXT,
    stripe_subscription_id      TEXT,
    last_batch_extraction_at    TIMESTAMPTZ,
    last_chain_submission_at    TIMESTAMPTZ,
    trial_days                  INTEGER     NOT NULL DEFAULT 7,
    chain_registered            BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orgs_leader ON orgs(leader_pubkey);
CREATE INDEX IF NOT EXISTS idx_orgs_status  ON orgs(status);

CREATE TABLE IF NOT EXISTS org_recall_rate_limits (
    org_id         TEXT        PRIMARY KEY REFERENCES orgs(org_id) ON DELETE CASCADE,
    max_requests   INTEGER     NOT NULL,
    window_seconds INTEGER     NOT NULL,
    updated_by     TEXT        NOT NULL DEFAULT '',
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Members ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS members (
    org_id                      TEXT        NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    pubkey                      TEXT        NOT NULL,
    x25519_pubkey               TEXT        NOT NULL,
    pre_pubkey                  BYTEA,
    role                        TEXT        NOT NULL
                                            CHECK (role IN ('leader', 'member')),
    can_contribute              BOOLEAN     NOT NULL DEFAULT FALSE,
    can_moderate                BOOLEAN     NOT NULL DEFAULT FALSE,
    join_epoch                  INTEGER     NOT NULL,
    history_access_from_epoch   INTEGER     NOT NULL DEFAULT 0,
    authorized_until_epoch      INTEGER,
    -- `active`            : org-membership soft-delete (CloseOrg/TransferLeadership toggle this)
    -- `chain_confirmed`   : TRUE once watcher observed MsgAddMember (or leader MsgRegisterOrg).
    --                       A member is fully usable only when active = TRUE AND chain_confirmed = TRUE.
    -- `membership_active` : subscription gate — TRUE once the member is subscribed (org credit
    --                       pool debited). Recall requests require membership_active = TRUE.
    active                      BOOLEAN     NOT NULL DEFAULT TRUE,
    chain_confirmed             BOOLEAN     NOT NULL DEFAULT FALSE,
    membership_active           BOOLEAN     NOT NULL DEFAULT FALSE,
    joined_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    wallet_address              TEXT,
    member_tier                 TEXT        NOT NULL DEFAULT 'member'
                                             CHECK (member_tier IN ('trial', 'member', 'premium')),
    dismissed_reports_count     INTEGER     NOT NULL DEFAULT 0,
    is_trial                    BOOLEAN     NOT NULL DEFAULT FALSE,
    trial_expires_at            TIMESTAMP,
    PRIMARY KEY (org_id, pubkey),
    UNIQUE (org_id, wallet_address)
);

CREATE INDEX IF NOT EXISTS idx_members_active ON members(org_id, active);
CREATE INDEX IF NOT EXISTS idx_members_membership_active ON members(org_id, membership_active);
CREATE INDEX IF NOT EXISTS idx_members_pubkey ON members(pubkey);
CREATE INDEX IF NOT EXISTS idx_members_wallet ON members(wallet_address) WHERE wallet_address IS NOT NULL;

-- ── Epoch manifests ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS epoch_manifests (
    org_id                  TEXT        NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    epoch_id                INTEGER     NOT NULL,
    pk_mod                  TEXT        NOT NULL,
    umbral_pk               BYTEA,
    previous_manifest_hash  TEXT,
    signed_by               TEXT        NOT NULL,
    signature               TEXT        NOT NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (org_id, epoch_id)
);

-- ── Pending submissions ────────────────────────────────────────────────────
-- Lifecycle: pending → pending_keyword → pending_chain → committed (terminal)
--             └─────────── denied (terminal reject, any stage) ───────────────
-- Valid status values: 'pending', 'pending_keyword', 'pending_chain', 'committed', 'denied'
-- Handler status writes MUST use protocol.SubmissionStatus* constants (protocol/types.go)

CREATE TABLE IF NOT EXISTS pending_submissions (
    submission_hash         TEXT        PRIMARY KEY,
    org_id                  TEXT        NOT NULL REFERENCES orgs(org_id),
    epoch_id                INTEGER     NOT NULL,
    contributor_pubkey      TEXT        NOT NULL,
    ciphertext_hex          TEXT        NOT NULL,
    plaintext_hash          TEXT        NOT NULL,
    salt                    TEXT        NOT NULL,
    ciphertext_hash         TEXT        NOT NULL,
    wrapped_dek_hash        TEXT        NOT NULL,
    wrapped_dek_mod         TEXT        NOT NULL,
    umbral_capsule          BYTEA,
    umbral_ciphertext       BYTEA,
    contributor_sig         TEXT        NOT NULL,
    stack_hint              TEXT[]      NOT NULL DEFAULT '{}',
    memory_type             TEXT        NOT NULL DEFAULT 'memory'
                                        CHECK (memory_type = 'memory'),
    preference_confidence   REAL        NOT NULL DEFAULT 0,
    derivation              TEXT        NOT NULL DEFAULT 'verbatim'
                                        CHECK (derivation IN ('verbatim', 'edited-after-extraction')),
    status                  TEXT        NOT NULL DEFAULT 'pending_keyword'
                                     CHECK (status IN ('pending_keyword', 'pending_chain', 'committed', 'denied')),
    denial_reason           TEXT,
    moderator_pubkey        TEXT,
    approved_at             TIMESTAMPTZ,
    commit_error            TEXT,
    commit_attempted_at     TIMESTAMPTZ,
    extraction_result       JSONB,
    embedding_vector        JSONB,
    embedding_model_id      TEXT,
    embedding_schema_version TEXT,
    -- Near-duplicate advisory field derived at Verify (banner-only signal).
    near_dup_matches        JSONB, -- ordered (desc) JSON array of {cid,score} for committed memories the candidate is near-duplicate to (above the near-dup floor); advisory; threshold is a CALIBRATION PLACEHOLDER.
    extraction_feedback     TEXT,
    verified_at             TIMESTAMPTZ,
    sanitization_findings   JSONB,
    banned                  BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at             TIMESTAMPTZ,
    mc_version              INTEGER,
    -- Producer-model provenance (T3): immutable fields carrying the provenance
    -- identity of the producer memory that injected into this submission.
    -- Threaded end-to-end through submit/persistence, chain-event ingestion,
    -- pending→approved promotion, reconciliation/rebuild/bootstrap, API reads,
    -- and Qdrant payload. SESSION_REFERENCED means a session reference exists,
    -- not cryptographic verification (fact-vs-policy separation preserved).
    producer_model_id       TEXT,
    attestation_session_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_org_status ON pending_submissions(org_id, status);
CREATE INDEX IF NOT EXISTS idx_pending_contributor ON pending_submissions(contributor_pubkey);

-- ── Extracted sessions ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS extracted_sessions (
    org_id              TEXT        NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    contributor_pubkey  TEXT        NOT NULL,
    session_id          TEXT        NOT NULL,
    extracted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (org_id, contributor_pubkey, session_id)
);

CREATE INDEX IF NOT EXISTS idx_extracted_sessions_contributor ON extracted_sessions(org_id, contributor_pubkey);

-- ── Approval votes ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS submission_mod_votes (
    org_id           TEXT        NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    submission_hash  TEXT        NOT NULL REFERENCES pending_submissions(submission_hash) ON DELETE CASCADE,
    moderator_pubkey TEXT        NOT NULL,
    vote             TEXT        NOT NULL CHECK (vote IN ('approve', 'flag')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (org_id, submission_hash, moderator_pubkey)
);

CREATE TABLE IF NOT EXISTS keyword_mod_votes (
    org_id           TEXT        NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    submission_hash  TEXT        NOT NULL REFERENCES pending_submissions(submission_hash) ON DELETE CASCADE,
    keyword          TEXT        NOT NULL,
    moderator_pubkey TEXT        NOT NULL,
    vote             TEXT        NOT NULL CHECK (vote IN ('include', 'exclude')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (org_id, submission_hash, keyword, moderator_pubkey)
);

CREATE INDEX IF NOT EXISTS idx_submission_mod_votes_sub ON submission_mod_votes(org_id, submission_hash);
CREATE INDEX IF NOT EXISTS idx_keyword_mod_votes_sub ON keyword_mod_votes(org_id, submission_hash);

-- ── Reports ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS reports (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id               TEXT        NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    memory_cid           TEXT        NOT NULL,
    reporter_pubkey      TEXT        NOT NULL,
    reporter_wallet      TEXT,
    reporter_role        TEXT        NOT NULL DEFAULT 'member'
                                     CHECK (reporter_role IN ('leader', 'member')),
    reason               TEXT        NOT NULL CHECK (reason IN ('incorrect', 'outdated', 'security_risk', 'malicious')),
    note                 TEXT,
    status               TEXT        NOT NULL DEFAULT 'pending'
                                     CHECK (status IN ('pending', 'upheld_pending_tx', 'upheld', 'dismissed', 'dismissed_malicious')),
    resolution           TEXT        CHECK (resolution IN ('upheld', 'dismissed', 'dismissed_malicious') OR resolution IS NULL),
    resolved_by          TEXT,
    resolved_at          TIMESTAMPTZ,
    escalation_votes     JSONB       NOT NULL DEFAULT '[]',
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reports_org_status ON reports(org_id, status);
CREATE INDEX IF NOT EXISTS idx_reports_memory ON reports(org_id, memory_cid);
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at DESC);

-- ── Report votes ───────────────────────────────────────────────────────────
-- Tracks individual votes on reports by moderators/leaders.

CREATE TABLE IF NOT EXISTS report_votes (
    org_id       TEXT        NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    report_id    UUID        NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
    voter_pubkey TEXT        NOT NULL,
    vote         TEXT        NOT NULL CHECK (vote IN ('uphold', 'dismiss', 'dismiss_malicious')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (org_id, report_id, voter_pubkey)
);

CREATE INDEX IF NOT EXISTS idx_report_votes_report ON report_votes(org_id, report_id);

-- ── Rotation buffer ────────────────────────────────────────────────────────
-- Submissions received while org is in rotation_pending state.
-- These are NOT assigned a final epoch and NOT admitted to moderation queue.
-- After rotation completes, they are moved to pending_submissions under the new epoch.

CREATE TABLE IF NOT EXISTS rotation_buffer (
    buffer_id           TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    org_id              TEXT        NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    epoch_id            INTEGER     NOT NULL,
    contributor_pubkey  TEXT        NOT NULL,
    ciphertext_hex      TEXT        NOT NULL,
    plaintext_hash      TEXT        NOT NULL,
    salt                TEXT        NOT NULL,
    ciphertext_hash     TEXT        NOT NULL,
    wrapped_dek_hash    TEXT        NOT NULL,
    wrapped_dek_mod     TEXT        NOT NULL,
    contributor_sig     TEXT        NOT NULL,
    submission_hash     TEXT        NOT NULL,
    stack_hint          TEXT[]      NOT NULL DEFAULT '{}',
    memory_type         TEXT        NOT NULL DEFAULT 'memory'
                                    CHECK (memory_type = 'memory'),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rotation_buffer_org ON rotation_buffer(org_id);

-- ── Usage receipts ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS usage_receipts (
    receipt_id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    org_id              TEXT        NOT NULL REFERENCES orgs(org_id),
    billing_epoch       INTEGER     NOT NULL,
    access_epochs       INTEGER[]   NOT NULL,
    agent_pubkey        TEXT        NOT NULL,
    query_commitment    TEXT        NOT NULL,
    result_commitment   TEXT        NOT NULL,
    agent_signature     TEXT        NOT NULL,
    node_signature      TEXT        NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_receipts_org_epoch ON usage_receipts(org_id, billing_epoch);

-- ── Audit log ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_log (
    id              BIGSERIAL   PRIMARY KEY,
    org_id          TEXT        NOT NULL REFERENCES orgs(org_id),
    epoch_id        INTEGER     NOT NULL,
    event_type      TEXT        NOT NULL,
    actor_pubkey    TEXT        NOT NULL,
    encrypted_entry TEXT        NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_org_epoch ON audit_log(org_id, epoch_id);

-- ── Credit ledger ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS org_credits (
    org_id          TEXT        PRIMARY KEY REFERENCES orgs(org_id) ON DELETE CASCADE,
    balance         BIGINT      NOT NULL DEFAULT 0 CHECK (balance >= 0),
    lifetime_used   BIGINT      NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS org_extraction_profile (
    org_id          TEXT        PRIMARY KEY REFERENCES orgs(org_id) ON DELETE CASCADE,
    system_prompt   TEXT        NOT NULL DEFAULT '',
    num_ctx         INTEGER     NOT NULL DEFAULT 32768,
    preset_id       TEXT        NOT NULL DEFAULT '',
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS credit_transactions (
    txn_id          BIGSERIAL   PRIMARY KEY,
    org_id          TEXT        NOT NULL REFERENCES orgs(org_id),
    delta           BIGINT      NOT NULL,
    reason          TEXT        NOT NULL,
    receipt_id      TEXT,
    actor           TEXT        NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_txn_org ON credit_transactions(org_id, created_at DESC);

-- ── Key envelopes ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS key_envelopes (
    org_id          TEXT        NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    pubkey          TEXT        NOT NULL,
    epoch_id        INTEGER     NOT NULL,
    enc_envelope    TEXT        NOT NULL,
    search_envelope TEXT        NOT NULL,
    mod_envelope    TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (org_id, pubkey)
);

CREATE INDEX IF NOT EXISTS idx_envelopes_org ON key_envelopes(org_id);

CREATE TABLE IF NOT EXISTS identity_blobs (
    pubkey        TEXT        NOT NULL,
    credential_id TEXT        NOT NULL,
    hkdf_salt     TEXT        NOT NULL,
    iv            TEXT        NOT NULL,
    ciphertext    TEXT        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (pubkey, credential_id)
);

CREATE INDEX IF NOT EXISTS idx_identity_blobs_credential ON identity_blobs(credential_id);

CREATE TABLE IF NOT EXISTS pairing_blobs (
    pairing_id  TEXT        PRIMARY KEY,
    hkdf_salt   TEXT        NOT NULL,
    iv          TEXT        NOT NULL,
    ciphertext  TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Recovery shares ─────────────────────────────────────────────────────────
-- Sealed Shamir shares for threshold recovery of K_master.
-- Hub stores opaque sealed blobs — cannot read share content.
-- Each share is sealed to a designated holder's X25519 pubkey.

CREATE TABLE IF NOT EXISTS recovery_shares (
    org_id              TEXT        NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    share_index         INTEGER     NOT NULL CHECK (share_index BETWEEN 1 AND 3),
    holder_pubkey       TEXT        NOT NULL,
    sealed_share        TEXT        NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (org_id, share_index)
);

CREATE INDEX IF NOT EXISTS idx_recovery_shares_holder ON recovery_shares(holder_pubkey);

-- ── Dashboard keys ─────────────────────────────────────────────────────────
-- Authorized dashboard identities per org.
-- A leader registers a dashboard's Ed25519 pubkey to grant it API access.
-- The dashboard signs every request with this key using the same WeVibe-Signed scheme.

CREATE TABLE IF NOT EXISTS dashboard_keys (
    org_id          TEXT        NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    pubkey          TEXT        NOT NULL,
    label           TEXT        NOT NULL DEFAULT 'dashboard',
    registered_by   TEXT        NOT NULL,
    active          BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (org_id, pubkey)
);

CREATE INDEX IF NOT EXISTS idx_dashboard_keys_pubkey ON dashboard_keys(pubkey);

-- ── Serve events ───────────────────────────────────────────────────────────
-- Individual memory serve events reported by the plugin.
-- Accumulated here until batch-submitted to the chain via MsgSubmitServeBatch.

CREATE TABLE IF NOT EXISTS serve_events (
    id                  BIGSERIAL   PRIMARY KEY,
    org_id              TEXT        NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    epoch_id            INTEGER     NOT NULL,
    memory_content_hash TEXT        NOT NULL,
    serve_key_pubkey    TEXT        NOT NULL,
    serve_sig           TEXT        NOT NULL,
    nonce               TEXT        NOT NULL,
    serve_fingerprint   TEXT,
    contributor_id      TEXT        NOT NULL,
    model_id            TEXT        NOT NULL DEFAULT '',
    turn_count          INTEGER     NOT NULL DEFAULT 0,
    matched_keywords    TEXT[]      NOT NULL,
    reporter_pubkey     TEXT        NOT NULL,
    reason              TEXT,
    event_type          TEXT        NOT NULL DEFAULT 'serve'
                                    CHECK (event_type IN ('serve', 'denial')),
    status              TEXT        NOT NULL DEFAULT 'pending'
                                    CHECK (status IN ('pending', 'submitted', 'failed')),
    tx_hash             TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    submitted_at        TIMESTAMPTZ,
    -- Relay dedup natural key: one row per org/type for a given
    -- (serve key pubkey, memory hash, epoch) tuple.
    UNIQUE (org_id, event_type, serve_key_pubkey, memory_content_hash, epoch_id)
);

CREATE INDEX IF NOT EXISTS idx_serve_events_org_status ON serve_events(org_id, status);
CREATE INDEX IF NOT EXISTS idx_serve_events_org_epoch ON serve_events(org_id, epoch_id);
CREATE INDEX IF NOT EXISTS idx_serve_events_org_status_type ON serve_events(org_id, status, event_type);

CREATE TABLE IF NOT EXISTS session_served_memories (
    org_id      TEXT        NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    session_id  TEXT        NOT NULL,
    memory_cid  TEXT        NOT NULL,
    served_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (org_id, session_id, memory_cid)
);

CREATE INDEX IF NOT EXISTS idx_session_served_served_at ON session_served_memories(served_at);

CREATE TABLE IF NOT EXISTS query_log (
    query_id           TEXT             PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    org_id             TEXT             NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    agent_pubkey       TEXT             NOT NULL,
    session_id         TEXT             NOT NULL DEFAULT '',
    query_text         TEXT,                 -- v1: always NULL (hub never receives raw query); reserved for future opt-in MCP forward
    keyword_weights    JSONB            NOT NULL DEFAULT '[]'::jsonb,
    relevance_floor    DOUBLE PRECISION NOT NULL DEFAULT 0,
    surface_budget     INTEGER          NOT NULL DEFAULT 0,
    embedding_model_id TEXT             NOT NULL DEFAULT '',
    vector_dim         INTEGER          NOT NULL DEFAULT 0,
    limit_n            INTEGER          NOT NULL DEFAULT 0,
    candidate_count    INTEGER          NOT NULL DEFAULT 0,
    returned_count     INTEGER          NOT NULL DEFAULT 0,
    contested          BOOLEAN          NOT NULL DEFAULT FALSE,
    created_at         TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS query_candidate_scores (
    query_id          TEXT             NOT NULL REFERENCES query_log(query_id) ON DELETE CASCADE,
    memory_cid        TEXT             NOT NULL,
    keyword_score     DOUBLE PRECISION NOT NULL DEFAULT 0,
    vector_score      DOUBLE PRECISION NOT NULL DEFAULT 0,
    gamma             DOUBLE PRECISION NOT NULL DEFAULT 0,
    delta             DOUBLE PRECISION NOT NULL DEFAULT 0,
    capped_boost      DOUBLE PRECISION NOT NULL DEFAULT 0,
    combined_score    DOUBLE PRECISION NOT NULL DEFAULT 0,
    matched_keywords  TEXT[]           NOT NULL DEFAULT '{}',
    rank_position     INTEGER          NOT NULL DEFAULT -1,   -- 0-based for returned; -1 otherwise
    disposition       TEXT             NOT NULL CHECK (disposition IN ('returned','below_floor','over_budget_unsampled')),
    PRIMARY KEY (query_id, memory_cid)
);

CREATE INDEX IF NOT EXISTS idx_query_log_org_created ON query_log (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_query_candidate_scores_query ON query_candidate_scores (query_id);

-- ── Chain watcher state ───────────────────────────────────────────────────
-- Restart-safe cursor for the hub ChainWatcher (watcher.go). The watcher reads
-- last_seen_block_height on Start() and catches up from there; it UPDATEs this row
-- at the end of every processBlock. One row, keyed by watcher_name.
CREATE TABLE IF NOT EXISTS watcher_state (
    watcher_name           TEXT        PRIMARY KEY,
    last_seen_block_height BIGINT      NOT NULL DEFAULT 0,
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO watcher_state (watcher_name, last_seen_block_height)
VALUES ('chain_watcher', 0) ON CONFLICT DO NOTHING;

-- ── Org keywords ────────────────────────────────────────────────────────────
-- Approved vocabulary per org for memory categorization.

CREATE TABLE IF NOT EXISTS org_keywords (
    id          SERIAL PRIMARY KEY,
    org_id      TEXT   NOT NULL REFERENCES orgs(org_id),
    keyword     TEXT   NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deprecated  BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE(org_id, keyword)
);

CREATE INDEX IF NOT EXISTS idx_org_keywords_org ON org_keywords(org_id) WHERE NOT deprecated;

-- ── Keyword candidates ─────────────────────────────────────────────────────
-- Suggested non-vocabulary keywords proposed by contributors.

CREATE TABLE IF NOT EXISTS keyword_candidates (
    org_id             TEXT        NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    keyword            TEXT        NOT NULL,
    contributor_pubkey TEXT        NOT NULL,
    submission_hash    TEXT        NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (org_id, keyword, contributor_pubkey, submission_hash)
);

CREATE INDEX IF NOT EXISTS idx_keyword_candidates_org_kw ON keyword_candidates(org_id, keyword);

-- ── Memory keywords ─────────────────────────────────────────────────────────
-- Keywords assigned to specific memories (joined from org_keywords).

CREATE TABLE IF NOT EXISTS memory_keywords (
    memory_cid  TEXT    NOT NULL,
    org_id      TEXT    NOT NULL,
    keyword     TEXT    NOT NULL,
    weight      REAL    NOT NULL DEFAULT 0.0,
    PRIMARY KEY (memory_cid, keyword),
    FOREIGN KEY (org_id, keyword) REFERENCES org_keywords(org_id, keyword)
);

CREATE INDEX IF NOT EXISTS idx_memory_keywords_keyword ON memory_keywords(org_id, keyword);

-- ── notifications ───────────────────────────────────────────────────────────
-- Activity feed for moderator and member notifications.

CREATE TABLE IF NOT EXISTS notifications (
    id              BIGSERIAL   PRIMARY KEY,
    recipient_pubkey TEXT       NOT NULL,
    category        TEXT        NOT NULL,
    title           TEXT        NOT NULL,
    body            TEXT        NOT NULL,
    event_ref       TEXT,
    org_id          TEXT,
    route           TEXT,
    read            BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient_unread ON notifications(recipient_pubkey, read, created_at DESC);

-- ── notification_preferences ────────────────────────────────────────────────
-- Per-user delivery channel preferences for activity notifications.

CREATE TABLE IF NOT EXISTS notification_preferences (
    recipient_pubkey    TEXT        PRIMARY KEY,
    email_address       TEXT        NOT NULL DEFAULT '',
    email_enabled       BOOLEAN     NOT NULL DEFAULT FALSE,
    email_categories    TEXT[]      NOT NULL DEFAULT '{}',
    webhook_url         TEXT        NOT NULL DEFAULT '',
    webhook_enabled     BOOLEAN     NOT NULL DEFAULT FALSE,
    webhook_categories  TEXT[]      NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notification_preferences_updated_at ON notification_preferences(updated_at DESC);

-- ── join_requests ────────────────────────────────────────────────────────────
-- Zero-friction org join with denial cooldown.

CREATE TABLE IF NOT EXISTS join_requests (
    request_id      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          TEXT        NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    requester_pubkey TEXT       NOT NULL,
    x25519_pubkey   TEXT        NOT NULL,
    pre_pubkey      BYTEA,
    -- 'confirming' = leader approved + MsgAddMember broadcast, pending watcher confirmation.
    -- Watcher promotes confirming -> approved on-chain observation; reconcile may revert to pending.
    status          TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirming', 'approved', 'denied')),
    -- Leader approval intent (hub-only) before chain confirmation.
    approval_tier   TEXT,
    approval_is_trial BOOLEAN   NOT NULL DEFAULT FALSE,
    requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_by     TEXT,
    reviewed_at     TIMESTAMPTZ,
    denial_reason   TEXT,
    cooldown_until  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_join_requests_org_pending ON join_requests(org_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_join_requests_requester_org ON join_requests(requester_pubkey, org_id);
