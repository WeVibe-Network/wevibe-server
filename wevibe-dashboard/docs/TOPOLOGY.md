# WeVibe Dashboard Topology (Updated: CO-011a.4)

> **CURRENT STATE — Moderation consolidation + RBAC SoT (2026-06-14).** The
> moderation area is now three role-aware routes; the older separate routes were
> removed. Sprint sections below are historical provenance and may describe the
> superseded layout.
>
> - **`/moderation/new`** — memory APPROVAL surface. Renders `<ModeratorReviewPanel>`
>   when `canModerate` (advisory voting + steg/sanitization/decrypt badges) and
>   `<LeaderPipelinePanel>` when `isLeader` (curate keywords → embed/verify → deny →
>   prepare + commit to chain, org-health header). Replaces the old
>   `app/(dashboard)/moderation/page.tsx` **and** `app/(dashboard)/chain-submit/page.tsx` (both DELETED).
> - **`/moderation/reported`** — memory REPORTS surface (recommend vs resolve).
>   Replaces the old `/reports` route (DELETED).
> - **`/moderation/history`** — unchanged.
> - **Permission SoT:** `useDashboardState()` exposes `isLeader` / `canModerate` /
>   `canContribute` (capability-derived; leader implies both). All role gating uses
>   these booleans — never `role === 'moderator'|'contributor'` (dead post-capability-overhaul).
>   Frontend gating is UX-only; the hub + chain remain the authorization gates.

## Runtime Diagram

```
Browser (Next.js App)
    │
    ├── REST: https://hub/api/v1/...
    ├── WebSocket: wss://hub/ws/{org}
    ├── Wallet Connector (ed25519 or Solana)
    └── Anchor Manifest Upload (S3 → hub)
```

## Data Flow

1. User authenticates via wallet connector or local key -> obtains session token from hub.
2. Moderation page fetches pending commitments (`GET /orgs/{id}/pending`), renders cards with guard findings + lifecycle status.
3. Reports page consumes moderation votes, surfaces escalation state and final actions.
4. Chain-bound actions (approve/report/member updates/config updates/serving-key updates) are built in `lib/chain-client.ts`, signed by the connected Keplr/Leap wallet, and broadcast directly to wevibe-chain RPC via `directBroadcast`.
5. WebSocket stream pushes serve metrics, confidence decay alerts, and contest updates in real time.
6. Rotation page uploads anchor manifest; hub validates and records metadata, while chain tx submission remains wallet-direct.

## Sprint 32 — CO-033b Serve Batch Submit Path

`app/(dashboard)/chain-submit/page.tsx` now runs a live serve-broadcast flow for `pending_chain` submissions:

1. Fetch `GET /v1/orgs/{orgID}/submissions?status=pending_chain` via `lib/hub-client.ts::getSubmissionsByStatus`.
2. Require non-empty `matched_keywords` on every pending row (no fallback to `extraction_result`).
3. Build `/wevibe.serve.v1.MsgSubmitServeBatch` with `lib/chain-client.ts::buildServeBatchMsg`.
4. Broadcast through `directBroadcast`.

`buildServeBatchMsg` enforces the chain/hub contract that `matched_keywords` is required and non-empty, and emits repeated field-8 string entries for every keyword in each `ServeEntry`.

## CO-214 Removal Sync — Single Wallet-Direct Broadcast Path

All chain-bound writes from the dashboard now use ONE path: wallet-sign + direct RPC broadcast. The hub is record/query infrastructure only and does not relay dashboard transactions.

### `lib/chain-client.ts` Signing + Broadcast Surface

- `WEVIBE_MSG_TYPE_URLS` defines WeVibe TypeURLs for registry registration.
- `buildWevibeRegistry()` registers those TypeURLs with CosmJS.
- `getSigningClient(signer)` returns a `SigningStargateClient` wired with the WeVibe registry.
- `directBroadcast(walletAddress, msgs)`:
  1. Pulls the offline signer from wallet-connect (`getOfflineSigner(chainId)`).
  2. Builds a signing client via `getSigningClient`.
  3. Signs `TxRaw` bytes locally in the browser.
  4. Calls chain RPC `broadcast_tx_commit` directly (no hub relay hop).
  5. Enforces both `check_tx.code == 0` and `deliver_tx.code == 0`, then returns tx hash + deliver data.
- `build*Msg` helpers produce encoded chain tx messages (`buildApproveMemoryMsg`, `buildReportMemoryMsg`, `buildRegisterOrgMsg`, `buildAddMemberMsg`, `buildRemoveMemberMsg`, `buildUpdateMemberRoleMsg`, `buildSetOrgConfigMsg`, `buildSetServingKeyMsg`, `buildServeBatchMsg`, `buildDenialBatchMsg`).

### Settings Page Save Flow (single path)

`app/(dashboard)/settings/page.tsx` uses wallet-direct chain writes only:

- config updates via `buildSetOrgConfigMsg` + `directBroadcast`
- serving-key updates via `buildSetServingKeyMsg` + `directBroadcast`

Every chain write prompts wallet confirmation because the wallet is the signer.

