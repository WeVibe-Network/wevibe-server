# WeVibe Hub Topology (Updated: CO-023)

## Relay Endpoint (CO-011a.4)

**Location:** `internal/relay/`

**Files:**
- `granter_fields.go` — Category B msg-type → `signer` proto field allowlist (`GranterFieldByMsgType`)
- `validator.go` — `ParseCanonicalBody`, `VerifyDelegateSignature`, `ExtractInnerGranter`
- `relay.go` — HTTP handler implementing `POST /v1/relay/broadcast`
- `relay_test.go` — unit tests for parser, validator, and handler

**Wiring (`cmd/wevibe-hub/main.go`):**
```go
relay.SetDeps(pool, chainClient, logger)
r.Post("/v1/relay/broadcast", relay.Handler)
```
This is a **top-level** route — it is NOT inside the `/v1/orgs/{orgID}` group and is NOT protected by `RequireOrgMembership`. Authentication is performed by the relay validator itself against the `delegate_keys` table.

### Route

```
POST /v1/relay/broadcast
Authorization: Delegate <base64-sig>
Content-Type: text/plain
```

**Auth header (Decision E):** `Authorization: Delegate <base64-sig>`. The signature is produced by the delegate key over the raw canonical body bytes.

**Body format (Decision F)** — read as raw bytes, parsed line-by-line:
```
WV-RELAY-v1\n
org_id:<value>\n
wallet_address:<value>\n
tx_bytes_base64:<value>\n
```
The literal `WV-RELAY-v1` magic line MUST appear first. No trailing or additional fields are accepted.

### Validator Flow

1. `ParseCanonicalBody(raw)` — verify magic line, extract `org_id`, `wallet_address`, `tx_bytes_base64`. Reject anything malformed → 400.
2. `VerifyDelegateSignature(header, rawBody, pool)` — base64-decode the `Authorization: Delegate` payload, look up the active delegate key by signature recovery, ensure `grant_expiration` is unexpired and `active=TRUE`. Failure → 401 (missing) or 403 (expired).
3. Decode the inner `sdk.Tx` from `tx_bytes_base64`. Reject non-`MsgExec` or multi-message envelopes — exactly one `MsgExec` is required → 400.
4. `ExtractInnerGranter(msgExec)` — read the granter field from the inner message via reflection against `GranterFieldByMsgType`. The granter MUST equal the `wallet_address` claimed in the body → 403 mismatch otherwise.
5. For each inner `Msg` inside the `MsgExec`, confirm its type URL is present in `GranterFieldByMsgType`. Anything outside the Category B allowlist → 400 disallowed-msg.
6. `chainClient.BroadcastTxSync(ctx, txBytes)` → return `{ tx_hash, code, raw_log }`. Broadcast error → 502.

### Category B Allowlist

`GranterFieldByMsgType` in `internal/relay/granter_fields.go` lists the 12 Category B message types. All of them use the proto field `signer` per Decision I:

```
/wevibe.memory.v1.MsgSubmitCommitment
/wevibe.memory.v1.MsgApproveMemory
/wevibe.memory.v1.MsgReportMemory
/wevibe.serve.v1.MsgSubmitServeBatch
/wevibe.serve.v1.MsgSubmitDenialBatch
/wevibe.org.v1.MsgRegisterOrg
/wevibe.org.v1.MsgAddMember
/wevibe.org.v1.MsgRemoveMember
/wevibe.org.v1.MsgSetOrgConfig
/wevibe.org.v1.MsgSetRepTiers
/wevibe.org.v1.MsgSetMemberCapabilities
/wevibe.org.v1.MsgRotateEpoch
```

Any message type not in this map is rejected by step 5 of the validator flow.

### Error Responses

| Status | Cause |
|--------|-------|
| 400 | Malformed canonical body, bad inner signature, disallowed inner msg type, multi-msg envelope, missing `MsgExec` |
| 401 | Missing or unparseable `Authorization: Delegate` header |
| 403 | Granter ≠ claimed wallet_address, or delegate grant expired / revoked |
| 502 | Chain `BroadcastTxSync` returned a transport or codespace error |

---

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

### Required Qdrant API credentials

- The hub loader (`internal/config/config.go`) now reads the API key from `QDRANT_API_KEY` and aborts on startup if the variable is missing or shorter than 32 characters.
- Docker Compose exports `QDRANT_API_KEY` from the developer-friendly `WEVIBE_QDRANT_API_KEY` variable so existing `.env` files continue to work.
- This guarantees both the hub runtime and its e2e tests use the same credential contract as `wevibe-mcp`, preventing accidental anonymous access after the Qdrant rename work in CO-001.

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
- `POST /v1/orgs` — create org (persists org + envelopes, then synchronously calls `RegisterOrgOnChain`)
- `GET /v1/orgs/{orgID}` — org info for discovery (D-12.7)
- `GET /v1/orgs/discover` — list/search public orgs (D-12.7, GAP-M4 CLOSED in Sprint 25)
- `POST /v1/orgs/{orgID}/join` — submit join request (D-12.8, GAP-M5 CLOSED in Sprint 25)
- `GET /v1/orgs/{orgID}/epoch/{epochID}/manifest` — needed by wevibe-mcp during setup flows
- `POST /v1/billing/topup` — billing (no org scoping)
- `POST /v1/relay/broadcast` — Category B `MsgExec` relay (CO-011a.4); auth via `Authorization: Delegate` header validated against `delegate_keys`

**User-scoped notification routes (WeVibe-Signed auth, not org-scoped):**
- `GET /v1/notifications` — list notifications for authenticated user (all orgs aggregated)
- `GET /v1/notifications/unread-count` — fast unread count
- `POST /v1/notifications/mark-read` — mark notifications as read
- `GET /v1/notifications/ws` — WebSocket endpoint for realtime push

## Client Surface

As of Sprint 26 / CO-260, `wevibe-mcp` is the single client for consumer-side hub operations (`query`/recall, serves, reports). The plugin no longer calls hub serves/report endpoints directly.

**Auth contract:** Hub auth is unchanged and remains `WeVibe-Signed` from the `wevibe-mcp` delegate. Plugin auth is a Bearer token to `wevibe-mcp` (D-12.5a).

**Scope boundary:** Dashboard continues to call hub directly for moderation/admin flows; the "single client" rule applies only to the consumer surface.

## Sprint 32 — CO-033b Serve + Members Corrections

### Pending submissions now surface `matched_keywords`

