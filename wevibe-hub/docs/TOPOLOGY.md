# Echo Hub Topology (Updated: CO-266)

## Multi-Org Isolation (CO-246)

### Per-Org Qdrant Collections

**Collection naming:** `org_{orgID}_memories`

Each org has its own Qdrant collection, eliminating cross-org data leakage at the storage layer. The collection name is derived via:

```go
func OrgCollectionName(orgID string) string {
    return "org_" + orgID + "_memories"
}
```

**Lazy collection creation:** Collections are created on first upsert (`AddToIndex`), not at hub startup. `EnsureCollection(ctx, client, orgID)` is called with the org's ID before the first memory is stored. Qdrant's "create collection" API is idempotent — returning OK if the collection already exists.

**Defense-in-depth:** The `org_id` filter is retained on all Qdrant queries even though the collection name already provides org scoping. This serves as a safety net if any code path bypasses the per-org collection naming.

**Removed:** All references to `const CollectionName = "wevibe_memories"`. The shared `wevibe_memories` collection is no longer used.

**Affected files:**
- `internal/retrieval/retrieval.go` — `OrgCollectionName` function, all Qdrant URL construction
- `internal/retrieval/retrieval_test.go` — updated tests
- `cmd/wevibe-hub/main.go` — removed startup `EnsureCollection` call

### Authz Middleware (CO-246)

**Location:** `internal/auth/middleware.go`

All org-scoped routes are protected by `RequireOrgMembership` middleware, which:
1. Extracts `orgID` from URL parameter
2. Parses `WeVibe-Signed` auth header
3. Verifies the caller is an active member of the org via direct SQL query
4. Sets `memberPubkey` and `memberOrgID` in request context

**Context helpers:**
```go
func GetMemberPubkey(ctx context.Context) string
func GetMemberOrgID(ctx context.Context) string
```

**Public routes (no membership check):**
- `GET /health` — health check
- `GET /v1/members/{pubkey}/orgs` — list orgs for a member
- `GET /v1/profile/{wallet}` — public profile (CO-247): wallet/org memberships/chain stats
- `POST /v1/orgs` — create org
- `GET /v1/orgs/{orgID}` — org info for discovery (D-12.7)
- `GET /v1/orgs/discover` — list/search public orgs (D-12.7, GAP-M4 CLOSED in Sprint 25)
- `POST /v1/orgs/{orgID}/join` — submit join request (D-12.8, GAP-M5 CLOSED in Sprint 25)
- `GET /v1/orgs/{orgID}/epoch/{epochID}/manifest` — needed by wevibe-mcp during setup flows
- `POST /v1/billing/topup` — billing (no org scoping)

**User-scoped notification routes (WeVibe-Signed auth, not org-scoped):**
- `GET /v1/notifications` — list notifications for authenticated user (all orgs aggregated)
- `GET /v1/notifications/unread-count` — fast unread count
- `POST /v1/notifications/mark-read` — mark notifications as read
- `GET /v1/notifications/ws` — WebSocket endpoint for realtime push

## Client Surface

As of Sprint 26 / CO-260, `wevibe-mcp` is the single client for consumer-side hub operations (`query`/recall, serves, reports). The plugin no longer calls hub serves/report endpoints directly.

**Auth contract:** Hub auth is unchanged and remains `WeVibe-Signed` from the `wevibe-mcp` delegate. Plugin auth is a Bearer token to `wevibe-mcp` (D-12.5a).

**Scope boundary:** Dashboard continues to call hub directly for moderation/admin flows; the "single client" rule applies only to the consumer surface.

## Sprint 27 Gap Blitz (CO-265)

### Contributor Submission Status Endpoint

New endpoint:

- `GET /v1/orgs/{orgID}/my-submissions`

Behavior:

- Auth: `WeVibe-Signed` required
- Caller must be an active org member
- Response is filtered to `pending_submissions.contributor_pubkey == signed.pubkey`
- Includes `submission_hash`, `status`, `denial_reason`, `created_at`, `updated_at`, and extraction metadata fields

### Submit Response Sanitization Findings

`POST /v1/orgs/{orgID}/submit` now returns additive `sanitization_findings` in the response body when findings exist, in addition to storing them in `pending_submissions.sanitization_findings`.

### Moderation Quorum Metadata

`GET /v1/orgs/{orgID}/moderation/queue` now includes quorum state for each pending item:

- `votes`
- `required_approvals`
- `voter_pubkeys`

This is consumed by dashboard quorum voting UI for orgs with `required_approvals > 1`.

### Hub → Chain Org Registration Sync

`CreateOrg` now performs immediate chain registration after PostgreSQL org creation:

- Calls `RegisterOrgOnChain` (builds and broadcasts `MsgRegisterOrg`)
- On success/failure, hub persists `orgs.chain_registered` boolean state
- Chain registration failure is logged but does not roll back hub org creation

## Sprint 28 Gap Blitz — CO-266 Hub Features (GAP-O6, O7, N2, N8, N9)

### Trial Membership (GAP-N8)

Trial membership provides a limited onboarding tier for new members. Trial members cannot contribute memories but can query up to a daily limit.

**Schema additions (`db/schema.sql`):**
- `members.is_trial BOOLEAN NOT NULL DEFAULT FALSE`
- `members.trial_expires_at TIMESTAMPTZ`
- `orgs.trial_days INTEGER NOT NULL DEFAULT 0` — default 0 means trial disabled

**Join approval with trial flag:**
- `POST /v1/orgs/{orgID}/join-requests/{requestID}/approve` accepts optional `trial: boolean` field
- If `trial=true`: sets `is_trial=TRUE`, `trial_expires_at=NOW() + trial_days`
- If `trial=false` or omitted: creates full member (`is_trial=FALSE`)