### Merkle Root Parity (`lib/merkle.ts`)

Dashboard-side computation of batch Merkle roots maintains byte-for-byte parity with `wevibe-hub/internal/chain/merkle.go :: ComputeMerkleRoot`:

- `computeMerkleRoot(leaves: Uint8Array[]): Promise<string>` — returns hex-encoded root.
- `hashContribution(content)` — sha256 of canonical contribution bytes, returns the leaf hash.
- Algorithm:
  - 0 leaves → `sha256(empty)`.
  - 1 leaf → `sha256(leaf)`.
  - Else → sort RAW leaves by hex encoding; pad odd layers by duplicating the last element; for each pair concatenate raw bytes and `sha256`; subsequent layers operate on hashes.
- Parity is confirmed against the Go reference by `lib/merkle.test.ts`, runnable via `npx tsx lib/merkle.test.ts`. The fixture validates three vectors: 1 leaf `"abc"`; 2 leaves `"abc","def"`; 3 leaves `"abc","def","ghi"`.

### Settings Page Save Flow (current)

`app/(dashboard)/settings/page.tsx` uses a single wallet-direct path for chain mutations:

1. Connect wallet (`connectWallet`).
2. Build chain message (`buildSetOrgConfigMsg` or `buildSetServingKeyMsg`).
3. Broadcast via `directBroadcast`.
4. Report tx hash/status to the user.

There is no delegate/authz relay fallback.

## Sprint 27 Gap Blitz (CO-265)

### Role-Gated Sidebar Navigation

`components/layout/sidebar.tsx` gates navigation visibility off the view-state
derived in `useDashboardState()` (capability-derived; see the current-state note
at the top of this file). Nav arrays live in `lib/nav-config.ts`, keyed by view-state:

- **All roles:** Pipeline Health, Activity, Sessions, My Submissions, Discover Orgs, Billing, Profile
- **Moderator + leader:** Moderation (New `/moderation/new`, Reported `/moderation/reported`, History `/moderation/history`), Join Requests
- **Leader only:** Members, Keywords, Recovery, Epochs, Settings

This removes dead-end pages for members while preserving moderator and leader workflows.
(Historical note: the leader "Batch Pipeline" `/chain-submit` route was folded into
`/moderation/new` and the standalone Reports `/reports` route into `/moderation/reported`.)

### Contributor Denial Feedback

New page `app/(dashboard)/my-submissions/page.tsx` shows contributor submission status history using `GET /v1/orgs/{orgID}/my-submissions`.

- Status badges per submission (`pending`, `pending_keyword`, `pending_chain`, `committed`, `denied`)
- Inline denial reason rendering when `status === 'denied'`
- Navigation entry exposed as **My Submissions** in the sidebar for all roles

### Submit-Time Sanitization Visibility

`app/(dashboard)/sessions/page.tsx` now surfaces submit-time sanitization findings returned by hub:

- Aggregates findings across all successful submissions in the action
- Shows amber banner with categories and finding count
- Explicit user message: submission succeeded and moderators will review the findings

### Moderation Quorum Voting UI

`app/(dashboard)/moderation/page.tsx` now supports quorum-aware approval flows:

- `required_approvals == 1`: keeps direct approve button
- `required_approvals > 1`: shows **Vote to Approve** button, `X of Y approvals`, progress bar, and truncated voter pubkeys
- Deny remains available regardless of quorum

## Sprint 27 Gap Blitz — CO-266 Dashboard Features (GAP-O6, O7, N2, N9, N8)

### Unified Finances UI (GAP-O6)

`app/(dashboard)/billing/page.tsx` was updated to show both credits balance and chain-related financial information:

- Credits balance from `GET /v1/orgs/{orgID}/credits`
- Chain-related financial data from `GET /v1/orgs/{orgID}/finances` (new endpoint)
- Combined view gives leaders full financial visibility in one place

**New hub client method:** `getOrgFinances(orgId)` — `GET /v1/orgs/{orgID}/finances`
**New hub handler:** `GetFinances(w, r)` in `internal/api/handlers/billing.go`

### Chain Config Read UI (GAP-O7)

`app/(dashboard)/settings/page.tsx` includes a read-only display of the org's on-chain configuration:

- Displays current chain config (chain ID, RPC endpoint, gRPC endpoint, bech32 prefix) sourced from the hub's read-only chain query proxy.
- Editing org-config fields is handled via wallet-direct chain messages (`buildSetOrgConfigMsg` / `buildSetServingKeyMsg` + `directBroadcast`) — NOT by a hub PATCH of chain config.

**Hub endpoint:** `GET /v1/orgs/{orgID}/chain-config` (leader-only) — read-only proxy to the chain query.
**Hub handler:** `GetChainConfig(w, r)` in `internal/api/handlers/chain_config.go`.
**Hub endpoint:** `PATCH /v1/orgs/{orgID}/config` — off-chain mirror update endpoint for hub-managed config fields. It does NOT broadcast to chain; chain writes are wallet-direct via `directBroadcast`.

### Moderation Edit-Before-Approval Fallback (GAP-N2)

`app/(dashboard)/moderation/page.tsx` implements a deny-with-edit-note fallback for encrypted content:

