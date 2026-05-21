# WeVibe Hub Whitepaper

Version: 1.2 · Sprint 27

## Mission

WeVibe Hub is the managed Go API server that bridges wevibe-chain state, PostgreSQL relational data, and Qdrant vector search into a unified REST interface for dashboards, MCP clients, and operational tooling. It signs and broadcasts chain transactions on behalf of authenticated org leaders and moderators, but never holds org private keys — only a derived submitter key for proxying approved actions.

## Key Responsibilities

1. **Persist** org structures, memberships, moderation queues, and credit ledgers in PostgreSQL.
2. **Index** approved memories in Qdrant for vector + keyword hybrid retrieval.
3. **Sign + broadcast** chain transactions: memory submissions, epoch rotations, merkle root commits.
4. **Expose** REST APIs for moderation, retrieval, billing, keyword management, and recovery.
5. **Validate** all mutative requests via Ed25519 signature verification before applying state changes.

## Architectural Pillars

- **Single binary** — API server, chain client, and indexing logic in one process.
- **Graceful degradation** — starts even if DB, Qdrant, or chain are unavailable; warns and continues.
- **Deterministic derivations** — Merkle roots computed locally from approved memory hashes before on-chain submission.
- **Security isolation** — hub derives a submitter key from a configured mnemonic for chain proxying, but never holds org private keys.

## Feature Set

- Org creation, member invitation/ removal, epoch rotation, key envelope management.
- Memory submission queue with Ed25519 contributor signature + hash verification.
- Moderation quorum: configurable `required_approvals`, vote tracking, leader fast-path.
- Report intake API for Accept / Deny / Report plugin flow.
- Vector + keyword memory retrieval with signed usage receipts.
- Credit ledger with `CHECK (balance >= 0)` solvency enforcement.
- Dashboard key registration for trusted UI clients.
- Shamir recovery share storage.
- Keyword vocabulary management (add, merge, rename, deprecate).
- Serve event pipeline: plugin reports serves → hub stores → hub batch-submits to chain via `MsgSubmitServeBatch`.

## Trust Model

- Hub observes chain state via gRPC queries, never trusts clients for authoritative data.
- Mutative requests must include valid Ed25519 signatures; hub verifies before proxying to chain.
- Sensitive plaintext is not stored — hub handles ciphertext + metadata only.
- Credit balances are enforced at the database level.

## Roadmap

- Add aggregated retrieval confidence forecasting.
- Integrate rule-pack telemetry for guard hit rates (opt-in).
- Provide WebSocket push for moderation queue updates.
- Prometheus metrics and health exports.

## Sprint 24 Updates

- Moderator quorum enforcement lives in hub: `approval_votes` table, `required_approvals` config, vote endpoint.
- Org configuration surface exposes `required_approvals` via signed PATCH.
- Report intake API handles Accept / Deny / Report actions from OpenCode plugin.
- Chain parity validation for `MsgGrantTrialAllowance` and moderator-signed approvals.

## Sprint 25 Updates (CO-196)

- Expanded `GrpcClient` from 2 to 7 chain modules: org, memory, serve, attestation, bandwidth, emissions, reputation.
- Removed dead CometBFT RPC client (`client.go`) — gRPC is the only chain transport.
- Added query wrappers for all modules: serve stats, session attestations, bandwidth state, emissions params, reputation stats.
- All wrappers: 5-second timeout, nil-safe (graceful when chain disabled), not-found normalized to `nil, nil`.
- Prerequisites unlocked for CO-197 (serve pipeline), CO-198 (attestation pipeline), CO-199 (merkle root submission).

## Sprint 26 Updates (CO-197)

- Serve event pipeline: plugin delivers memories to agent context; user approval triggers serve event.
- `serve_events` table in PostgreSQL accumulates serve events per org until batch submission.
- `POST /v1/orgs/{orgID}/serves` — any active org member reports serves (WeVibe-Signed auth).
- `POST /v1/orgs/{orgID}/serves/batch-submit` — leader-only; aggregates pending serves and submits `MsgSubmitServeBatch` to chain.
- `internal/serves/` package: `RecordServe`, `GetPendingServes`, `MarkSubmitted`, `MarkFailed`, `CountPending`.
- `internal/chain/submit.go`: `SubmitServeBatch` method with `ServeEntryInput` struct.
- `internal/api/handlers/serves.go`: `RecordServeEvent` and `BatchSubmitServes` handlers.

## Sprint 27 Updates (CO-201)

- Memory reporting: hub submits `MsgReportMemory` to chain after quorum/leader gating.
- `internal/chain/submit.go`: `SubmitMemoryReport` method with `ReportMemoryInput` struct.
- Enables "all social data on chain" pattern for memory violation reports.

## Sprint 28 Updates (CO-211)

- **Reputation-gated retrieval:** Memories are always served. Every retrieval candidate is presented with a trust panel showing memory-level stats (retrieved, accepted) and contributor-level stats (account age, contributions, reports upheld, false reports against).
- **Removed `/reject` endpoint:** The old `POST /v1/orgs/{orgID}/reject` endpoint that submitted to chain is removed. Consumer feedback now goes through the report system only.
- **Report resolution model:** Reports are resolved as `upheld`, `dismissed`, or `dismissed_malicious` (replacing dismiss/archive/set_validity/escalate).
- **Chain calls on reports removed:** Individual report creation and resolution no longer contact the chain. Reports stay hub-only.
- **Ban-on-quorum:** When a memory accumulates `report_ban_threshold` upheld reports (configurable per org, default 3), the hub sets `pending_submissions.banned = TRUE` and submits `MsgReportMemory` to chain with reason `"community_ban"`.
- **Schema changes:**
  - `orgs.report_ban_threshold INTEGER NOT NULL DEFAULT 3` — per-org configurable ban quorum
  - `pending_submissions.banned BOOLEAN NOT NULL DEFAULT FALSE` — memory ban flag
  - `reports.resolution TEXT CHECK (upheld, dismissed, dismissed_malicious)` — report resolution tracking
- **Trust panel:** `internal/retrieval/stats.go` provides `GetAcceptanceCount` and `GetContributorStats` helpers for enriching retrieval responses.