**Trial enforcement in retrieval (`internal/api/handlers/retrieval.go`):**
- `QueryMemories` checks caller membership: if `is_trial=TRUE AND trial_expires_at < NOW()`, returns 403
- Daily rate limit enforced: trial members limited to `trial_daily_limit` retrievals per day (default 5)

**Upgrade to full:** When a trial member is later approved as full (via role update), `is_trial` is set to FALSE and `trial_expires_at` is cleared.

### Financess Endpoint (GAP-O6)

New endpoint `GET /v1/orgs/{orgID}/finances` returns combined credits and chain financial data:

- Credits balance from `org_credits` table
- Chain registration status (`chain_registered`)
- Trial days configuration

**Handler:** `GetFinances(w, r)` in `internal/api/handlers/billing.go`

### Chain Config Read/Write (GAP-O7)

New endpoint `GET /v1/orgs/{orgID}/chain-config` (leader-only) returns org chain configuration:

- `chain_id`, `chain_rpc_url`, `chain_grpc_url`, `chain_bech32_prefix`

`PATCH /v1/orgs/{orgID}/config` now accepts chain configuration fields to update them.

**Handler:** `GetChainConfig(w, r)` in `internal/api/handlers/chain_config.go`

### Moderation Submit with Trial Block (GAP-N9)

**Single submit:** `POST /v1/orgs/{orgID}/submit` checks `is_trial` before accepting. Trial members receive `403 Trial members cannot contribute. Upgrade to full membership.`

**Batch submit:** `POST /v1/orgs/{orgID}/moderation/batch-submit` also blocks trial members with the same message.

### Moderation Deny with Edit Note (GAP-N2)

`DenySubmission` records original and edited content in denial reason when edit-note is provided. This is used as a fallback when encrypted content cannot be previewed inline.

| Operation | Pre-CO-260 caller | Post-CO-260 caller |
| --- | --- | --- |
| Query / Recall | Plugin and `wevibe-mcp` | `wevibe-mcp` only |
| Serves | Plugin and `wevibe-mcp` | `wevibe-mcp` only |
| Reports | Plugin and `wevibe-mcp` | `wevibe-mcp` only |

### Profile Endpoint (CO-247)

**Location:** `internal/api/handlers/profile.go`

**Handler:** `GetProfile(w, r)` — `GET /v1/profile/{wallet}`

Public endpoint (no auth required) — returns aggregated profile data for any wallet or pubkey.

**Response shape:**
```json
{
  "wallet": "cosmos1...",
  "pubkey": "ed25519-hex-if-known",
  "memberships": [
    {
      "org_id": "uuid",
      "org_name": "string",
      "role": "leader|moderator|member",
      "joined_at": "timestamp"
    }
  ],
  "chain_stats": {
    "total_approved_memories": 0,
    "total_serves": 0,
    "first_seen_epoch": 0,
    "reputation_tier": "string or null"
  },
  "moderator_stats": {
    "total_approvals": 0,
    "total_upheld_reports": 0
  },
  "leader_stats": {
    "total_chain_commits": 0,
    "total_epoch_rotations": 0
  }
}
```

**Behavior:**
- Accepts wallet address OR Ed25519 pubkey as `{wallet}` path param
- Resolves wallet→pubkey via `delegate_keys` table if needed
- Queries org memberships via `members.ListOrgsForMember`
- Fetches chain reputation via `chainClient.GetContributorProfile` (5s timeout)
- Graceful fallback: null for any unavailable data (chain down, no profile, etc.)
- Fields that are unavailable return `null` not omitted

**Route structure in main.go:**
```go
// Public route — outside org middleware group
r.Get("/v1/profile/{wallet}", handlers.GetProfile)

// User-scoped notification routes — not org-scoped, use WeVibe-Signed auth
r.Get("/v1/notifications", handlers.ListNotifications)
r.Get("/v1/notifications/unread-count", handlers.GetUnreadCount)
r.Post("/v1/notifications/mark-read", handlers.MarkRead)
r.Get("/v1/notifications/ws", handlers.NotificationWebSocket)
```

### Notification Endpoints (CO-248)

**Location:** `internal/api/handlers/notifications.go`

**NotificationHub:** `internal/notifications/hub.go` — manages per-pubkey WebSocket client sets for realtime push.

**GET /v1/notifications**
- Auth: WeVibe-Signed header required
- Query params: `limit` (default 50, max 200), `before` (cursor), `unread_only` (boolean)
- Returns notifications from ALL orgs (all-orgs aggregated, not filtered by active org)
- Response:
```json
{
  "notifications": [
    {
      "id": 1,
      "category": "chain_commit_involving_you",
      "title": "You were listed as approver on a chain commit",
      "body": "Memory abc123 was committed to chain in org...",
      "event_ref": "txHashHex",
      "org_id": "uuid",
      "org_name": "Org Name",
      "read": false,
      "created_at": "2026-05-19T12:00:00Z"
    }
  ],
  "has_more": true
}
```

**GET /v1/notifications/unread-count**
- Auth: WeVibe-Signed header required
- Response: `{ "count": 5 }`

**POST /v1/notifications/mark-read**
- Auth: WeVibe-Signed header required
- Body: `{ "notification_ids": [1, 2, 3] }` or `{ "all": true }`
- Response: `{ "marked": 3 }`

