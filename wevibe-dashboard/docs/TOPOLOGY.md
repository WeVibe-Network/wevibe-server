# WeVibe Dashboard Topology (Updated: CO-266)

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
4. Actions (approve/reject/relate/archive/contest) call hub endpoints that in turn broadcast transactions to wevibe-chain.
5. WebSocket stream pushes serve metrics, confidence decay alerts, and contest updates in real time.
6. Rotation page uploads anchor manifest; hub validates and submits rotation completion to wevibe-chain.

## Sprint 27 Gap Blitz (CO-265)

### Role-Gated Sidebar Navigation

`components/layout/sidebar.tsx` now gates navigation visibility using `activeOrg.role` from `useOrgContext()`:

- **All roles:** Pipeline Health, Activity, Sessions, My Submissions, Memories, Discover Orgs, Billing, Profile
- **Moderator + leader:** Moderation, Reports, Join Requests
- **Leader only:** Batch Pipeline, Members, Keywords, Recovery, Epochs, Settings

This removes dead-end pages for members while preserving moderator and leader workflows.

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

### Chain Config Read/Edit UI (GAP-O7)

`app/(dashboard)/settings/page.tsx` now includes chain configuration read/edit:

- Displays current chain config (chain ID, RPC endpoint, gRPC endpoint, bech32 prefix)
- Leaders can edit chain configuration values
- Edits submitted via `PATCH /v1/orgs/{orgID}/config` including chain fields

**New hub endpoint:** `GET /v1/orgs/{orgID}/chain-config` (leader-only)
**New hub handler:** `GetChainConfig(w, r)` in `internal/api/handlers/chain_config.go`
**New hub endpoint:** `PATCH /v1/orgs/{orgID}/config` — now accepts chain configuration fields

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

## Sprint 23 Report Flow Notes (CO-231, CO-232, CO-233)

- **Reports page:** Full CRUD with status tabs (pending, upheld_pending_tx, upheld, dismissed, dismissed_malicious). Reporter identity displayed: pubkey, wallet address, account age, dismissed_reports_count. Vote buttons: [Uphold] [Dismiss] [Dismiss as Malicious]. Current vote count shown vs `report_vote_threshold`.
- **Submit to Chain button:** Leaders see "Submit to Chain" button on reports with status `upheld_pending_tx`. Triggers `POST /v1/orgs/{orgID}/reports/{reportID}/commit` with wallet `signArbitrary` signature.
- **Wallet-signed config saves:** `required_approvals` and `report_vote_threshold` changes via Settings page require leader wallet `signArbitrary` signature (not Ed25519 delegate key). Dashboard calls `signArbitrary` on the connected wallet before PATCHing config.
- **`signArbitraryMessage` in wallet-connect:** `lib/wallet-connect.ts` exposes `signArbitraryMessage(message: string): Promise<{ signature: Uint8Array; }>` using `window.keplr.signArbitrary` or `window.leap.signArbitrary`. Used for report commitment and security config changes.

## Sprint 24 Topology Notes

- Reports page (`app/(dashboard)/reports/page.tsx`) consumes hub API and surfaces reporter identity (pubkey, wallet, role), vote buttons (Uphold/Dismiss/Dismiss as Malicious), vote count vs threshold, and reporter's dismissed_reports_count. Vote threshold configurable via `report_vote_threshold` in org config.
- Settings page (`app/(dashboard)/settings/page.tsx`) exposes `report_vote_threshold` input alongside `required_approvals`. Both saved via `PATCH /v1/orgs/{orgID}/config`.
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
  role: 'leader' | 'moderator' | 'member';
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

Leader actions: Extract Keywords (calls MCP tool), Submit to Chain (batched Cosmos TX), Skip (advance without keywords).

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
- `batchChainSubmit(orgId, submissionHashes)` — POST `/submissions/batch-chain-submit`

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
- `services/chainTx.ts` — optional direct chain submission helpers (fallback when hub relays unavailable).
- `providers/AuthProvider.tsx` — handles wallet/key session state.
- `providers/OrgProvider.tsx` — caches org metadata, config, rep tiers.
- `components/ContestSidebar.tsx` — lists active contests, resolves them.

## Wallet Connect Module (`lib/wallet-connect.ts`)

The dashboard integrates with Keplr and Leap Cosmos wallets via the browser extension injection pattern. No `@keplr-wallet` npm packages are used — only TypeScript type declarations for `window.keplr` and `window.leap`.

**Flow:** User clicks "Connect Keplr" or "Connect Leap" → `experimentalSuggestChain` registers WeVibe chain with the wallet → `enable` requests access → `getKey` returns the bech32 address → wallet address is stored in IndexedDB alongside the Ed25519 delegate key → `linkWallet` call registers the address with the hub.

**Chain config:** `NEXT_PUBLIC_WEVIBE_CHAIN_ID`, `NEXT_PUBLIC_WEVIBE_CHAIN_RPC`, `NEXT_PUBLIC_WEVIBE_CHAIN_REST`, `NEXT_PUBLIC_WEVIBE_BECH32_PREFIX`, `NEXT_PUBLIC_WEVIBE_COIN_DENOM`, `NEXT_PUBLIC_WEVIBE_COIN_MIN_DENOM`. Defaults reflect wevibe-chain values: chain ID `wevibe-local-1`, bech32 prefix `wevibe`, coin base `uvibe` (display `VIBE`).