`GET /v1/orgs/{orgID}/submissions?status=pending_chain` (handler: `ListSubmissions` in `internal/api/handlers/keyword_extraction.go`) now includes `matched_keywords` on each returned submission row.

Implementation notes:
- `SubmissionRecord` includes `MatchedKeywords []string`.
- Query uses `LEFT JOIN LATERAL` to pull the latest serve event keywords from `serve_events` where `serve_events.serve_key = pending_submissions.submission_hash` and `event_type='serve'`.
- Empty result normalizes to `[]` (`COALESCE(..., ARRAY[]::TEXT[])`).

This is the dashboard chain-submit contract for CO-033b: there is no keyword proxy path.

### `ListMembers` column parity fix

`internal/members/members.go::ListMembers` SELECT now includes `dismissed_reports_count` to match `MemberRecord` and avoid missing-column scan mismatches.

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

### Moderation Queue Metadata

`GET /v1/orgs/{orgID}/moderation/queue` now includes moderation vote metadata for each pending item:

- `votes`
- `voter_pubkeys`

### Hub Org Creation (CO-023 update)

`CreateOrg` (`POST /v1/orgs`) now performs a synchronous two-step backend flow inside the handler:

1. Persist org + envelopes in Postgres.
2. Immediately call `chainClient.RegisterOrgOnChain(...)` with chain defaults (`storageQuota=1073741824`, `retrievalBudget=10000`).

If chain registration fails, `CreateOrg` returns 500 (no fallback path). This keeps org creation single-path and prevents the hub from accepting orgs that are absent on chain.

`orgs.chain_registered` remains watcher-owned: `processRegisterOrgBookkeeping` flips it to true after confirmed `MsgRegisterOrg` observation.

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

### Chain Config Read (GAP-O7, CO-011a.4 Update)

Only the **read-only** chain config endpoint remains:

- `GET /v1/orgs/{orgID}/chain-config` (leader-only) → returns `chain_id`, `chain_rpc_url`, `chain_grpc_url`, `chain_bech32_prefix`. This is a pure chain query — the hub does NOT mirror these fields off-chain.

**Handler:** `GetOrgChainConfig(w, r)` in `internal/api/handlers/chain_config.go`.

**Chain config writes (Decision C, CO-011a.4):** there is no hub-side write path for chain configuration. Category B chain config (`serve_attestation_required`, `min_contributions_per_epoch`, `contest_stake_vibe`, `rep_tiers`) is built by the dashboard and broadcast via the relay endpoint wrapping `MsgSetOrgConfig` / `MsgSetRepTiers`. The hub holds NO off-chain mirror of these fields.

**Category A vs Category B (Decision C):**

- **Category A** (off-chain mirror, hub-owned): *(none.)* The former `moderation_required` field and its `PATCH /v1/orgs/{orgID}/config` route + `UpdateOrgConfig` handler were REMOVED 2026-06-13 — moderation is always-on advisory keyed on the per-member `can_moderate` capability, with no per-org toggle (D-MODERATION-ADVISORY, amended). There is no remaining hub-owned off-chain org-config mirror.
- **Category B** (on-chain canonical): all fields listed above. Hub never writes these; the dashboard relays the appropriate `MsgSetOrgConfig` / `MsgSetRepTiers` through `POST /v1/relay/broadcast`.

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

**Status values:** `pending` → `pending_keyword` → `pending_chain` → `committed` (terminal); `denied` (terminal reject)

**Flow:**
1. **Contributor submits** (`pending`) — memory enters moderation queue
2. **Moderator approves** (`pending_keyword`) — moderator stamps quality, records `moderator_pubkey` and `approved_at`
3. **Leader triggers batch keyword extraction** (`pending_chain`) — LLM classifies per-memory against org vocabulary, hub verifies
4. **Leader reviews/curates results** — selects/deselects keywords (default all-selected; selected = will commit), edits, or removes before chain commitment (re-run extraction was removed in CANONICALUX v1.2)
5. **Leader triggers batch chain submission** (`pending_chain`) — chain tx is broadcast; status stays `pending_chain` until confirmation
6. **ChainWatcher confirms tx** (`committed`) — `processApproveMemoryBookkeeping` performs Qdrant upsert/keyword writes and flips status to `committed`
7. **Memory rejected at any stage** (`denied`) — terminal state; leader deny or report upheld

**Vote flow:** Moderators cast approval votes on `pending` submissions. When quorum is reached (or leader override), status transitions to `pending_keyword`. Only `pending` submissions are votable — `pending_keyword`, `pending_chain`, `committed`, and `denied` block further voting.

**Schema updates (CO-238, CO-020, CO-030):**
```sql
-- pending_submissions additions
status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'pending_keyword', 'pending_chain', 'committed', 'denied', 'ready', 'approved'))
moderator_pubkey TEXT           -- moderator who approved
approved_at TIMESTAMPTZ          -- when approved
extraction_result JSONB         -- hub-verified keywords + scores
extraction_feedback TEXT         -- leader feedback on extraction (legacy; re-run removed)
verified_at TIMESTAMPTZ          -- when keywords were verified
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

PUT /v1/orgs/{orgID}/submissions/{hash}/update-keywords
  → Persists the leader's curated keyword selection (resets to pending_keyword)

DELETE /v1/orgs/{orgID}/submissions/{hash}
  → Remove submission (only pending_keyword or pending_chain)

GET /v1/orgs/{orgID}/submissions?status={status}
  → List submissions filtered by status (leader-only)
```