**GET /v1/notifications/ws (WebSocket)**
- Auth: Client sends `{ "type": "auth", "data": { "pubkey": "hex", "timestamp": "...", "signature": "..." } }`
- Server responds `{ "type": "auth_success" }` on success
- New notifications pushed as `{ "type": "notification", "data": { ...notification... } }`
- Client can send `{ "type": "ping" }`, server responds `{ "type": "pong" }`

**Notification categories:**
- `chain_commit_involving_you` — triggered when user is listed as approver on a chain commit
- `report_upheld_committed` — triggered when a report the user voted to uphold was committed to chain
- `your_approval_was_overturned` — triggered when a memory the user approved was deleted via upheld report

**Route structure in main.go:**
```go
r.Route("/v1/orgs/{orgID}", func(r chi.Router) {
    r.Use(auth.RequireOrgMembership(handlers.GetPool()))
    // All authenticated org routes here
})
```

### Join Request Endpoints (CO-259 — Sprint 25)

**Location:** `internal/api/handlers/join.go`

**Handlers:** `SubmitJoinRequest` (347 lines), `ListJoinRequests`, `ApproveJoinRequest`, `DenyJoinRequest`

**Routes:**
- `POST /v1/orgs/{orgID}/join` — submit a join request (no auth required, uses WeVibe-Signed header)
- `GET /v1/orgs/{orgID}/join-requests` — list join requests (leader/moderator only)
- `POST /v1/orgs/{orgID}/join-requests/{requestID}/approve` — approve join request
- `POST /v1/orgs/{orgID}/join-requests/{requestID}/deny` — deny with optional reason + 7-day cooldown

**Status:** GAP-M5 CLOSED in Sprint 25. Handler fully implemented (347 lines), routes wired in main.go.

## Content Sanitization (CO-239)

### Unicode Threat Scanner

**Location:** `internal/sanitize/`

**Files:**
- `scanner.go` — Unicode category scanner for detecting invisible/malicious unicode
- `homoglyphs.go` — Homoglyph detection map (Cyrillic/Greek look-alikes to Latin)
- `scanner_test.go` — Comprehensive test suite

**Detection categories:**
- **Critical:** Bidirectional override characters (U+200B-U+200F, U+202A-U+202E, U+2060-U+2069), format characters (U+00AD SOFT HYPHEN, U+FEFF BOM), control characters (Cc category except tab/newline/CR)
- **Warning:** Invisible space characters (Zs category: U+00A0 NBSP, U+2000-U+200A, U+202F, U+205F, U+3000), zero-width joiners (ZWJ U+200D, ZWNJ U+200C), homoglyphs (Cyrillic е→e, о→o, р→p, а→a, etc.)
- **Zalgo:** Consecutive combining marks (>2 Mn/Mc category characters)

**Schema update (CO-239):**
```sql
-- pending_submissions addition
sanitization_findings JSONB  -- Stored at submission time, pre-encryption
```

**Submission pipeline (CO-239):**
- `POST /v1/orgs/{orgID}/submit` calls `sanitize.Scan()` on plaintext before encryption
- Findings stored in `sanitization_findings` column (not blocking)
- Findings surfaced to moderators via moderation queue response and to contributors via submit response payload
- Moderator decides action — findings are flags, not filters (R-ONE-PATH: no auto-reject)

**Findings shape:**
```json
[
  {
    "category": "critical",
    "description": "Bidirectional override character detected",
    "position": 14,
    "codepoint": "U+202E",
    "severity": "critical"
  },
  {
    "category": "warning",
    "description": "Invisible spacing character detected",
    "position": 7,
    "codepoint": "U+200B",
    "severity": "warning"
  }
]
```

## Memory Lifecycle (CO-238)

### Multi-Stage Approval Pipeline

The hub implements a multi-stage memory lifecycle that decouples approval from keyword extraction from chain commitment:

**Status values:** `pending` → `pending_keyword` → `pending_chain` → `committed`

**Flow:**
1. **Contributor submits** (`pending`) — memory enters moderation queue
2. **Moderator approves** (`pending_keyword`) — moderator stamps quality, records `moderator_pubkey` and `approved_at`
3. **Leader triggers batch keyword extraction** (`pending_chain`) — LLM classifies per-memory against org vocabulary, hub verifies
4. **Leader reviews results** — can rerun/edit/remove before chain commitment
5. **Leader triggers batch chain submission** (`committed`) — multi-message Cosmos TX, Qdrant insert, keyword decay starts

**Schema updates (CO-238):**
```sql
-- pending_submissions additions
status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'pending_keyword', 'pending_chain', 'committed'))
moderator_pubkey TEXT           -- moderator who approved
approved_at TIMESTAMPTZ          -- when approved
extraction_result JSONB         -- hub-verified keywords + scores
extraction_feedback TEXT         -- leader feedback for rerun
verified_at TIMESTAMPTZ          -- when keywords were verified

-- orgs additions
last_batch_extraction_at TIMESTAMPTZ  -- leader activity tracking
last_chain_submission_at TIMESTAMPTZ   -- leader activity tracking
```

**Indexes:** `idx_pending_submissions_status ON pending_submissions(org_id, status)`

### Keyword Endpoints (CO-238)

**Leader-only endpoints for the batch pipeline:**

```
POST /v1/orgs/{orgID}/submit-keyword-results
  → Stores extraction results from dashboard (not yet verified)

POST /v1/orgs/{orgID}/verify-keywords
  → Hub-side verification: keyword format, count ≤ 20, weights sum to 1.0, char limits
  → Transitions status from pending_keyword → pending_chain

POST /v1/orgs/{orgID}/submissions/{hash}/rerun-keywords
  → Clears extraction_result, resets to pending_keyword, stores feedback

PUT /v1/orgs/{orgID}/submissions/{hash}/update-keywords
  → Manual keyword override, resets to pending_keyword

DELETE /v1/orgs/{orgID}/submissions/{hash}
  → Remove submission (only pending_keyword or pending_chain)

GET /v1/orgs/{orgID}/submissions?status={status}
  → List submissions filtered by status (leader-only)
```