- When a submission's content cannot be previewed (encrypted without decrypt key), the deny dialog offers a "Save & Edit" option
- Selecting "Save & Edit" records the denial with `reason: "[edit-note] original content: {...} edited content: {...}"`
- The original and edited content are both recorded in the denial reason for audit trail
- This fallback is used when crypto pipeline constraints prevent inline content editing

### Batch Submit UI (GAP-N9)

`app/(dashboard)/sessions/page.tsx` now supports batch submission of memories:

- New batch submit button groups all ready memories for chain submission
- Single action submits all selected memories via `POST /v1/orgs/{orgID}/moderation/batch-submit`
- Progress indicator shows unified batch submission status
- Sessions page aggregates submit-time sanitization findings across all submissions

### Join Request Trial/Full Toggle (GAP-N8)

`app/(dashboard)/join-requests/page.tsx` now supports trial vs full membership approval:

- Approve action accepts `trial` boolean parameter
- `trial=true`: grants trial membership (limited daily retrieval, no contribution)
- `trial=false` or omitted: grants full membership
- Trial members see upgrade prompt in UI

**Hub client changes:** `approveJoinRequest(orgId, requestId, trial)` — `POST /v1/orgs/{orgID}/join-requests/{requestID}/approve` with optional `trial` boolean

## Sprint 23 Report Flow Notes (CO-231, CO-232, CO-233; superseded in part by CO-011a.4)

- **Reports page:** Full CRUD with status tabs (pending, upheld_pending_tx, upheld, dismissed, dismissed_malicious). Reporter identity displayed: pubkey, wallet address, account age, dismissed_reports_count. Moderators submit recommendations ([Uphold] [Dismiss] [Dismiss as Malicious]); the leader resolves autonomously (no quorum/vote-threshold gate).
- **Submit to Chain button:** Leaders see "Submit to Chain" on reports with status `upheld_pending_tx`. The dashboard builds `MsgReportMemory` and broadcasts it via `directBroadcast` (wallet-direct Keplr/Leap flow).
- **Config saves:** `MsgSetOrgConfig` updates are sent via `directBroadcast`. `signArbitrary` is no longer used for config saves.
- **`signArbitraryMessage` in wallet-connect:** `lib/wallet-connect.ts` still exposes `signArbitraryMessage(message: string): Promise<{ signature: Uint8Array; }>` using `window.keplr.signArbitrary` or `window.leap.signArbitrary`. Retained for any non-tx wallet-attestation use cases; no longer used for config saves or report commitment.

## Sprint 24 Topology Notes

- Reports page (`app/(dashboard)/reports/page.tsx`) consumes hub API and surfaces reporter identity (pubkey, wallet, role), moderator recommendation actions (Uphold/Dismiss/Dismiss as Malicious), and reporter's dismissed_reports_count. The leader makes the final autonomous resolution; there is no vote threshold/quorum config.
- Settings page (`app/(dashboard)/settings/page.tsx`) exposes org-config controls and submits chain-side changes via `directBroadcast` using `buildSetOrgConfigMsg` / `buildSetServingKeyMsg`.
- Members page (`app/(dashboard)/members/page.tsx`) displays `dismissed_reports_count` per member with orange highlight when count > 0.
- Accept / Deny / Report actions: Deny adds memory to local blacklist (never shown again); Report submits to hub for review (remains visible); Accept injects into session.

### Content Sanitization & Preference Confidence Display (CO-239)

**Sanitization findings badges:** The moderation page (`app/(dashboard)/moderation/page.tsx`) and chain-submit page (`app/(dashboard)/chain-submit/page.tsx`) display sanitization finding badges for any submission with `sanitization_findings`:

- **Critical findings** (bidi override, control characters): Red badge with count
- **Warning findings** (invisible unicode, homoglyphs, zalgo): Amber badge with count
- Clicking a badge expands the finding details (type, character, position)

**Preference confidence badges:** Each memory candidate displays a `preference_confidence` badge:

- **> 0.8**: Red — high confidence preference
- **> 0.5**: Amber — moderate confidence
- **≤ 0.5**: No badge — low confidence flagged

**Hub client changes (CO-239):**
- `lib/hub-client.ts` added `SanitizationFinding` interface with `type`, `category`, `char`, `position` fields
- `Submission` interface updated to include `sanitization_findings` and `preference_confidence`

## Sprint 25 Multi-Org UI (CO-247)

### Org Context (`lib/org-context.tsx`)

The dashboard uses a React context to manage multi-org state. This is the foundation for D-12.3 (org switcher) and D-12.2 (per-memory org destination).

**Interface:**
```typescript
interface MemberOrgEntry {
  org_id: string;
  org_name: string;
  role: 'leader' | 'moderator' | 'member' | 'contributor';
  current_epoch: number;
  history_access_from_epoch: number;
  egress_mode: string;
  allowed_providers: string[];
  mod_pubkey?: string;
  wallet_address?: string;
}

interface OrgContextValue {
  orgs: MemberOrgEntry[];
  activeOrg: MemberOrgEntry | null;
  setActiveOrg: (orgId: string) => void;
  loading: boolean;
  error: string | null;
}
```

