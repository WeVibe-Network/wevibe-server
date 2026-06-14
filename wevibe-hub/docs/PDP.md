# WeVibe Hub PDP

## Service Layout

- **Language:** Go 1.24
- **Entry point:** `cmd/wevibe-hub/main.go` — HTTP server on port 4440 (default)
- **Dependencies:**
  - PostgreSQL for orgs, members, moderation queue, epochs, receipts, credits.
  - Qdrant for vector search over approved memories.
  - wevibe-chain gRPC (no CometBFT RPC dependency).
  - Redis (optional, not yet wired).

## Ingestion Pipeline

Ingest is pull-based via gRPC query clients, not push-based Tendermint WS:

1. `GrpcClient` queries wevibe-chain modules directly (`x/org`, `x/memory`, `x/serve`, etc.).
2. Hub writes approved memories into PostgreSQL + Qdrant index.
3. Merkle roots are computed locally and submitted to chain via `BroadcastMsgs`.
4. No WebSocket notifications yet — clients poll REST endpoints.

## API Surface

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check with DB connectivity status |
| POST | `/v1/orgs` | Create org (signed, leader-only) |
| GET | `/v1/orgs/{orgID}` | Get org public info |
| PATCH | `/v1/orgs/{orgID}/config` | Update org config (signed, leader-only) |
| POST | `/v1/orgs/{orgID}/epoch/rotate` | Rotate epoch (signed, leader-only) |
| GET | `/v1/orgs/{orgID}/epoch/{epochID}/manifest` | Get epoch manifest |
| POST | `/v1/orgs/{orgID}/members` | Invite member (signed, leader-only) |
| GET | `/v1/orgs/{orgID}/members` | List members |
| GET | `/v1/orgs/{orgID}/members/{pubkey}` | Get member details |
| DELETE | `/v1/orgs/{orgID}/members/{pubkey}` | Remove member (signed, leader-only) |
| GET | `/v1/orgs/{orgID}/keys/envelope` | Retrieve key envelope for caller |
| POST | `/v1/orgs/{orgID}/dashboard/keys` | Register dashboard key (signed, leader-only) |
| DELETE | `/v1/orgs/{orgID}/dashboard/keys/{pubkey}` | Revoke dashboard key (signed, leader-only) |
| POST | `/v1/orgs/{orgID}/recovery/shares` | Store recovery shares (signed, leader-only) |
| GET | `/v1/orgs/{orgID}/recovery/shares` | Get recovery share for caller |
| POST | `/v1/orgs/{orgID}/submit` | Submit memory to moderation queue |
| POST | `/api/v1/orgs/{orgID}/reports` | Create report |
| GET | `/api/v1/orgs/{orgID}/reports` | List reports |
| GET | `/api/v1/orgs/{orgID}/reports/{reportID}` | Get report |
| PATCH | `/api/v1/orgs/{orgID}/reports/{reportID}` | Update report |
| GET | `/v1/orgs/{orgID}/moderation/queue` | Get pending moderation queue (moderator auth) |
| POST | `/v1/orgs/{orgID}/moderation/{submissionHash}/vote` | Cast moderation vote |
| POST | `/v1/orgs/{orgID}/moderation/{submissionHash}/approve` | Approve submission (moderator auth) |
| POST | `/v1/orgs/{orgID}/moderation/{submissionHash}/deny` | Deny submission (moderator auth) |
| POST | `/v1/orgs/{orgID}/moderation/batch-submit` | Batch queue submissions for moderation (hub-internal; NOT chain) |
| POST | `/v1/orgs/{orgID}/serves` | Record a serve event (plugin → hub) |
| POST | `/v1/orgs/{orgID}/query` | Vector + keyword memory query |
| GET | `/v1/orgs/{orgID}/memories/{cid}` | Get single memory by CID |
| GET | `/v1/orgs/{orgID}/keywords` | List org keywords |
| POST | `/v1/orgs/{orgID}/keywords` | Add keyword (leader-only) |
| PUT | `/v1/orgs/{orgID}/keywords/merge` | Merge keywords (leader-only) |
| PUT | `/v1/orgs/{orgID}/keywords/{keyword}/rename` | Rename keyword (leader-only) |
| DELETE | `/v1/orgs/{orgID}/keywords/{keyword}` | Deprecate keyword (leader-only) |
| POST | `/v1/billing/topup` | Top up org credits |
| GET | `/v1/orgs/{orgID}/credits` | Get org credit balance + transactions |
| GET | `/v1/members/{pubkey}/orgs` | List all orgs for a member |