**Verification rules (in verify-keywords):**
- Each classified keyword matches `^[a-z][a-z0-9_]{1,39}$`
- Each classified keyword exists in org_keywords (not deprecated)
- Count of classified keywords ≤ 20
- Sum of classified keyword weights ≈ 1.0 (tolerance: |sum - 1.0| < 0.02)
- Memory plaintext length ≤ 2000 chars
- For `negative_signal` memory type: content ≤ 1000 chars
- No pending suggestions remain (all must be approved/rejected before verification)

### Batch Chain Submit (CO-238)

```
POST /v1/orgs/{orgID}/batch-chain-submit (leader-only)
```

**Behavior:**
- Bundles all pending_chain submissions into ONE multi-message Cosmos TX
- R-ATOMIC: Chain TX confirms before hub status update
- Post-commit: Qdrant insert + memory_keywords population + status → committed
- If post-commit steps fail after chain confirms: flagged for manual review (chain immutable)

**Org Health endpoint:**
```
GET /v1/orgs/{orgID}/health (leader-only)
→ Returns: last_batch_extraction_at, last_chain_submission_at, pending_keyword_count, pending_chain_count
```

## Moderation Queue (CO-238 update)

**GET /v1/orgs/{orgID}/moderation/queue** now returns only `status = 'pending'` submissions.

**Queue metadata (CO-265):** each queue item includes `votes`, `required_approvals`, and `voter_pubkeys` so clients can render quorum state.

**Vote endpoint:** `POST /v1/orgs/{orgID}/moderation/{submissionHash}/vote` casts a moderator/leader approval vote and returns `{ status, votes, required_approvals, ready }`.

**ApproveSubmission handler (CO-238):**
- Simplified to only change status to `pending_keyword` and record moderator
- Removed: keyword extraction, embedding computation, Qdrant insert, chain TX at approval time
- Canonical message: `echo.approve_submission.v2` (simpler format without keywords/capsule)

## Qdrant Chain Parity (CO-224)

## Qdrant Chain Parity (CO-224)

### Retrieval Architecture

Chain is the authority for retrieval metadata (`keywords`, `retrieval_confidence_bps`, `state`).
Hub mirrors that metadata into Qdrant for fast lookup and ranking.

**Qdrant payload fields (approved memories):**
- Required: `cid`, `org_id`, `epoch_id`, `content_flags`, `keywords`, `confidence_bps`, `lifecycle_state`
- Optional embedding metadata: `embedding_model_id`, `embedding_schema_version`, `vector_dim`

**Keyword lifecycle:**
- `UpsertPoint` writes `keywords` from `IndexEntry.Keywords` at approval time
- `UpdateMemoryKeywords` is restored and used by merge/rename keyword handlers
- PostgreSQL `memory_keywords` remains the write-ahead cache; Qdrant is the retrieval cache

**Confidence/state lifecycle:**
- `UpsertPoint` writes initial values at approval (`confidence_bps=10000`, `lifecycle_state=APPROVED`)
- `UpdateMemoryConfidenceAndState` updates payload by (`org_id`, `cid`) via Qdrant `set_payload`
- `SyncEpochData` (new, `internal/chain/sync.go`) polls chain gRPC each interval and reconciles payload deltas

**Query behavior (`QueryPoints`):**
- Always excludes `ARCHIVED`
- Excludes `DORMANT` by default; caller can include via `include_dormant=true`
- Ranks by weighted score: vector similarity + keyword overlap boost + confidence weighting
- Uses Qdrant payload metadata directly (no PostgreSQL keyword read on query path)

**Scroll behavior (`ScrollApprovedMemories`):**
- Reads `keywords`, `confidence_bps`, and `lifecycle_state` from Qdrant payload
- No PostgreSQL keyword lookup in scroll path

## Deployment Diagram (CO-258)

```
+-------------------+
|   wevibe-chain      |
|   gRPC :9090      |
|   RPC :26657      |
+-------------------+
            ^
            | gRPC
            |
+-------------------+
|   wevibe-hub        |
|   HTTP :4440      |
|   GrpcClient      |
+-------------------+
            |
      +-----+-----+
      |           |
      v           v
+--------+  +----------+
| Postgres|  | Qdrant   |
+--------+  +----------+
            ^
            | gRPC (umbral-sidecar:4460)
            |
+-------------------+
| wevibe-umbral|
|   (PRE sidecar)    |
|   Docker service   |
+-------------------+
```

## PRE Re-Encryption Service (CO-216, CO-217, CO-218)

**Location:** `internal/umbral/`

The hub communicates with the `wevibe-umbral` binary via gRPC for PRE re-encryption operations. This package is the Apache-2.0 Go wrapper around the GPL-3.0 Umbral library (isolated in the sidecar binary).

**Files:**
```
internal/umbral/
├── umbralpb/
│   ├── sidecar.proto      # Proto definition (copied from sidecar)
│   ├── sidecar.pb.go     # Generated protobuf message types
│   └── sidecar_grpc.pb.go # Generated gRPC service client/stubs
├── client.go             # gRPC client wrapper (6 RPCs implemented)
├── client_test.go        # Integration tests (requires running sidecar)
└── service.go           # Business logic layer — 6 methods fully implemented (CO-218)
```