**Provider:** `OrgProvider` wraps the dashboard layout in `app/(dashboard)/layout.tsx`.

**Persistence:** Active org ID persisted to `localStorage` under key `wevibe_active_org_id`. On load, validates stored org is still in membership list.

**Usage:** `const { orgs, activeOrg, setActiveOrg, loading } = useOrgContext();`

### Org Switcher Component (`components/layout/org-switcher.tsx`)

Compact dropdown in the topbar for switching between org memberships (D-12.3).

**Behavior:**
- Single org: displays org name only (no dropdown)
- Multiple orgs: dropdown with org names and role badges (leader=purple, moderator=blue, member=gray)
- Click outside to close dropdown
- On select: calls `setActiveOrg(orgId)` and persists to localStorage

**Placement:** Rendered in `components/layout/topbar.tsx` left section, replacing the static "WeVibe Network Dashboard" title.

### Per-Memory Org Destination (`app/(dashboard)/sessions/page.tsx`)

When extracting memories from sessions, each memory can be submitted to a different org (D-12.2).

**Changes to sessions page:**
- Added `memoryOrgs` state: `Map<number, string>` tracking destination org per memory index
- Each memory card shows an org dropdown (when user has multiple orgs)
- Default destination: `activeOrg.org_id` (falls back to `orgs[0].org_id`)
- Submit flow groups selected memories by destination org
- For each org group: fetches epoch, submits memories via `POST /v1/orgs/{orgID}/submit`
- Shows org-specific result messages (e.g., "3→OrgA, 2→OrgB")

**UI:** Compact dropdown in top-right of each memory card. When only one org available, shows "→ OrgName" label instead of dropdown.

### Consumer Profile Pages (CO-247)

**Own profile:** `app/(dashboard)/profile/page.tsx`
- Client component
- Fetches identity via `getIdentity()`, then calls `GET /v1/profile/{pubkey}`
- Displays: wallet address (with copy button), pubkey, memberships with role badges, chain stats, moderator stats, leader stats
- Sections hidden when data is null (no moderator activity = no moderator section)

**Public profile:** `app/u/[wallet]/page.tsx`
- Server component (Next.js dynamic route)
- Standalone page (no sidebar/topbar — outside `(dashboard)` group)
- Route: `/u/{wallet}` where wallet is URL-encoded
- Calls `GET /v1/profile/{wallet}` directly
- Same layout as own profile

**Hub client:** `lib/hub-client.ts` added `getProfile(wallet)` function and `ProfileResponse` types.

**Navigation:** "Profile" added to sidebar nav array (before Settings).

## Sprint 26 Keyword Pipeline + Chain Submit (CO-238)

### Memory Lifecycle States

Submitted memories flow through four states: `pending` → `pending_keyword` → `pending_chain` → `committed`. Moderator approval transitions `pending` → `pending_keyword` only. Keyword extraction, verification, and chain submission are separate pipeline stages.

### Moderation Page (Simplified + Quorum Vote)

The moderation page (`app/(dashboard)/moderation/page.tsx`) handles vote/approve/deny only — no direct keyword extraction, Qdrant indexing, or chain submission at moderation action time.

- `required_approvals == 1`: approve path transitions submission to `pending_keyword`
- `required_approvals > 1`: each moderator casts a vote; hub advances state when quorum is reached
- Deny rejects the submission immediately

### Chain Submit Page

New page at `app/(dashboard)/chain-submit/page.tsx` provides the batch pipeline UI with three sections:

1. **Ready for Keywords** — memories in `pending_keyword` state that need keyword extraction via MCP
2. **Review Keywords** — memories with extracted keywords pending moderator review and hub verification
3. **Ready for Chain** — memories in `pending_chain` state, ready for batch chain submission

Leader actions: Extract Keywords (calls MCP tool), Submit to Chain (builds `MsgApproveMemory` for the batch and dispatches via `directBroadcast`), Skip (advance without keywords).

### Keyword Extraction Flow

1. Dashboard calls `wevibe_extract_memories` MCP tool (via `app/api/extract/route.ts`) which proxies to wevibe-mcp
2. wevibe-mcp fetches org keyword vocabulary, runs LLM classification with weight normalization
3. Results returned to dashboard, leader reviews and submits to hub via `POST /v1/orgs/{orgID}/submissions/{hash}/keywords`
4. Hub verifies keywords against vocabulary, transitions status to `pending_chain`

### GAP-O8 Resolution

`app/api/extract/route.ts` was rewritten to proxy through the MCP `wevibe_extract_memories` tool instead of making direct Ollama/OpenRouter calls. The endpoint now accepts memory text inputs and returns extracted keywords + confidence scores.

### Hub Client Methods (lib/hub-client.ts)