**IndexedDB storage:** The `StoredIdentity` object in `lib/wevibe-auth.ts` stores `walletAddress` alongside the Ed25519 keypair. `getWalletAddress()` and `setWalletAddress()` manage this field.

**UI:** `WalletConnectButton` component renders in settings page and topbar. When linked, shows truncated address with green indicator.

## Delegate Key Infrastructure (CO-214)

The dashboard uses a two-tier identity model:

1. **Hub authentication** — Ed25519 keypair in IndexedDB (`lib/wevibe-auth.ts`), used for `WeVibe-Signed` header auth with the hub. This is the legacy path, being phased out.
2. **Chain authorization** — secp256k1 delegate keypair, authorized via Cosmos SDK `x/authz` MsgGrant from the user's wallet. Used for all chain operations.

### Module Architecture

**`lib/delegate-key.ts`** — secp256k1 delegate key generation and encrypted storage.
- `generateDelegateKey(walletAddress)` — generates a new secp256k1 keypair via `DirectSecp256k1HdWallet.generate()`, returns `{ address, pubkey, mnemonic }`. Address is bech32-encoded with `wevibe` prefix.
- `storeDelegateKey(walletAddress, delegateAddress, mnemonic)` — encrypts mnemonic with AES-GCM (key derived from walletAddress via PBKDF2) and stores in IndexedDB under `delegate-keys` store.
- `getDelegateKey(walletAddress)` — retrieves and decrypts stored delegate key, returns `{ delegateAddress, pubkey }`.
- `getDelegateWallet(walletAddress)` — reconstructs `DirectSecp256k1HdWallet` from stored mnemonic for signing.
- `clearDelegateKey(walletAddress)` — removes delegate key from IndexedDB.

**`lib/chain-client.ts`** — CosmJS signing client wrapper.
- `getSigningClient(signer)` — creates `SigningStargateClient` connected to wevibe-chain RPC.
- `getChainRpcEndpoint()` — reads `NEXT_PUBLIC_WEVIBE_CHAIN_RPC`, normalizes `tcp://` to `http://` for CosmJS compatibility.
- `buildMsgGrant(granter, grantee, msgTypeUrl, expirationDays)` — builds `MsgGrant` with `GenericAuthorization` for a specific message TypeURL.
- `buildMsgRevoke(granter, grantee, msgTypeUrl)` — builds `MsgRevoke`.
- `WEVIBE_MSG_TYPE_URLS` — array of 15 WeVibe message TypeURLs authorized for delegation.

**`lib/delegation.ts`** — delegation orchestrator.
- `setupDelegation(walletAddress)` — generates delegate key → signs 15 MsgGrant transactions from wallet (one Keplr popup) → stores delegate key locally. Returns `{ delegateAddress, txHash, grantCount }`.
- `revokeDelegation(walletAddress)` — broadcasts MsgRevoke for all TypeURLs → clears local delegate key.
- `isDelegationActive(walletAddress)` — checks if delegate key exists in IndexedDB.
- `renewDelegation(walletAddress)` — revokes existing grant if present, then re-executes full setup flow.

**`lib/wevibe-signing.ts`** — canonical message builders. Added `registerDelegateKeyCanonical(orgId, walletAddress, delegateAddress, signedBy)` for hub registration signing.

**`lib/hub-client.ts`** — hub API client. Added `registerDelegateKey(orgId, walletAddress, delegateAddress, grantTxHash)` which POSTs to `/v1/orgs/{orgID}/members/delegate-key` signed with the Ed25519 key.

**`components/delegation-setup.tsx`** — step-by-step wizard component (CO-214).
- Steps: idle → generating → authorizing → registering → complete/error/revoking
- Integrates with `WalletConnectButton` — after wallet connection, checks `isDelegationActive()` and renders `DelegationSetup` if not yet delegated.

### CosmJS Dependencies (CO-214)

Added to `package.json`: `@cosmjs/stargate`, `@cosmjs/proto-signing`, `@cosmjs/amino`, `@cosmjs/crypto`, `@cosmjs/encoding`, `cosmjs-types`.

### TypeURLs Authorized for Delegation

```
/wevibe.memory.v1.MsgSubmitCommitment
/wevibe.memory.v1.MsgApproveMemory
/wevibe.memory.v1.MsgRejectMemory
/wevibe.memory.v1.MsgReportMemory
/wevibe.serve.v1.MsgSubmitServeBatch
/wevibe.org.v1.MsgRegisterOrg
/wevibe.org.v1.MsgAddMember
/wevibe.org.v1.MsgRemoveMember
/wevibe.org.v1.MsgSetOrgConfig
/wevibe.org.v1.MsgSetRepTiers
/wevibe.org.v1.MsgFundTreasury
/wevibe.org.v1.MsgWithdrawTreasury
/wevibe.reputation.v1.MsgIncrementContribution
/wevibe.reputation.v1.MsgIncrementServe
/wevibe.reputation.v1.MsgRecordBan
```

Grant expiration: 90 days. Gas: 400,000 per transaction batch. Fee: 5,000 uvibe.

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