**Key methods (all implemented in CO-218):**
- `GenerateEpochKeyPair(ctx) (secretKey, publicKey []byte, error)` — generates new Umbral epoch keypair via sidecar
- `RegisterMember(ctx, orgID, epochID, delegatingSK, receivingPK, signerSK, verifyingPK) (kfrag []byte, error)` — generates and stores kfrag for new member
- `ReEncryptForMember(ctx, orgID, epochID, memberPK, capsule) (cfrag []byte, error)` — core retrieval re-encryption
- `OnMemberRemoved(ctx, orgID, memberPK) (deletedCount uint32, error)` — deletes all kfrags for a removed member
- `RemoveOrgKFrags(ctx, orgID) (deletedCount uint32, error)` — deletes all kfrags for org dissolution
- `Health(ctx) error` — checks sidecar health

**Error handling:**
- `ErrSidecarUnavailable` — returned when sidecar gRPC is unavailable (wraps codes.Unavailable)
- `ErrKFragNotFound` — returned when no kfrag exists for member/epoch (wraps codes.NotFound)
- No retries per R-ONE-PATH — operations fail hard on sidecar errors

**Sidecar connection (CO-258 — containerized):**
- Address: `umbral-sidecar:4460` (from `WEVIBE_UMBRAL_SIDECAR_ADDR`, defaults to `127.0.0.1:4460` for local dev)
- Container runs at `umbral-sidecar:4460` in docker-compose; hub reads address from env var
- No TLS (container-internal network assumed)
- gRPC with insecure credentials
- Healthcheck: `nc -z localhost 4460` (retries: 20, interval: 5s)

**Dependency injection (CO-218):**
- Service created in `cmd/wevibe-hub/main.go` at startup (after chain + qdrant init)
- Wired to handlers via `handlers.SetUmbralService()` (package-level var pattern, same as pool/qdrantClient)
- Handlers check `umbralService != nil` before use (nil-safe)

**gRPC dependencies (added CO-217):**
- `google.golang.org/grpc v1.81.1`
- `google.golang.org/protobuf`

**Integration tests (CO-217):**
Run with: `go test -tags=integration -run TestSidecar ./internal/umbral/`
Tests: `TestSidecarIntegration`, `TestSidecarIntegration_DeleteOrgKFrags`, `TestSidecarReEncryptNeedsCapsule`

**Handler (fully functional since CO-218):**
- `internal/api/handlers/reencrypt.go`
  - `ReEncrypt(w, r)` — POST /v1/internal/reencrypt — internal re-encryption endpoint (was 501, now functional)
  - `GenerateEpochKeyPair(w, r)` — POST /v1/internal/epoch-keypair
  - `GenerateKFrags(w, r)` — POST /v1/internal/orgs/{orgID}/kfrags
- `internal/api/handlers/members.go` — InviteMember calls RegisterMember if `epoch_sk` in request; RemoveMember calls OnMemberRemoved after DB commit
- `internal/api/handlers/orgs.go` — CreateOrg and RotateEpoch call GenerateEpochKeyPair, return epoch_sk/epoch_pk in response

## PRE Approval Storage + Member PRE Keys (CO-221)

**Schema updates (`internal/db/schema.sql`):**
- `members.pre_pubkey BYTEA` — member secp256k1 PRE public key (33-byte compressed)
- `epoch_manifests.umbral_pk BYTEA` — epoch Umbral public key
- `pending_submissions.umbral_capsule BYTEA` — capsule produced at moderation approval
- `pending_submissions.umbral_ciphertext BYTEA` — Umbral-encrypted DEK produced at moderation approval

**Org + epoch manifest flow:**
- `CreateOrg` and `RotateEpoch` now persist `umbral_pk` in `epoch_manifests`
- `GET /v1/orgs/{orgID}/epoch/{epochID}/manifest` includes `umbral_pk` as hex

**Moderation approval flow:**
- `POST /v1/orgs/{orgID}/moderation/{submissionHash}/approve` now accepts `umbral_capsule` and `umbral_ciphertext`
- `wrapped_dek_enc` is no longer accepted in `ApproveRequest`
- Canonical signature payload now binds `umbral_capsule` + `umbral_ciphertext`

**Member PRE key endpoints:**
- `POST /v1/orgs/{orgID}/members/{pubkey}/pre-key` — register PRE pubkey (self or leader)
- `GET /v1/orgs/{orgID}/members/{pubkey}/pre-key` — fetch registered PRE pubkey
- `InviteMember` accepts optional `pre_pubkey`; kfrag generation at invite requires both `epoch_sk` and `pre_pubkey`

## Keyword Weight Decay (CO-240)

Hub mirrors keyword weight decay from chain on each confirmed serve/denial TX (R-ATOMIC pattern).

**Decay constants:**
```go
const (
    DenialDecayBPS  = 500  // 0.05 per denial event
    ServeBoostBPS   = 100  // 0.01 per serve event
    MaxServesPerEpoch = 5  // cap per epoch per memory
    IdleDecayBPS    = 50   // 0.005 per idle epoch
)
```

**Functions in `internal/retrieval/retrieval.go`:**
- `ApplyServeBoostLocal(ctx, db, memoryCID, orgID)` — called on confirmed serve TX, updates keyword weights in `memory_keywords` table
- `ApplyDenialDecayLocal(ctx, db, memoryCID, orgID)` — called on confirmed denial TX, updates keyword weights

**Wiring in `internal/api/handlers/serves.go`:**
- Serve handler calls `retrieval.ApplyServeBoostLocal` after chain TX confirms
- Denial handler calls `retrieval.ApplyDenialDecayLocal` after chain TX confirms
- Qdrant payload updated on keyword weight changes