New methods for keyword pipeline:
- `submitKeywordResults(orgId, submissionHash, keywords)` — POST to `/submissions/{hash}/keywords`
- `rerunKeywordExtraction(orgId, submissionHash)` — POST to `/submissions/{hash}/keywords/rerun`
- `updateKeywords(orgId, submissionHash, keywords)` — PUT to `/submissions/{hash}/keywords`
- `removeSubmission(orgId, submissionHash)` — DELETE `/submissions/{hash}`
- `listPendingKeywords(orgId)` — GET `/submissions/keywords/pending`
- `listPendingChain(orgId)` — GET `/submissions/keywords/pending-chain`

Batch chain submission itself is no longer a hub client method — see "lib/hub-client.ts surface" below for what CO-011a.4 removed. The chain-submit page now builds `MsgApproveMemory` (or the relevant batch message) and dispatches it through `directBroadcast`.

## Sprint 30 — Denial Batch Panel (CO-017)

### Denial-Batch Panel in Chain Submit Page

`app/(dashboard)/chain-submit/page.tsx` now includes a fourth panel (rose theme) between the indigo "Review Keywords" panel and the emerald "Ready for Chain" panel:

```
Ready for Keywords (amber) → Review Keywords (indigo) → Pending Denials (rose) → Ready for Chain (emerald)
```

**Data flow:**
1. Dashboard fetches pending denial count from `GET /v1/orgs/{orgID}/denials/pending-count`
2. Panel displays count with "Batch Submit Denials" button
3. Leader clicks → wallet popup triggers (Keplr/Leap — Category A per D-2026-05-25-A)
4. `directBroadcast(walletAddress, [msg])` signs and broadcasts `MsgSubmitDenialBatch`
5. `broadcast_tx_commit` returns `code === 0` on success (on-chain confirmation)

**Hub endpoints consumed:**
- `GET /v1/orgs/{orgID}/denials/pending-count` → `{ pending_count: N }`
- `GET /v1/orgs/{orgID}/denials/pending` → `{ denials: [...], total_count: N }`
- `GET /v1/orgs/{orgID}` → `{ current_epoch: N }` (for epoch field)

**Chain message:** `MsgSubmitDenialBatch` (typeUrl: `/wevibe.serve.v1.MsgSubmitDenialBatch`)
- Fields: `signer`, `org_id`, `epoch`, `entries[]` (each: `memory_hash`, `serve_fingerprint`, `deny_key`, `reason`)
- Wallet-direct via Keplr/Leap, NOT relayed through hub

**lib/chain-client.ts additions (CO-017):**
- `WEVIBE_MSG_TYPE_URLS` now includes `/wevibe.serve.v1.MsgSubmitDenialBatch`
- `buildDenialBatchMsg(signer, orgId, epoch, entries)` — builds `EncodeObject` with manual protobuf encoding
- `DenialEntry` interface: `{ memory_hash, serve_fingerprint, deny_key, reason }`
- Update: dashboard `buildDenialBatchMsg` / `buildServeBatchMsg` plus `DenialEntry` / `ServeEntryInput` were removed as dead + canon-misaligned; serve/denial settlement batching is the serving-key relay's responsibility, not the dashboard.

**Protocol-js:** `@wevibe-network/protocol-js` does not export `MsgSubmitDenialBatch` — manual `EncodeObject` construction used.

**Confirmation:** `broadcast_tx_commit` synchronous semantics — `code === 0` means block included. No WebSocket listener needed.

### Pipeline Health Page

New page at `app/(dashboard)/health/page.tsx` — a server component (no 'use client') that fetches health status from all pipeline services at render time using `fetch()` with `{ cache: 'no-store' }`.

**Services monitored:**
| Service | URL | Success Condition |
|---------|-----|-------------------|
| PostgreSQL (via Hub) | `http://localhost:4440/health` | `status === 'ok' && db === 'connected'` |
| Qdrant | `http://localhost:6333/healthz` | HTTP 200 |
| wevibe-chain | `http://localhost:26657/status` | HTTP 200 |
| wevibe-hub | `http://localhost:4440/health` | `status === 'ok'` |
| wevibe-mcp HTTP | `http://127.0.0.1:4450/v1/health` | `status === 'ok'` |
| Ollama | `http://localhost:11434/api/tags` | HTTP 200 |
| Dashboard | (self) | Always ✓ if page loads |

**Features:**
- Overall status banner ("All systems operational" / "System degradation detected")
- Grid of service cards with green/red status dot, response time in ms, error message if down
- Refresh button (link to `/health`)
- Timestamp of when check was performed

**Navigation:** "Pipeline Health" is the first item in the sidebar nav array.

### Activity Feed Page (CO-248)

**Location:** `app/(dashboard)/activity/page.tsx`

**Purpose:** Realtime notification feed showing all activity across all orgs the user belongs to.

**Features:**
- Notification list newest-first with "Load more" pagination (50 per page)
- Each notification card displays:
  - Category badge (color-coded): chain_commit_involving_you (blue), report_upheld_committed (amber), your_approval_was_overturned (red)
  - Org name badge (shows which org the notification is from)
  - Title and body text
  - Relative timestamp ("2 hours ago")
  - Unread indicator (dot)
- Click notification to mark as read
- "Mark all read" button at top
- WebSocket connection to `ws://localhost:4440/v1/notifications/ws` for realtime updates
- New notifications prepended to list via WebSocket push
- Empty state: "No activity yet. Notifications will appear here as your org processes memories."