**Verification rules (in verify-keywords and update-keywords):**
- Each classified keyword matches `^[a-z][a-z0-9_]{1,39}$`
- **No vocabulary gate.** The leader may commit any well-formed keyword — there is NO check that a keyword already exists in `org_keywords`. New keywords (and re-used previously-deprecated ones) join/re-activate the org vocabulary at commit time (vocab-join-at-commit: the ChainWatcher's `processApproveMemoryBookkeeping` upserts `org_keywords ON CONFLICT DO UPDATE SET deprecated=false` immediately before the `memory_keywords` write, satisfying the FK). The leader is the sole sovereign curator; keyword UX is one-direction (select = add).
- Count of classified keywords ≤ 20
- Sum of classified keyword weights ≈ 1.0 (tolerance: |sum - 1.0| < 0.02)
- Memory plaintext length ≤ 2000 chars
- No pending suggestions remain (all must be approved/rejected before verification)

### Multi-Memory Chain Commitment (CO-011a.4, finalized CO-049)

Stage 3 of the pipeline (atomic batch chain commitment) is a **hub-side handler**:
`BatchSubmitToChain` (`internal/api/handlers/moderation.go:633`), routed at
`POST /v1/orgs/{orgID}/moderation/batch-submit` (`cmd/wevibe-hub/main.go:225`, leader-only).
It:
1. Loads each `pending_chain` submission, decodes and length-checks the four signed
   commitments (`plaintext_hash`, `salt`, `ciphertext_hash`, `contributor_sig`).
2. **Parses `extraction_result` JSONB** into `extractionPayload` and rebuilds the
   per-memory `KeywordWeight` list.
3. **Validates keyword weights**: every classified keyword non-empty and unique, count
   ≤ `protocol.MaxKeywordsPerMemory`, weights finite, and `|Σweight − 1.0| ≤
   protocol.KeywordWeightTolerance`.
4. Assembles `chain.BatchMemory` entries. `SubmittedMemoryType` / `ApprovedMemoryType`
   are string fields set to the DB `"memory"` value (single-type model, D-5.1) — they do
   not touch the chain enum directly.
5. Calls `chainClient.SubmitMemoryBatchAtomic(ctx, pool, faucetURL, orgID, memories)`
   (`internal/chain/submit.go:44`) with `faucetURL` read from the `FAUCET_URL` env. The
   batch is broadcast as a single leader-signed atomic transaction; gas is **faucet-funded**
   (the hub's leader chain key is topped up by the `wevibe-faucet` service — see
   wevibe-infra topology). On success a real on-chain `tx_hash` is returned; status stays
   `pending_chain` until the ChainWatcher confirms.

Post-confirmation bookkeeping (Qdrant insert, `memory_keywords` population,
`pending_submissions.status → committed`) is performed by the ChainWatcher's
`processApproveMemoryBookkeeping` handler.

**Memory-type enum mapping (CO-049):** the protocol string `"memory"`
(`protocol.MemoryTypeMemory`) maps to the chain enum via `mapMemoryTypeToChainEnum`
(`internal/chain/submit.go`), which returns `memorytypes.MemoryType_MEMORY_TYPE_MEMORY`
(invalid types are a hard error, not a silent fallback — R-ONE-PATH). The inverse,
`mapChainMemoryTypeToString` (`internal/chain/query.go:386`), maps
`MemoryType_MEMORY_TYPE_MEMORY → "memory"`. The retired
`MEMORY_TYPE_CORRECT_IMPLEMENTATION` / `MEMORY_TYPE_NEGATIVE_SIGNAL` enum values are
gone from both directions.

**Org Health endpoint:**
```
GET /v1/orgs/{orgID}/health (leader-only)
→ Returns: last_batch_extraction_at, last_chain_submission_at, pending_keyword_count, pending_chain_count
```
The `last_chain_submission_at` field is now updated by the ChainWatcher when `MsgApproveMemory` confirms, not by a hub handler.

## Moderation Queue (CO-238 update)

**GET /v1/orgs/{orgID}/moderation/queue** now returns only `status = 'pending'` submissions.

**Queue metadata (CO-265):** each queue item includes `votes` and `voter_pubkeys` so clients can render advisory voting state.

**Vote endpoint:** `POST /v1/orgs/{orgID}/moderation/{submissionHash}/vote` casts a moderator/leader approval vote and returns vote tallies `{ approve, flag }`.

**ApproveSubmission handler (CO-238):**
- Simplified to only change status to `pending_keyword` and record moderator
- Removed: keyword extraction, embedding computation, Qdrant insert, chain TX at approval time
- Canonical message: `wevibe.approve_submission.v2` (simpler format without keywords/capsule)

## Qdrant Chain Parity (CO-224)

### Retrieval Architecture

Chain is the authority for retrieval metadata (`keyword_weights`, `state`).
Hub mirrors that metadata into Qdrant for fast lookup and ranking.

**Qdrant payload fields (approved memories):**
- Required: `cid`, `org_id`, `epoch_id`, `content_flags`, `keyword_weights`, `lifecycle_state`, `memory_type`
- Optional embedding metadata: `embedding_model_id`, `embedding_schema_version`, `vector_dim`

**Keyword lifecycle:**
- `UpsertPoint` writes `keyword_weights` from `IndexEntry.Keywords` at approval time
- `UpdateMemoryKeywords` is restored and used by merge/rename keyword handlers
- PostgreSQL `memory_keywords` remains the write-ahead cache; Qdrant is the retrieval cache

**State lifecycle:**
- `UpsertPoint` writes initial lifecycle data at approval (`lifecycle_state=ACTIVE`)
- `UpdateMemoryState` updates payload by (`org_id`, `cid`) via Qdrant `set_payload`
- `SyncEpochData` (`internal/chain/sync.go`) polls chain gRPC each interval and reconciles lifecycle deltas

**Query behavior (`QueryPoints`):**
- Always excludes `ARCHIVED`
- Excludes `DORMANT` by default; caller can include via `include_dormant=true`
- Ranks with D-9.4 flow:
  - `raw_score = vector_similarity + keyword_overlap_boost*0.1`
  - `optimistic_score = max(0, raw_score - pending_denial_count*0.05)`
  - `query_score = optimistic_score * (1 + boostMult * max(0, 1 - age/window))`, where `window = grace + boostWindow`
  - position 1 is strict argmax by `query_score`; positions 2..N are sampled without replacement with tempered power-law weights `w_i = (score_i/score_max)^(1/T)`
- Runtime tuning env vars: `RETRIEVAL_TEMPERATURE` (default `0.7`), `RETRIEVAL_NEW_MEM_BOOST_MULT` (default `0.5`), `RETRIEVAL_NEW_MEM_BOOST_WINDOW` (default `30`)
- Uses Qdrant payload metadata directly (no PostgreSQL keyword read on query path)

**Scroll behavior (`ScrollApprovedMemories`):**
- Reads keyword/lifecycle metadata from Qdrant payload
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

## Matched Keyword Persistence (CO-033a)

Hub persists the per-serve matched-keyword set — the intersection of the served memory's keywords and the query's keyword set — on every `serve_events` row. Sim source: `wevibe-sim/ranking-fix.js:184`. Chain side: `wevibe-chain/x/serve/types/msgs.go:32-34` rejects empty sets per D-4.2 Implementation Clarifications (DMO-007) since CO-031 Rev 2.

**Schema (`serve_events`):**
- `matched_keywords TEXT[] NOT NULL` (defined directly in `db/schema.sql`; this repo has no migration files). No default — every INSERT must supply the value explicitly. Pre-MVP wipe required per D-13.9 when applying against a non-empty table; dogfood resets state via `docker compose down -v` in `wevibe-meta/Makefile`.

**Write path (`internal/serves/serves.go`):**
- `RecordServe` (POST `/v1/orgs/{orgID}/serves`): client supplies `matched_keywords []string` (required). `normalizeMatchedKeywords` lowercases, trims, and dedupes; rejects empty / nil / whitespace-only input. The canonical slice is written into `serve_events.matched_keywords`. The handler at `internal/api/handlers/serves.go:81-86` catches the "matched_keywords" substring in validation errors and returns HTTP 400.
- `RecordDenial` (POST `/v1/orgs/{orgID}/denials`): supplies `'{}'::TEXT[]` literal because denial-side matched_keywords is out of CO-033a scope (chain `DenialEntry` proto has no `matched_keywords` field at chain commit 533d18b). CO-033b may add denial matched_keywords if a chain proto change lands.

**Read path:**
- `protocol.MemoryResult.MatchedKeywords []string` (json `matched_keywords,omitempty`) — populated at retrieval time. `internal/retrieval/retrieval.go QueryPoints` extracts the matched-keyword details returned by `computeKeywordScore`, lowercases/trims/dedupes, sorts deterministically, and drops the candidate when the query supplied keywords but the intersection is empty (consistent with the sim's `applyNewMemoryBoost` base==0 short-circuit).
- All `serve_events` SELECTs (`GetPendingServes`, `GetPendingDenials`, `GetServeEventByNullifier`, the post-INSERT SELECTs inside `RecordServe` / `RecordDenial`) scan `matched_keywords` into `ServeEventRecord.MatchedKeywords`.

**Chain submission gap (CO-033b territory):**
- No production code currently broadcasts `MsgSubmitServeBatch`. `internal/chain/submit.go:SubmitServeBatch` exists as a typed wrapper but has no caller (per WHITEPAPER.md:72 the broadcaster is the dashboard via the relay endpoint per CO-011a.4, but the dashboard caller is still unimplemented — `wevibe-server/wevibe-dashboard/app/(dashboard)/chain-submit/page.tsx:212` shows the stub). CO-033b builds: (1) `wevibe-protocol` JS bindings regen so `ServeEntry.matchedKeywords` exists on the wire, (2) the dashboard `MsgSubmitServeBatch` caller, (3) MCP + opencode-plugin payload updates so `POST /v1/serves` includes `matched_keywords`, (4) the empirical replay harness that measures chain.gap against sim.

**Side fix (CO-033a):** `RecordServe` previously wrote `NULL` to `reason` but the post-INSERT SELECT scanned into a non-pointer string field, raising "cannot scan NULL into *string". Fix: write `''` (empty string) on serve INSERT. R-ONE-PATH: one canonical empty value, no NULL/'' duality. No call site depended on the NULL semantic (`rg "reason IS NULL"` returned zero).

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

- **PostgreSQL** — orgs, members (including `pre_pubkey`), epoch manifests (including `umbral_pk`), pending submissions (including `umbral_capsule`, `umbral_ciphertext`, and `banned`), moderation queue, audit log, credit ledger, key envelopes, recovery shares, dashboard keys, delegate keys, keyword vocabulary, serve_events (with `event_type IN ('serve', 'denial')`, `reason` column, and `matched_keywords TEXT[] NOT NULL` column added by CO-033a migration 000005), reports (with `resolution` tracking), wallet addresses (nullable, unique per org).
- **Qdrant** — vector index + chain-mirrored retrieval metadata for approved memories (`keyword_weights`, `lifecycle_state`, `memory_type`) used for filtering/ranking.
- **Object storage** (optional) — ciphertext blobs referenced by CID.

## Chain Client (`internal/chain/`)

- **grpc_client.go** — `GrpcClient` struct holds gRPC connection, codec, keyring, tx config, and query clients for all 7 wevibe-chain modules.
- **query.go** — nil-safe wrappers: org registration checks, merkle root queries, serve stats, attestation lookups, bandwidth state, emissions params, reputation stats.
- **broadcast.go** — `BroadcastTx` and `BroadcastTxSync` sign and broadcast transactions to wevibe-chain via Comet RPC `broadcast_tx_sync` (D-13.12). Fees: `ceil(gas × 0.01 uvibe)` with 2000 uvibe floor. Retry on transient errors (8 attempts, 400ms backoff). `BroadcastTxSync` is invoked by the relay endpoint to relay dashboard-signed `MsgExec`-wrapped Category B messages.
- **submit.go** — hub-side chain transaction helpers, including `RegisterOrgOnChain` (used by `CreateOrg` in CO-023) and batch/report helper builders used by moderation and reporting flows.
- **merkle.go** — binary SHA-256 Merkle tree for epoch root computation.
- **sync.go** — `SyncEpochData` polling loop logic: compares chain confidence/state to Qdrant payload and updates changed records.
- **cometbft_subscriber.go** — CometBFT RPC subscriber for new block events, consumed by the ChainWatcher.

CometBFT RPC is consumed by ChainWatcher via `CometBFTSubscriber`; node URL is sourced from `WEVIBE_CHAIN_RPC_URL` (fallback `tcp://localhost:26657`).

### Two-key per-org gas model (CO-047, D-S32-CO044-KEY-SEPARATION)

Each org has **two** hub-held, HD-derived, faucet-funded chain keys (not one). They carry distinct on-chain authorities and are independently revocable:

| Role (`chain.OrgKeyRole`) | Keyring UID | Signs | On-chain registration |
|---|---|---|---|
| `OrgKeyServing` (`"serving"`) | `org-serving-{orgID}` | `MsgSubmitServeBatch`, `MsgSubmitDenialBatch` | `HubServingAddress` |
| `OrgKeyLeader` (`"leader"`) | `org-leader-{orgID}` | `MsgSubmitCommitment`, `MsgApproveMemory`, `MsgRegisterOrg` (and `MsgReportMemory` if ever hub-submitted) | `LeaderWallet` |

- Both keys are HD-derived from the hub master mnemonic at distinct indices (`m/44'/118'/0'/0/{account_index}`), each index drawn from `org_account_index_seq`.
- `org_chain_accounts` is **role-keyed**: PK `(org_id, key_role)`, `key_role CHECK IN ('serving','leader')`, one `account_index UNIQUE` per row, and `funded BOOLEAN` (now truthful — set TRUE by `MarkOrgAccountFunded` after each faucet fund).
- `accounts.go`: `DeriveOrgAccount(orgID, idx, role)`, `EnsureOrgAccount(ctx, db, orgID, role)`. `grpc_client.go`: `GetOrgSigner(ctx, db, orgID, role)` caches per `"{orgID}:{role}"`. `broadcast.go`: role-aware entrypoints `BroadcastMsgsForOrgServing` / `BroadcastMsgsForOrgServingCommit` / `BroadcastMsgsForOrgLeader` (the old role-less `BroadcastMsgsForOrg`/`...Commit` were removed). `submit.go` binds each message type to its authority.
- `handlers.CreateOrg` ensures + faucet-funds BOTH keys (`TOPUP_AMOUNT` uvibe each), marks both funded, then `RegisterOrgOnChain(... servingAddr /*hub_serving_key*/, leaderAddr /*leader_wallet*/ ...)`. The response surfaces `hub_serving_key_address` and `leader_wallet_address`.
- The chain required **no change**: `x/org` already separates `HubServingAddress` (`x/serve requireServingKeySigner == GetServingAddress`) from `LeaderWallet` (`x/memory requireLeaderWallet == GetLeaderWallet`); `MsgRegisterOrg` carries both `hub_serving_key` and `leader_wallet`, and `x/org/keeper/msg_server.go` persists both. The prior single-key conflation (one `org-serving-*` key registered as both authorities) was a hub-only bug, fixed in CO-047.

### Subscription credit model (CO-047, D-3.1 / GAP-O6)

Org credits are **hub-internal accounting only**. There is **no per-query credit deduction** (the obsolete `DeductQueryCredit` / `QueryCost` path was removed in CO-047). Recall access is gated by a boolean.

- `members.membership_active BOOLEAN NOT NULL DEFAULT FALSE` — the subscription gate, distinct from `active` (org-membership soft-delete). Recall (`QueryMemories`) requires `membership_active = TRUE` for **non-trial** members; trial members remain governed by the orthogonal trial path (expiry + daily limit).
- `billing.ProvisionOrgLedger(ctx, pool, orgID, initialBalance, actor)` — seeds the org pool from `fee_model.monthly_credits` at org creation, recording a `subscription_grant` transaction when the grant is > 0. Called by `orgs.CreateOrg` (replaces the removed `EnsureOrgLedger`). The leader member is created `membership_active = TRUE` and is NOT debited (owns the pool).
- `billing.Subscribe(ctx, pool, orgID, memberPubkey, actor)` — single atomic tx: `SELECT balance FOR UPDATE`, explicit `balance < SubscriptionCost` check → `ErrInsufficientCredits` (does not rely on the `org_credits_balance_check` constraint), debit `SubscriptionCost` (=10) + `lifetime_used`, set `membership_active = TRUE`, record a `subscription` transaction.
- Admission calls `Subscribe`: `handlers.InviteMember` (after invite) and `handlers.ApproveJoinRequest` (non-trial admissions only). `ErrInsufficientCredits` → HTTP 402; the member row is kept inactive (not rolled back).
- `members.GetMember` returns `membership_active` (on `protocol.MemberRecord`, `db:"-"`).

## ChainWatcher (CO-011a.3, CO-011a.4 Activated)

The ChainWatcher detects confirmed transactions on-chain and performs post-confirmation bookkeeping. As of CO-011a.4 it is the **canonical** bookkeeping path for all 5 confirmed-tx handlers — no API handler runs bookkeeping eagerly at submission time.

**Startup wiring (`cmd/wevibe-hub/main.go`):** the watcher is constructed with a tx decoder derived from `GrpcClient` codec and started in a goroutine AFTER dispatcher setup and BEFORE router registration:

```go
txDecoder := chain.BuildTxDecoder(chainClient.GetCodec())
watcher := chain.NewChainWatcher(chainClient, pool, slog.Default(), txDecoder, notifHub, qdrantClient, cfg.OllamaURL)
go func() {
    if err := watcher.Start(ctx); err != nil {
        log.Printf("ERROR: chain watcher exited: %v", err)
    }
}()
// ... router setup follows
```

### Tx Decode Path (CO-023)

`internal/chain/watcher.go` now wires decode in one path:

- `BuildTxDecoder(cdc codec.Codec)` builds Cosmos tx decoder via `authtx.NewTxConfig(cdc, authtx.DefaultSignModes)`.
- `sdkTxAdapter` adapts `sdk.Tx.GetMsgs() []sdk.Msg` into watcher `TxInterface.GetMsgs() []interface{}`.
- `processTx` fail-fast guard returns an error if `txDecoder` is nil.

Dispatch chain:

`processBlock -> processTx -> txDecoder(txBytes) -> decoded.GetMsgs() -> type switch`

Bookkeeping handlers triggered from the dispatch switch:

- `processApproveMemoryBookkeeping`
- `processServeBatchBookkeeping`
- `processDenialBatchBookkeeping`
- `processReportBookkeeping`
- `processRegisterOrgBookkeeping`

### File Inventory

```
internal/chain/watcher.go            — ChainWatcher struct, Start(), catchUp(), processTx(), existing handlers
internal/chain/watcher_memory.go     — processApproveMemoryBookkeeping()
internal/chain/watcher_serve.go      — processServeBatchBookkeeping(), processDenialBatchBookkeeping()
internal/chain/watcher_report_org.go — processReportBookkeeping(), processRegisterOrgBookkeeping()
```

### Handler Coverage Table

| Msg Type | Handler | Bookkeeping |
|---------|---------|-------------|
| `MsgApproveMemory` | `processApproveEvent` + `processApproveMemoryBookkeeping` | Qdrant upsert, memory_keywords, pending_submissions status, orgs timestamp, approval_votes cleanup |
| `MsgSubmitCommitment` | companion data extraction only | Extracts keywords/contributor_id/wallet for MsgApproveMemory bookkeeping |
| `MsgReportMemory` | `processReportEvent` + `processReportBookkeeping` | reports status → upheld, Qdrant delete, pending_submissions ban |
| `MsgSubmitServeBatch` | `processServeBatchBookkeeping` | serve_events marking, keyword weight boost, Qdrant sync |
| `MsgSubmitDenialBatch` | `processDenialBatchBookkeeping` | serve_events marking, keyword weight decay, Qdrant sync |
| `MsgRegisterOrg` | `processRegisterOrgBookkeeping` | orgs chain_registered = true |
| `MsgSubmitCommitment` | debug log only | No bookkeeping (reputation handled by chain) |
| `MsgIncrementContribution` | debug log only | No bookkeeping (chain-side) |
| `MsgIncrementServe` | debug log only | No bookkeeping (chain-side) |
| `MsgRecordBan` | debug log only | No bookkeeping (chain-side) |
| `MsgSetOrgConfig` | debug log only | No bookkeeping (chain-side) |
| `MsgSetRepTiers` | debug log only | No bookkeeping (chain-side) |

### Dependencies

- **Qdrant client:** `*retrieval.QdrantClient` — injected via `NewChainWatcher`; used for upsert, delete, and keyword weight sync
- **Embedding service:** `embedURL` string (default `"http://localhost:11434"`) — used to compute memory embeddings at commit time
- **PostgreSQL:** `*pgxpool.Pool` — direct SQL for all bookkeeping operations

### catchUp Mechanism

`Start()` reads `lastHeight` from the `watcher_state` table. If `lastHeight > 0`, it calls `catchUp(ctx, lastHeight)` before subscribing to new blocks. `catchUp()` iterates blocks from `lastSeen+1` to current height and calls `processTx()` for each transaction — ensuring missed blocks between shutdown and restart are backfilled.

The `watcher_state` table is the restart-safe cursor for this watcher and is defined in `db/schema.sql` (single source of truth — no migrations): one row keyed by `watcher_name` (`TEXT PRIMARY KEY`), with `last_seen_block_height BIGINT` and `updated_at TIMESTAMPTZ`. A seed row `('chain_watcher', 0)` is INSERTed by the schema so `updateLastSeenBlock` (an UPDATE, not an upsert) at the end of every `processBlock` always affects exactly one row. Prior to CO-047 this table was absent from the consolidated schema, so every `processBlock` errored `relation "watcher_state" does not exist` (SQLSTATE 42P01) and the cursor never advanced; CO-047 added the table + seed row.

### Struct Fields (ChainWatcher)

```go
type ChainWatcher struct {
    chainClient   *GrpcClient
    db            *pgxpool.Pool
    logger        *slog.Logger
    subscriber    *CometBFTSubscriber
    txDecoder     TxDecoderFunc
    notifHub      *notifications.NotificationHub
    dispatcher    *notifications.Dispatcher
    qdrantClient  *retrieval.QdrantClient
    embedURL      string
}
```

### Activation Note (CO-011a.4)

The ChainWatcher is STARTED in `cmd/wevibe-hub/main.go`. It runs continuously alongside the HTTP server and is the SOLE owner of post-confirmation bookkeeping for the 5 Category B handlers:

- `processApproveMemoryBookkeeping`
- `processServeBatchBookkeeping`
- `processDenialBatchBookkeeping`
- `processReportBookkeeping`
- `processRegisterOrgBookkeeping`

All previous API-handler-side eager Category B broadcasting paths from the hub have been removed in CO-011a.4. The dashboard now relays the corresponding `MsgExec`-wrapped Category B message via `POST /v1/relay/broadcast`; the watcher closes the loop on confirmation.

### Test-mode endpoints (CO-023)

With real watcher pipeline wiring in place, the test-only force-commit bypass was removed.

Current test-mode routes:

- `GET /v1/test/health`
- `POST /v1/test/embed`
- `GET /v1/test/orgs/{orgID}/queue`

Removed route:

- `POST /v1/test/orgs/{orgID}/force-commit`

## API Components

- REST router: Chi (`go-chi/chi/v5`).
- CORS configurable via `CORS_ALLOWED_ORIGINS` env var.
- No WebSocket hub yet — all real-time updates are client-poll.

## Retrieval & Trust System (Sprint 28)

- `POST /v1/orgs/{orgID}/query` returns memory candidates enriched with trust stats.
- Query scoring uses a two-step ranking formula:
  - `raw_score = vector_similarity + (keyword_overlap_boost * 0.1)`
  - `optimistic_score = max(0, raw_score - (pending_denial_count * 0.05))`
  - `query_score = optimistic_score * (1 + boostMult * max(0, 1 - age/window))`, where `window = grace + boostWindow`
  - position assignment: strict top-1, then tempered power-law sampling for positions 2..N using `(score_i/score_max)^(1/T)`
- `pending_denial_count` is computed from `serve_events` rows where `event_type='denial'` and `status='pending'`, grouped by `memory_content_hash` for the candidate CIDs returned by Qdrant.
- `DenialDecayBPS` is a hardcoded retrieval constant: `500` (0.05 per pending denial).
- Retrieval tuning is configured by env vars: `RETRIEVAL_TEMPERATURE=0.7`, `RETRIEVAL_NEW_MEM_BOOST_MULT=0.5`, `RETRIEVAL_NEW_MEM_BOOST_WINDOW=30` (with `grace=20` giving `window=50`).
- This optimistic adjustment is load-bearing per D-2026-05-25-A: denial impact appears at query time immediately, then naturally disappears from pending counts when watcher bookkeeping flips rows to `status='submitted'`.
- Retrieval lifecycle tiers are enforced in Qdrant filtering: `ARCHIVED` is hard-excluded, `DORMANT` is hidden by default and only included when requested.
- Every result includes `retrieval_count`, `acceptance_count`, and `contributor_stats` (account age, contributions, reports upheld, false reports against).
- Trust panel formatting is handled client-side by wevibe-mcp via `trust-panel.ts`.
- **Banned memories filtered:** Results exclude memories where `pending_submissions.banned = TRUE`.
- **No quarantine system:** Memories are never auto-removed based on rejection counts.
- Report votes are advisory only; there is no org-level auto-ban threshold.
- `GET /v1/orgs/{orgID}/memories` (`ScrollApprovedMemories`) sources keyword/lifecycle metadata from Qdrant payload (chain mirror), not PostgreSQL keyword joins.

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

## Denial Event Recording (CO-225, CO-013)

Hub records denial events (incorrect/harmful memory outputs reported by consumers) in `serve_events` and exposes leader-facing pending-denial APIs for denial-batch submission.

**Endpoints:**
- `POST /v1/orgs/{orgID}/denials` (`RecordDenialEvent`) — records one denial event (`status='pending'`)
- `GET /v1/orgs/{orgID}/denials/pending-count` (`GetPendingDenialCount`) — returns `{ "pending_count": N }`
- `GET /v1/orgs/{orgID}/denials/pending` (`GetPendingDenials`) — leader-only, returns `{ "denials": [...], "total_count": N }`

**`serve_events` denial fields used by CO-013:**
- `memory_content_hash` — memory identifier used for optimistic denial counting
- `event_type` — `serve | denial`
- `status` — `pending | submitted | failed`
- `nullifier`, `reason`, `created_at`

**Flow:**
1. Consumer denial is recorded by `POST /v1/orgs/{orgID}/denials`.
2. Retrieval query path computes pending counts from `serve_events` (`event_type='denial'`, `status='pending'`) and applies optimistic decay to candidate memory scores.
3. Leader dashboard reads:
   - `GET /v1/orgs/{orgID}/denials/pending-count`
   - `GET /v1/orgs/{orgID}/denials/pending` (ordered by `created_at DESC`, capped at 200 rows, includes `total_count`).
4. Leader submits denial batch on-chain.
5. `processDenialBatchBookkeeping` updates matching rows to `status='submitted'`; pending counts naturally drop and optimistic decay clears for settled denials.

**Serve attestation parity:** serve and denial events share the same `serve_events` ledger/status lifecycle and are reconciled by watcher bookkeeping after on-chain confirmation.

**Route registration (`cmd/wevibe-hub/main.go`):**
- `POST /v1/orgs/{orgID}/denials`
- `GET /v1/orgs/{orgID}/denials/pending-count`
- `GET /v1/orgs/{orgID}/denials/pending`

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
{ "vote_count_uphold": 1, "vote_count_dismiss": 0, "vote_count_dismiss_malicious": 0, "status": "pending" }
```
- Report votes are advisory tallies stored in `report_votes`; no org-level quorum field is enforced.
- Final resolution is applied through report resolution actions (`PATCH /v1/orgs/{orgID}/reports/{reportID}` / commit flow).

**CommitReport endpoint (CO-233, CO-011a.4 Update):**
```json
// Request
{
  "report_id": "uuid",
  "reason": "max 500 chars describing why the memory was harmful",
  "leader_signature": "base64-encoded signArbitrary output"
}
```

**Flow (CO-011a.4):**
1. Hub verifies leader wallet signature over canonical message: `commit_report|{reportID}|{reason}`.
2. Hub records the resolution and off-chain vote tally; status transitions remain hub-managed.
3. **Chain broadcast is the dashboard's responsibility.** The dashboard relays `MsgReportMemory` via `POST /v1/relay/broadcast`. The previous `chainClient.SubmitMemoryReport` call from inside the hub handler was **DELETED** in CO-011a.4.
4. On TX confirmation, the ChainWatcher's `processReportBookkeeping` handler deletes the memory from Qdrant, marks `pending_submissions.banned = TRUE`, and sets the report status to `'upheld'`.
5. On TX failure (non-confirmation), the watcher takes no action; status remains `'upheld_pending_tx'` and the memory is NOT deleted (atomic via watcher gating).

**Config changes:** the `PATCH /v1/orgs/{orgID}/config` route + `UpdateOrgConfig` handler were REMOVED 2026-06-13 (its only field, `moderation_required`, is gone — moderation is always-on advisory). There is no remaining hub-side org-config mutation route; all org config is on-chain (Category B) via dashboard-direct CosmJS.

**Wallet signature verification (`internal/verify/wallet_sig.go`, CO-233):**
- `VerifyWalletSignature(walletAddress, signature, message []byte) error`
- Verifies secp256k1 signatures produced by Cosmos wallet `signArbitrary`
- Canonical message format: `{action}|{orgID}|{field1}|{field2}|...`
- Used for: report commitment

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

### Delegate Key Registration (CO-214, CO-011a.4 Update)

The hub maintains a **global** (per-wallet, NOT per-org) mapping between wallet addresses and their authorized secp256k1 delegate keys (chain addresses authorized via Cosmos SDK `x/authz` MsgGrant). Per Decision H (CO-011a.4), the previous `org_id` column and its FK to `orgs` were dropped — a wallet's delegate is the same across every org it participates in.

**Endpoint:** `POST /v1/members/delegate-key` — registers a delegate key for the caller's wallet address. Must be signed by the caller's Ed25519 key. Canonical message: `wevibe.register_delegate_key.v1\nwallet_address:{walletAddress}\ndelegate_address:{delegateAddress}\nsigned_by:{pubkeyHex}`. The wire-level payload of `RegisterDelegateKeyRequest` is **unchanged** — it never carried an `org_id` field at the request body level.

**`delegate_keys` table schema (CO-011a.4):**
```sql
CREATE TABLE delegate_keys (
    wallet_address      TEXT PRIMARY KEY,
    delegate_address    TEXT UNIQUE NOT NULL,
    delegate_pubkey     TEXT NOT NULL,
    grant_tx_hash       TEXT,
    grant_expiration    TIMESTAMPTZ,
    active              BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_delegate_keys_delegate_address ON delegate_keys(delegate_address);
```

The `org_id` column and its FK to `orgs` were **dropped** in CO-011a.4. `wallet_address` is now the primary key — one active delegate per wallet across the entire hub.

**Key functions in `internal/members/members.go` (CO-011a.4 signatures):**
- `RegisterDelegateKey(ctx, pool, req)` — `orgID` parameter removed.
- `GetDelegateKey(ctx, pool, delegateAddress)` — `orgID` parameter removed; returns `DelegateKeyRecord` without an `OrgID` field.
- `ResolveDelegateToWallet(ctx, pool, delegateAddress) (walletAddress string, err error)` — return signature dropped the `orgID`; only `walletAddress` and `error` are returned.
- `RevokeDelegateKey(ctx, pool, walletAddress)` — `orgID` parameter removed.

**Protocol types (CO-011a.4):**
- `DelegateKeyRecord` — fields: `wallet_address`, `delegate_address`, `delegate_pubkey`, `grant_tx_hash`, `grant_expiration`, `active`, `created_at`. **No `OrgID` field.**
- `RegisterDelegateKeyRequest` — wire-level payload unchanged: `wallet_address`, `delegate_address`, `delegate_pubkey`, `grant_tx_hash`, `grant_expiration`, `signed_by`, `signature`. No `org_id` field at the wire level (this matches the pre-CO-011a.4 contract).

## Signed Canonical Body — Submit & Batch Pathway (CO-029)

### Contributor submission contract

`POST /v1/orgs/{orgID}/submit` and `POST /v1/orgs/{orgID}/submit/batch` accept the expanded `SubmitMemoryRequest`:

```jsonc
{
  "org_id":             "...",
  "epoch_id":           0,
  "memory_type":        "memory",
  "ciphertext":         "<hex of encrypted memory bytes>",
  "wrapped_dek_mod":    "<hex of moderator-wrapped DEK>",
  "submission_hash":    "<hex sha256(ciphertext || wrapped_dek_mod)>",
  "contributor_pubkey": "<hex Ed25519 32 bytes>",
  "contributor_sig":    "<hex Ed25519 signature over 9-field canonical body>",
  "stack_hint":         ["..."],
  // CO-029 additions:
  "plaintext_hash":     "<hex sha256(salt || plaintext_utf8), 64 chars>",
  "salt":               "<hex 32 random bytes, 64 chars>",
  "ciphertext_hash":    "<hex sha256(ciphertext), 64 chars>",
  "wrapped_dek_hash":   "<hex sha256(wrapped_dek_mod), 64 chars>"
}
```

The `plaintext` field has been REMOVED from `SubmitMemoryRequest` entirely (per R-ONE-PATH and D-VR-7). The hub never sees plaintext; only the salted hash plus the contributor's signed binding.

### Canonical body (9 fields, alphabetical after domain tag)

```
wevibe.submit_memory.v1
ciphertext_hash:<hex>
contributor_pubkey:<hex>
epoch_id:<int>
memory_type:<memory>
org_id:<string>
plaintext_hash:<hex>
salt:<hex>
submission_hash:<hex>
wrapped_dek_hash:<hex>
```

Implemented in `internal/verify/canonical.go` as `SubmitMemoryMessage`. The builder is byte-identical to the MCP TypeScript builder (`wevibe-mcp/src/canonical.ts`) and the dashboard WebCrypto builder (`wevibe-server/wevibe-dashboard/lib/wevibe-signing.ts`). Cross-language conformance is locked by `internal/verify/canonical_test.go::TestCanonicalBodyCrossLanguageConformance` over three test vectors.

### `SubmitToQueue` verification chain (`internal/moderation/moderation.go`)

For each submission the hub:

1. Validates `plaintext_hash` and `salt` are exactly 64 hex chars (`isValidHex64`).
2. Rebuilds the 9-field canonical body via `verify.SubmitMemoryMessage` and calls `verify.RequestSignature(contributor_pubkey, contributor_sig, canonical)`.
3. Recomputes `sha256(ciphertext_bytes || wrapped_dek_bytes)` and asserts it equals `submission_hash`.
4. Recomputes `sha256(ciphertext_bytes)` and asserts it equals `ciphertext_hash`.
5. Recomputes `sha256(wrapped_dek_bytes)` and asserts it equals `wrapped_dek_hash`.
6. Inserts the row with the four new columns into `pending_submissions`.

Sanitization at intake is disabled (hub no longer sees plaintext); the `sanitizationFindings` parameter is passed as `nil` from the HTTP handler. Moderator-decrypt-time sanitization is a Sprint 32 deliverable; for CO-029 `pending_submissions.sanitization_findings` is left null at intake.

**Test coverage** (`internal/moderation/moderation_test.go`):
- `TestSubmitToQueue_HappyPath` — round-trips and asserts new columns landed.
- `TestSubmitToQueue_BadSignatureOverNineFieldBody` — legacy 5-field sig is rejected.
- `TestSubmitToQueue_BadCiphertextHashMismatch`, `TestSubmitToQueue_BadWrappedDekHashMismatch`.
- `TestSubmitToQueue_InvalidPlaintextHashFormat`, `TestSubmitToQueue_InvalidSaltFormat`.
- `TestHubNeverStoresPlaintext` — sentinel string check across all non-ciphertext columns.

### Schema changes (`db/schema.sql`)

`pending_submissions` and `rotation_buffer` both gained four NOT NULL columns:

```sql
plaintext_hash    TEXT NOT NULL,
salt              TEXT NOT NULL,
ciphertext_hash   TEXT NOT NULL,
wrapped_dek_hash  TEXT NOT NULL,
```

### Batch path: D-VR-5 fix + chain field forwarding

`BatchSubmitToChain` (`internal/api/handlers/moderation.go`) now reads
`ps.plaintext_hash`, `ps.salt`, `ps.ciphertext_hash`, `ps.contributor_sig`
alongside the previously selected columns and populates them on `BatchMemory`.

The construction site at `internal/api/handlers/moderation.go:780` now sets
`WrappedDekEnc: wrappedDekEncBytes` from `pending_submissions.wrapped_dek_mod`.
**Before CO-029, this field was nil on every memory the hub sent to the chain
(D-VR-5).** Post-fix, the chain receives the actual wrapped DEK and can
re-derive `wrapped_dek_hash` for verification and persistence.

`BatchMemory` (`internal/chain/submit.go:14`) gained:
- `PlaintextHash []byte`
- `Salt []byte`
- `CiphertextHash []byte`
- `ContributorSig []byte`
- `ContributorPubkey string`

`SubmitMemoryToChain` and `SubmitMemoryBatchAtomic` populate the corresponding
fields on `MsgApproveMemory` before broadcasting.

### Rotation buffer: D-VR-6 signature verification

`internal/orgs/orgs.go`:

- `BufferSubmission` rebuilds the 9-field canonical body and calls
  `verify.RequestSignature` BEFORE the `INSERT INTO rotation_buffer`. A forged
  signature causes the function to return an error; the row is never persisted.
- `FinalizeRotationBuffer` (the flush from `rotation_buffer` →
  `pending_submissions`) reconstructs the canonical body for every row,
  re-verifies, and logs+skips rows that fail. Honest rows in the same flush
  proceed normally.

Both code paths now select / insert the four new columns in addition to the
previously persisted fields.

### Plaintext sentinel removed from `SubmitMemoryRequest`

The `Plaintext string` field was removed from `internal/protocol/types.go` per
R-ONE-PATH. There is no dual-handling code path. Any future caller attempting
to send `plaintext` in the JSON body will silently have it ignored at JSON
unmarshal time (extra fields). The HTTP handler at `internal/api/handlers/
moderation.go` validates that `plaintext_hash`, `salt`, `ciphertext_hash`, and
`wrapped_dek_hash` are all non-empty before forwarding to `SubmitToQueue`.

### Cross-module impact

- `BatchMemory.WrappedDekEnc` is now always populated → chain receives the
  bytes needed to derive `wrapped_dek_hash` on commit and to support Tier 2
  off-chain verification via `VerifyUpheldReport`.
- Hub no longer accepts or stores plaintext at any layer → the original D-VR-7
  plaintext-over-TLS exposure is closed.
- The four signed hash commitments flow Hub → Chain via `MsgApproveMemory`
  fields 9–12, then chain-side keeper verification (see
  `wevibe-chain/x/memory/keeper/msg_server.go`) gates persistence.