**Chain TX builder (`internal/chain/submit.go`):**
- `MsgSubmitCommitment` now uses `repeated KeywordWeight keywords` (not string keywords)
- `BatchMemory.Keywords` field type: `[]*memorytypes.KeywordWeight`

**Crash recovery:**
- `SyncEpochData` in `internal/chain/sync.go` queries chain state and reconciles Qdrant payload
- On hub restart, keyword weights resync from chain (chain is authority)

**Removed:** All references to memory-level `confidence_bps`. Keyword weights ARE the health metric.

## Deployment Diagram (CO-258)

```
+-------------------+
|   wevibe-chain      |
|   gRPC :9090      |
|   RPC :26657      |
+-------------------+
            ^
            | gRPC
            |
+-------------------+
|   wevibe-hub        |
|   HTTP :4440      |
|   GrpcClient      |
+-------------------+
            |
      +-----+-----+
      |           |
      v           v
+--------+  +----------+
| Postgres|  | Qdrant   |
+--------+  +----------+
            ^
            | gRPC (umbral-sidecar:4460)
            |
+-------------------+
| wevibe-umbral|
|   (PRE sidecar)    |
|   Docker service   |
+-------------------+
```

## Data Stores

- **PostgreSQL** — orgs, members (including `pre_pubkey`), epoch manifests (including `umbral_pk`), pending submissions (including `umbral_capsule`, `umbral_ciphertext`, and `banned`), moderation queue, audit log, credit ledger, key envelopes, recovery shares, dashboard keys, delegate keys, keyword vocabulary, serve_events (with `event_type IN ('serve', 'denial')` and `reason` column), reports (with `resolution` tracking), wallet addresses (nullable, unique per org).
- **Qdrant** — vector index + chain-mirrored retrieval metadata for approved memories (`keywords`, `confidence_bps`, `lifecycle_state`) used for filtering/ranking.
- **Object storage** (optional) — ciphertext blobs referenced by CID.

## Chain Client (`internal/chain/`)

- **grpc_client.go** — `GrpcClient` struct holds gRPC connection, codec, keyring, tx config, and query clients for all 7 wevibe-chain modules.
- **query.go** — nil-safe wrappers: org registration checks, merkle root queries, serve stats, attestation lookups, bandwidth state, emissions params, reputation stats.
- **broadcast.go** — `BroadcastTx` signs and broadcasts transactions to wevibe-chain via Comet RPC `broadcast_tx_sync` (D-13.12). Fees: `ceil(gas × 0.01 uvibe)` with 2000 uvibe floor. Retry on transient errors (8 attempts, 400ms backoff).
- **submit.go** — `SubmitMemoryToChain` and `SubmitMemoryBatch` build and broadcast `MsgSubmitMemory`; `SubmitServeBatch` for serve event attestation.
- **merkle.go** — binary SHA-256 Merkle tree for epoch root computation.
- **sync.go** — `SyncEpochData` polling loop logic: compares chain confidence/state to Qdrant payload and updates changed records.

CometBFT RPC is not consumed yet, but config now includes optional `WEVIBE_CHAIN_RPC_URL` (`ChainRPCURL`) for Sprint 23 WebSocket work.

## API Components

- REST router: Chi (`go-chi/chi/v5`).
- CORS configurable via `CORS_ALLOWED_ORIGINS` env var.
- No WebSocket hub yet — all real-time updates are client-poll.

## Retrieval & Trust System (Sprint 28)

- `POST /v1/orgs/{orgID}/query` returns memory candidates enriched with trust stats.
- Query scoring uses vector similarity, keyword overlap boost, and confidence weighting.
- Retrieval lifecycle tiers are enforced in Qdrant filtering: `ARCHIVED` is hard-excluded, `DORMANT` is hidden by default and only included when requested.
- Every result includes `retrieval_count`, `acceptance_count`, and `contributor_stats` (account age, contributions, reports upheld, false reports against).
- Trust panel formatting is handled client-side by wevibe-mcp via `trust-panel.ts`.
- **Banned memories filtered:** Results exclude memories where `pending_submissions.banned = TRUE`.
- **No quarantine system:** Memories are never auto-removed based on rejection counts.
- Chain is only contacted when a memory accumulates enough upheld reports to trigger a ban (quorum via `report_ban_threshold` per org).
- `GET /v1/orgs/{orgID}/memories` (`ScrollApprovedMemories`) sources keywords/confidence/lifecycle from Qdrant payload (chain mirror), not PostgreSQL keyword joins.

### PRE Retrieval Pipeline (CO-218, CO-221)

**Query request changes (CO-218):**
- `QueryRequest` now requires `pre_pubkey` field (hex-encoded 33-byte compressed secp256k1 PRE public key)
- Without `pre_pubkey`, the request returns 400 Bad Request

**Query response changes (CO-218/CO-221):**
- `MemoryResult` includes `cfrag`, `capsule`, and `umbral_ciphertext` fields (hex-encoded PRE payload)
- `QueryResponse` includes `requires_reencryption` ([]string, CID list) for old-format memories
- Memories with Umbral capsules: returned with `cfrag`, `capsule`, and `umbral_ciphertext` populated (PRE path)
- Memories without Umbral capsules (old symmetric format): skipped, added to `requires_reencryption` list