**API functions** (in `lib/hub-client.ts`):
- `listNotifications(params?)` — fetch notification list
- `getUnreadCount()` — fetch unread count
- `markNotificationsRead(ids)` — mark specific notifications read
- `markAllNotificationsRead()` — mark all read

**Navigation:** "Activity" is the second item in the sidebar nav array (after Pipeline Health, before Sessions).

**Notification Bell Component:**
- `components/layout/notification-bell.tsx`
- Displays bell icon with red badge showing unread count
- Click navigates to `/activity`
- WebSocket connection for realtime count updates

## Sprint 25 Discovery and Join Requests (CO-259)

### Org Discovery Page (CO-259)

**Location:** `app/(dashboard)/discover/page.tsx`

**Purpose:** Browse and search public orgs. CLOSED in Sprint 25 (GAP-M4).

**Features:**
- Lists all public orgs with member count, domain, description
- Text search by org name
- Sort by newest/largest/most-active

**Hub endpoint:** `GET /v1/orgs/discover`

### Join Requests Page (CO-259)

**Location:** `app/(dashboard)/join-requests/page.tsx`

**Purpose:** Leader/moderator view for managing join requests. CLOSED in Sprint 25 (GAP-M5).

**Features:**
- Lists pending join requests per org
- Approve/Deny actions per request
- Denial reason + 7-day cooldown
- Status filter (pending/approved/denied)

**Hub endpoints:**
- `POST /v1/orgs/{orgID}/join` — submit join request (public)
- `GET /v1/orgs/{orgID}/join-requests` — list requests (leader/moderator)
- `POST /v1/orgs/{orgID}/join-requests/{requestID}/approve` — approve
- `POST /v1/orgs/{orgID}/join-requests/{requestID}/deny` — deny with reason

**Sidebar navigation:** Both "Discover Orgs" and "Join Requests" entries present in `components/layout/sidebar.tsx`.

## Sprint 25 Dogfood Infrastructure (CO-245)

### Makefile Targets

Workspace `Makefile` (workspace root) provides:

```
make start         # Launch all services via start.sh
make stop          # Tear down services via stop.sh
make clean         # Clear state via clear.sh
make health        # Fast health check (no pipeline test)
make dogfood       # Full smoke test (health + pipeline)
make dogfood-health # Service health check only
make dogfood-pipeline # Pipeline smoke test only
```

### Dogfood Pipeline Test

`tests/e2e/dogfood-pipeline.test.ts` exercises 4 steps:
1. Submit a memory (Nginx reverse proxy insight)
2. Moderator approves with keywords
3. Batch chain submit
4. Recall via wevibe-mcp HTTP `/v1/recall` (verifies memory found + guard.passed=true)

Uses `HubClient`, `encryptMemory`, `signSubmission`, test identities for leader/moderator/contributor.

## Client Modules

- `services/hubClient.ts` — REST + WebSocket wrappers using generated protocol client.
- `services/chainTx.ts` — optional direct chain submission helpers.
- `providers/AuthProvider.tsx` — handles wallet/key session state.
- `providers/OrgProvider.tsx` — caches org metadata, config, rep tiers.
- `components/ContestSidebar.tsx` — lists active contests, resolves them.

## Wallet Connect Module (`lib/wallet-connect.ts`)

The dashboard integrates with Keplr and Leap Cosmos wallets via the browser extension injection pattern. No `@keplr-wallet` npm packages are used — only TypeScript type declarations for `window.keplr` and `window.leap`.

**Flow:** User clicks "Connect Keplr" or "Connect Leap" → `experimentalSuggestChain` registers WeVibe chain with the wallet → `enable` requests access → `getKey` returns the bech32 address → wallet address is stored in IndexedDB alongside the Ed25519 identity keypair → `linkWallet` call registers the address with the hub.

**Chain config:** `NEXT_PUBLIC_WEVIBE_CHAIN_ID`, `NEXT_PUBLIC_WEVIBE_CHAIN_RPC`, `NEXT_PUBLIC_WEVIBE_CHAIN_REST`, `NEXT_PUBLIC_WEVIBE_BECH32_PREFIX`, `NEXT_PUBLIC_WEVIBE_COIN_DENOM`, `NEXT_PUBLIC_WEVIBE_COIN_MIN_DENOM`. Defaults reflect wevibe-chain values: chain ID `wevibe-local-1`, bech32 prefix `wevibe`, coin base `uvibe` (display `VIBE`).

**IndexedDB storage:** The `StoredIdentity` object in `lib/wevibe-auth.ts` stores `walletAddress` alongside the Ed25519 keypair. `getWalletAddress()` and `setWalletAddress()` manage this field.

**UI:** `WalletConnectButton` component renders in settings page and topbar. When linked, shows truncated address with green indicator.

## Wallet Link + Chain Signing Architecture (Current)

The dashboard now uses a two-layer model without client delegate keys:

1. **Hub authentication** — Ed25519 keypair in IndexedDB (`lib/wevibe-auth.ts`) for `WeVibe-Signed` hub auth.
2. **Chain signing** — secp256k1 wallet keys in Keplr/Leap, signing txs directly from the wallet extension.