## Modules

| Package | Role |
|---------|------|
| `internal/api/handlers/` | REST route handlers (Chi router) |
| `internal/chain/` | gRPC chain client, query wrappers, tx broadcast, Merkle root submission |
| `internal/config/` | Env-based configuration loading |
| `internal/db/` | PostgreSQL pool + schema migrations |
| `internal/protocol/` | Canonical request/response types |
| `internal/orgs/` | Org CRUD, epoch rotation, manifest generation |
| `internal/members/` | Membership lifecycle, access control |
| `internal/moderation/` | Submission queue, approval/denial, batch chain submit |
| `internal/serves/` | Serve event storage and batch aggregation |
| `internal/retrieval/` | Qdrant vector search, memory indexing |
| `internal/billing/` | Credit ledger, top-ups, query cost deduction |
| `internal/receipts/` | Signed usage receipts for retrieval queries |
| `internal/verify/` | Ed25519 signature verification + canonical message hashing |
| `internal/embed/` | Ollama embedding generation (nomic-embed-text) |
| `internal/envelopes/` | Key envelope storage per org+member |
| `internal/auth/` | WeVibe-Signed header parsing |

## Chain Client (`internal/chain/`)

The canonical chain client is `GrpcClient` (gRPC only). There is no CometBFT RPC fallback.

**Files:**
- `grpc_client.go` — Connection, signing key derivation, codec, interface registry, query client getters
- `query.go` — nil-safe, 5s-timeout wrappers for all module queries with not-found normalization
- `broadcast.go` — Msg broadcasting with sign + simulate + submit flow
- `submit.go` — Memory submission message builders, serve batch submission (`SubmitServeBatch`)
- `merkle.go` + `merkle_test.go` — SHA-256 binary Merkle tree computation

**Supported modules:** `x/org`, `x/memory`, `x/serve`, `x/attestation`, `x/bandwidth`, `x/emissions`, `x/reputation`

## Configuration

| Env Var | Default | Purpose |
|---------|---------|---------|
| `WEVIBE_HUB_PORT` | 4440 | HTTP server port |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `QDRANT_ADDR` | localhost:6333 | Qdrant gRPC address |
| `OLLAMA_URL` | http://localhost:11434 | Embedding service URL |
| `WEVIBE_S3_BUCKET` | wevibe-memories | S3 bucket for ciphertext storage |
| `HUB_NODE_PRIVKEY` | — | Ed25519 node key for receipt signing |
| `WEVIBE_CHAIN_GRPC_URL` | — | wevibe-chain gRPC endpoint |
| `WEVIBE_CHAIN_ID` | — | Chain ID |
| `WEVIBE_CHAIN_SUBMITTER_MNEMONIC` | — | Submitter mnemonic for chain txs |
| `WEVIBE_CHAIN_ENABLED` | false | Enable chain client |
| `CORS_ALLOWED_ORIGINS` | http://*, https://* | CORS allowed origins |
| `STRIPE_SECRET_KEY` | — | Stripe secret (manual top-up only today) |

## Observability

- Structured logs via standard `log` package.
- No Prometheus /metrics endpoint yet.
- No OpenTelemetry tracing yet.

## Deployment

- Containerized (Dockerfile present).
- Single binary: API + chain client in one process.
- PostgreSQL 15+ required.
- Qdrant required for memory retrieval.

## Backlog / Risks

- Historical backfill mechanism not yet built.
- Redis pub/sub not wired.
- WebSocket push not implemented.
- Stripe integration is manual credit injection, not payment processing.

## Sprint 24 Updates

- Moderator vote storage: `submission_mod_votes` table and vote endpoints.
- Report API: Accept / Deny / Report flow via `/api/v1/orgs/{orgID}/reports`.
- Chain parity via `GrpcClient` for moderator approvals and fee grant validation.

## Sprint 25 Updates

- GrpcClient expanded from 2 to 7 chain modules (CO-196).
- Old CometBFT RPC client (`client.go`) removed entirely.
- Query wrappers added for serve, attestation, bandwidth, emissions, reputation.