**PRE retrieval flow:**
1. Consumer posts query with `pre_pubkey` (their secp256k1 PRE public key)
2. Hub verifies membership → queries Qdrant → fetches chain attestation data
3. Hub loads `umbral_capsule` and `umbral_ciphertext` for approved memories from PostgreSQL (`pending_submissions`)
4. For each memory with a capsule: hub calls `umbralService.ReEncryptForMember(orgID, epochID, memberPK, capsule)`
5. Sidecar applies stored kfrag → returns cfrag
6. Hub returns `cfrag + capsule + umbral_ciphertext` to consumer
7. Consumer uses `decrypt_reencrypted(capsule, cfrag, ciphertext, pre_private_key, delegating_pk)` to recover DEK

**Old-format memory handling:**
- Memories encrypted under the old symmetric scheme (X25519 envelope) have no Umbral capsule
- These are NOT returned in results — instead their CIDs are listed in `requires_reencryption`
- The memory is unretrievable until re-encrypted under Umbral (background job, future CO)
- For dogfood/development: wipe and re-seed memories after PRE ships

## Denial Event Recording (CO-225)

Hub records denial events (incorrect/harmful memory outputs reported by consumers) and syncs them to wevibe-chain via `MsgSubmitDenialBatch`.

**Endpoints:**
- `POST /v1/orgs/{orgID}/denials` (`RecordDenialEvent`) — records a single denial for a served memory
- `POST /v1/orgs/{orgID}/denials/batch-submit` (`BatchSubmitDenials`) — submits accumulated denials to wevibe-chain as `MsgSubmitDenialBatch`

**Schema (`serve_events` table, CO-225):**
```sql
CREATE TABLE serve_events (
    id              BIGSERIAL PRIMARY KEY,
    org_id          TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    contributor_id  TEXT NOT NULL,
    memory_hash     TEXT NOT NULL,
    serve_id        TEXT NOT NULL,
    reason          TEXT,
    event_type      TEXT NOT NULL CHECK (event_type IN ('serve', 'denial')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    submitted       BOOLEAN NOT NULL DEFAULT FALSE,
    submitted_at    TIMESTAMPTZ,
    UNIQUE (org_id, serve_id, event_type)
);
```
- `event_type IN ('serve', 'denial')` differentiates serve attestations from denial attestations
- `reason` captures consumer-provided context for the denial
- `submitted` flag tracks which events have been relayed to wevibe-chain

**Flow:**
1. Consumer reports a denial via `POST /v1/orgs/{orgID}/denials` with `memory_hash`, `serve_id`, `reason`
2. Hub persists to `serve_events` with `event_type = 'denial'`
3. Leader or automated job calls `POST /v1/orgs/{orgID}/denials/batch-submit`
4. `BatchSubmitDenials` reads pending (`submitted = FALSE`) denials, calls `chain.SubmitDenialBatch`, marks submitted on success
5. wevibe-chain `MsgSubmitDenialBatch` handler persists `StoredDenialAttestation` per memory/epoch; memory keeper queries denial count for decay

**Key functions in `internal/serves/serves.go`:**
- `RecordDenial(ctx, pool, orgID, req)` — inserts denial event, returns ID
- `GetPendingDenials(ctx, pool, orgID)` — reads all unsubmitted denials for an org
- `MarkDenialsSubmitted(ctx, pool, orgID, serveIDs)` — marks denials as submitted on success

**Chain client (`internal/chain/submit.go`, CO-225):**
- `SubmitDenialBatch(ctx, orgID, denials)` — builds and broadcasts `MsgSubmitDenialBatch` via `GrpcClient`

**Route registration:** Both denial routes registered in `cmd/wevibe-hub/main.go` alongside existing serve routes.

## Report Flow (CO-231, CO-233)

Hub manages the complete report lifecycle: submission, voting, and leader-gated chain commitment.

**Report lifecycle:** `pending → upheld_pending_tx → upheld | dismissed | dismissed_malicious`
- `pending`: Awaiting moderator votes
- `upheld_pending_tx`: Quorum passed, awaiting leader chain commitment (CO-233)
- `upheld`: TX confirmed, memory deleted from Qdrant
- `dismissed`: Memory unchanged, reporter's dismissed_reports_count incremented
- `dismissed_malicious`: Reporter flagged, count incremented, leader notified

**Endpoints:**
- `POST /v1/orgs/{orgID}/reports` (`CreateReport`) — Submit memory report (paid members only; trial members blocked)
- `GET /v1/orgs/{orgID}/reports` (`ListReports`) — List reports with status filter (moderator/leader only)
- `GET /v1/orgs/{orgID}/reports/{reportID}` (`GetReport`) — Report detail
- `PATCH /v1/orgs/{orgID}/reports/{reportID}` (`UpdateReport`) — Resolve/escalate/report
- `POST /v1/orgs/{orgID}/reports/{reportID}/vote` (`VoteOnReport`) — Cast vote (uphold/dismiss/dismiss_malicious)
- `POST /v1/orgs/{orgID}/reports/{reportID}/commit` (`CommitReport`) — Leader wallet-signed chain commitment (CO-233)

**Schema updates (CO-231):**
```sql
-- reports table additions
reporter_wallet TEXT         -- Cosmos bech32 wallet address of reporter
note TEXT                    -- Free-text note (max 500 chars)
-- members table addition
dismissed_reports_count INTEGER DEFAULT 0  -- Incremented when report dismissed/malicious
-- orgs table addition
report_vote_threshold INTEGER DEFAULT 1    -- Votes needed to resolve report
-- new table
CREATE TABLE report_votes (
    org_id          TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    report_id       UUID NOT NULL,
    voter_pubkey    TEXT NOT NULL,
    vote            TEXT NOT NULL CHECK (vote IN ('uphold', 'dismiss', 'dismiss_malicious')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (org_id, report_id, voter_pubkey)
);
```