### Module Architecture

**`lib/chain-client.ts`** — CosmJS signing client + WeVibe message builders.
- `getChainRpcEndpoint()` — reads `NEXT_PUBLIC_WEVIBE_CHAIN_RPC`, normalizes RPC URL for CosmJS.
- `buildWevibeRegistry()` / `getSigningClient(signer)` — registry + signer client setup for WeVibe type URLs.
- `directBroadcast(walletAddress, msgs)` — signs locally and sends `broadcast_tx_commit` to chain RPC; validates CheckTx + DeliverTx success.
- Message builders: `buildSubmitCommitmentMsg`, `buildApproveMemoryMsg`, `buildReportMemoryMsg`, `buildRegisterOrgMsg`, `buildAddMemberMsg`, `buildRemoveMemberMsg`, `buildUpdateMemberRoleMsg`, `buildSetOrgConfigMsg`, `buildSetServingKeyMsg`, `buildServeBatchMsg`, `buildDenialBatchMsg`.
- `WEVIBE_MSG_TYPE_URLS` — TypeURL registry entries used by `buildWevibeRegistry`.

**`lib/wevibe-signing.ts`** — canonical message builders for signed hub payloads.

**`lib/hub-client.ts`** — hub API client; `linkWallet` persists wallet↔identity association (`POST /v1/orgs/{orgID}/members/wallet`).

**`lib/wallet-connect.ts`** — wallet connection + signer access (`getOfflineSigner`).

### CosmJS Dependencies

Added to `package.json`: `@cosmjs/stargate`, `@cosmjs/proto-signing`, `@cosmjs/amino`, `@cosmjs/crypto`, `@cosmjs/encoding`, `cosmjs-types`.

### WEVIBE_MSG_TYPE_URLS Registry Entries

```
/wevibe.memory.v1.MsgSubmitCommitment
/wevibe.memory.v1.MsgApproveMemory
/wevibe.memory.v1.MsgReportMemory
/wevibe.serve.v1.MsgSubmitServeBatch
/wevibe.org.v1.MsgRegisterOrg
/wevibe.org.v1.MsgAddMember
/wevibe.org.v1.MsgRemoveMember
/wevibe.org.v1.MsgUpdateMemberRole
/wevibe.org.v1.MsgSetOrgConfig
/wevibe.org.v1.MsgSetServingKey
/wevibe.reputation.v1.MsgIncrementContribution
/wevibe.reputation.v1.MsgIncrementServe
/wevibe.reputation.v1.MsgRecordBan
/wevibe.serve.v1.MsgSubmitDenialBatch
```

`directBroadcast` signs locally and submits via `broadcast_tx_commit` with wallet-owned authority.

## Chain + Crypto Library Surface

### `lib/chain-client.ts`

Chain tx construction and broadcast are wallet-direct:

- Build `EncodeObject` messages with the `build*Msg` helpers.
- Sign locally with the connected Keplr/Leap account.
- Submit directly to chain RPC via `broadcast_tx_commit`.
- Return tx hash and deliver response metadata to the caller.

### `lib/merkle.ts`

Exports:

- `computeMerkleRoot(leaves: Uint8Array[]): Promise<string>` — returns the hex-encoded root.
- `hashContribution(content)` — sha256 of the canonical contribution bytes; produces the leaf hash.

Byte-for-byte parity with `wevibe-hub/internal/chain/merkle.go :: ComputeMerkleRoot`. Algorithm:

- 0 leaves → `sha256(empty)`.
- 1 leaf → `sha256(leaf)`.
- Else → sort the RAW leaves by their hex encoding; if a layer has an odd count, pad by duplicating the last entry; for each adjacent pair concatenate raw bytes and `sha256` to produce the next layer; subsequent layers operate on hashes (not on the raw leaves).

CO-011a.4 R-MERKLE-PARITY was confirmed via three fixture vectors at `lib/merkle.test.ts`.

### `lib/merkle.test.ts`

Fixture test runnable via `npx tsx lib/merkle.test.ts`. Validates three vectors against expected hashes generated by the Go reference implementation:

- 1 leaf: `"abc"`
- 2 leaves: `"abc"`, `"def"`
- 3 leaves: `"abc"`, `"def"`, `"ghi"`

A failure here means the dashboard would produce a root that disagrees with the hub/chain and would be rejected on-chain. This file is the authoritative regression check for the parity invariant.

## `lib/hub-client.ts` Surface (post-CO-011a.4)

Kept (still hub HTTP calls):

- `getOrgChainConfig(orgId)` — hub `GET /v1/orgs/{orgID}/chain-config`. Read-only proxy to the chain query; no chain write.
- `updateOrgConfig(orgId, patch)` — hub `PATCH /v1/orgs/{orgID}/config` for off-chain mirror updates. Does NOT broadcast to chain — chain writes remain dashboard wallet-direct via `directBroadcast`.
- `topUpCredits`, `transferLeadership`, `closeOrg`, `rotateEpoch` — off-chain hub operations, unchanged.
- Keyword-pipeline methods listed under "Hub Client Methods (lib/hub-client.ts)" above.

Removed in CO-011a.4 + CO-214 cleanup (chain-bound writes are wallet-direct via `chain-client.ts :: directBroadcast`):

- `batchChainSubmit` — replaced by dashboard-built `MsgApproveMemory` + `directBroadcast`.
- `commitReport` — replaced by dashboard-built `MsgReportMemory` + `directBroadcast`.
- `inviteMember` — replaced by dashboard-built `MsgAddMember` + `directBroadcast`.
- `removeMember` — replaced by dashboard-built `MsgRemoveMember` + `directBroadcast`.
- `updateMemberRole` — replaced by dashboard-built `MsgUpdateMemberRole` + `directBroadcast`.
- `updateOrgChainConfig` — replaced by dashboard-built config messages (`buildSetOrgConfigMsg` / `buildSetServingKeyMsg`) + `directBroadcast`.

## Storage & Caching

- React Query caches API responses with stale-while-revalidate.
- IndexedDB (via `idb-keyval`) stores encrypted session context (`AES-GCM`, key derived from wallet secret).
- Local storage used only for feature flags and non-sensitive preferences.

## Deployment Topology

- CDN (Vercel/CloudFront) serves static assets.
- API calls routed to hub; no direct database access.
- Optional feature flag service for staged rollouts.

## Observability

- Client logs -> Sentry/LogRocket.
- Web Vitals tracked using Next.js analytics; exported to Hub for monitoring.
- Hub emits audit logs for every mutation triggered via dashboard.

## Signed Canonical Body — Submit Pathway (CO-029)

### `lib/wevibe-signing.ts`

`submitMemoryCanonical(orgId, epochId, submissionHash, contributorPubkey, memoryType, ciphertextHash, plaintextHash, salt, wrappedDekHash)` builds the 9-field canonical body. Field ordering is alphabetical after the domain tag `wevibe.submit_memory.v1`:

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

Byte-identical to the hub Go builder and the MCP TypeScript builder. The function signature is `async` to match the existing pattern (the body itself is synchronous string assembly).

### `lib/wevibe-submit.ts`

`buildSubmitMemoryPayload` computes the four new hash commitments client-side using WebCrypto:

1. `salt` = `crypto.getRandomValues(new Uint8Array(32))`, hex-encoded.
2. `plaintext_hash` = `sha256(salt || TextEncoder.encode(memoryText))` via `crypto.subtle.digest('SHA-256', concatBufs(salt, plaintextBytes))`. **Salt prepends** the plaintext (locked by D-VR-3).
3. `ciphertext_hash` = `sha256(fullCiphertext)` where `fullCiphertext = nonce || aes-gcm-ciphertext`.
4. `wrapped_dek_hash` = `sha256(wrappedDek)` where `wrappedDek` is the X25519+AES-GCM sealed DEK.

All four hex strings are passed to `submitMemoryCanonical` to build the canonical body. The body is signed with the identity's WebCrypto Ed25519 private key via `signCanonical`.

### Submit payload — `SubmitMemoryPayload` interface

```ts
{
  org_id: string;
  epoch_id: number;
  memory_type: MemoryType;
  plaintext_hash: string;     // hex sha256(salt || plaintext_utf8)
  salt: string;               // hex 32 random bytes
  ciphertext_hash: string;    // hex sha256(ciphertext)
  wrapped_dek_hash: string;   // hex sha256(wrapped_dek)
  ciphertext: string;         // hex
  wrapped_dek_mod: string;    // hex
  submission_hash: string;    // hex sha256(ciphertext || wrapped_dek_mod)
  contributor_pubkey: string; // hex
  contributor_sig: string;    // hex Ed25519 signature
  stack_hint: string[];
  attestation: null;
}
```

### D-VR-7 closure — plaintext removed from the wire

The previous `plaintext: memoryText` field was REMOVED from `SubmitMemoryPayload` (per R-ONE-PATH). The dashboard never sends plaintext to the hub. The salted hash plus the contributor's signed binding are sufficient for the chain's Tier 2 verification anchor.

Verification:

```
$ grep -n '"plaintext"' wevibe-server/wevibe-dashboard/lib/wevibe-submit.ts
(zero matches; only plaintext_hash is present)
```

The hub no longer runs Unicode sanitization at submit time (it has no plaintext). For CO-029, the hub returns `sanitization_findings: null`. The dashboard's submission-result UI should treat findings as optional. Sprint 32 may port the YARA scanner to client-side; CO-029 does not ship a browser-side scanner.

### Browser crypto requirements

- WebCrypto `Ed25519` for signing the canonical body (`signCanonical`).
- WebCrypto `SHA-256` for the four hashes.
- WebCrypto `X25519` for `sealDekToModPubkey` (unchanged from prior CO).
- WebCrypto `AES-GCM` for memory encryption (unchanged).

The wevibe-sdk WASM bindings are NOT used in the dashboard submit path — pure browser WebCrypto. The same byte-identical canonical body is produced regardless of which Ed25519 implementation is used at sign time (the verifier only needs `pubkey`, `signature`, `body`).