**Paid-member gate:** `CreateReport` checks `member_tier != 'trial'` before accepting. Trial members receive greyed-out Report button in plugin (CO-232).

**Reporter identity linked:** Every report carries `reporter_pubkey`, `reporter_wallet`, and `signature`. Mass-reporting attacks deterred — every report tied to reporter's wallet and reputation.

**Dismissed reports tracked:** When a report is dismissed or dismissed_malicious, the reporter's `dismissed_reports_count` is incremented. Leaders can review dismissal history on the members page.

**VoteOnReport endpoint (CO-231):**
```json
// Request
{ "vote": "uphold" | "dismiss" | "dismiss_malicious" }
// Response
{ "report_id": "uuid", "status": "pending" | "upheld_pending_tx", "votes_for": 1, "threshold": 1 }
```
- Voting threshold: `report_vote_threshold` org config (hub-enforced, NOT on-chain)
- When uphold votes >= threshold: status → `upheld_pending_tx`, leader sees "Submit to Chain" button
- When dismiss votes >= threshold: reporter's dismissed_reports_count incremented, status → `dismissed` or `dismissed_malicious`
- Leader can override and resolve immediately

**CommitReport endpoint (CO-233):**
```json
// Request
{
  "report_id": "uuid",
  "reason": "max 500 chars describing why the memory was harmful",
  "leader_signature": "base64-encoded signArbitrary output"
}
// Flow
1. Hub verifies leader wallet signature over canonical message: commit_report|{reportID}|{reason}
2. Hub calls chainClient.SubmitMemoryReport(reportID, reason, contributorWallet)
3. On TX confirmation: hub deletes memory from Qdrant, sets status → 'upheld'
4. On TX failure: status remains 'upheld_pending_tx', memory NOT deleted (atomic)
```

**Security config changes (CO-233):** `PATCH /v1/orgs/{orgID}/config` for `required_approvals` and `report_vote_threshold` requires leader wallet `signArbitrary` signature (not Ed25519 delegate key).

**Wallet signature verification (`internal/verify/wallet_sig.go`, CO-233):**
- `VerifyWalletSignature(walletAddress, signature, message []byte) error`
- Verifies secp256k1 signatures produced by Cosmos wallet `signArbitrary`
- Canonical message format: `{action}|{orgID}|{field1}|{field2}|...`
- Used for: report commitment, security config changes

## Observability Stack

- Structured logging via standard `log` package.
- No Prometheus metrics or Grafana dashboards yet.

## Security Boundaries

- Hub stores ciphertext + metadata only; no plaintext.
- All mutative endpoints require Ed25519 signatures via `WeVibe-Signed` header or request body `signature` fields.
- Chain transaction proxy verifies signatures and rate-limits by org membership.
- Admin endpoints (org creation, member removal, epoch rotation) require leader signature.

## Wallet & Identity Architecture

The hub supports linking a Cosmos wallet address to a member's Ed25519 delegate key. This enables on-chain reputation attribution — the wallet address serves as the chain-identity anchor while the delegate key handles daily hub authentication.

**Wallet linking endpoint:** `POST /v1/orgs/{orgID}/members/wallet` — links a Cosmos wallet address to the caller's member record. The request must be signed by the caller's Ed25519 delegate key (same `WeVibe-Signed` scheme). Canonical message: `link_wallet|{orgID}|{wallet_address}|{signed_by}`.

**Members table:** `wallet_address TEXT` — nullable, unique per `(org_id, wallet_address)`. One wallet per org membership; same wallet can be used across different orgs (portable identity).

### Delegate Key Registration (CO-214)

The hub maintains a mapping between wallet addresses and their authorized secp256k1 delegate keys (chain addresses authorized via Cosmos SDK `x/authz` MsgGrant).

**New endpoint:** `POST /v1/orgs/{orgID}/members/delegate-key` — registers a delegate key for the caller's wallet address. Must be signed by the caller's Ed25519 key. Canonical message: `echo.register_delegate_key.v1\norg_id:{orgID}\nwallet_address:{walletAddress}\ndelegate_address:{delegateAddress}\nsigned_by:{pubkeyHex}`.

**`delegate_keys` table schema:**
```sql
CREATE TABLE delegate_keys (
    wallet_address      TEXT        NOT NULL,
    delegate_address    TEXT        NOT NULL,
    org_id              TEXT        NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    delegate_pubkey     TEXT        NOT NULL,
    grant_tx_hash       TEXT,
    grant_expiration    TIMESTAMPTZ,
    active              BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (org_id, delegate_address),
    UNIQUE (org_id, wallet_address)
);
```
Indexes: `idx_delegate_keys_address` on `delegate_address`, `idx_delegate_keys_wallet` on `wallet_address`.

**Key functions in `internal/members/members.go`:**
- `RegisterDelegateKey(ctx, pool, orgID, req)` — inserts/updates delegate key record
- `GetDelegateKey(ctx, pool, orgID, delegateAddress)` — retrieves delegate key record
- `ResolveDelegateToWallet(ctx, pool, delegateAddress)` — resolves delegate address to wallet address and org ID (used for auth resolution in CO-215)
- `RevokeDelegateKey(ctx, pool, orgID, walletAddress)` — marks delegate key inactive

**Protocol types added:** `RegisterDelegateKeyRequest` (wallet_address, delegate_address, delegate_pubkey, grant_tx_hash, grant_expiration, signed_by, signature), `DelegateKeyRecord` (wallet_address, delegate_address, org_id, delegate_pubkey, grant_tx_hash, grant_expiration, active, created_at)
