# WeVibe Hub

WeVibe Hub is the Go API server for the public WeVibe Network.

- **Module:** `github.com/wevibe-network/wevibe-server/wevibe-hub`
- **Default port:** `4440`
- **Entry point:** `cmd/wevibe-hub/main.go`

The hub is the network’s coordination and retrieval plane between the chain and clients. It handles organization and membership control, moderation workflows, credits and billing records, denial-attestation ingestion, and Qdrant-backed semantic retrieval.

## Alpha status

This service is in active alpha. The core API surface is live and used, but some endpoints and operational workflows are still being completed.

## What the hub does

- Organization lifecycle and membership management
- Moderation queue and report workflows
- Credits and finance read surfaces
- Memory query/retrieval orchestration
- Proxy re-encryption wiring via the Umbral sidecar

## Security and custody boundary

- The hub serves encrypted candidates and re-encryption materials.
- The hub **never** sees decrypted memory plaintext.
- The hub records data and serves APIs; it does **not** relay or broadcast leader-signed transactions.
- Dashboard users sign and broadcast chain transactions directly to chain RPC.

## Runtime dependencies

At runtime, the hub integrates with:

- WeVibe chain (gRPC)
- Qdrant (vector search)
- Umbral sidecar (proxy re-encryption operations)
- Postgres (system of record)
- Ollama (embedding/extraction support)

## Local development

From `wevibe-server/wevibe-hub`:

```bash
go build ./...
go test ./...
go run ./cmd/wevibe-hub
```

The service listens on `:4440` by default (`WEVIBE_HUB_PORT` overrides this).

## Container build

Container builds use the `Dockerfile.hub` file at the `wevibe-server` repository root.

## Repository layout

- `cmd/wevibe-hub/` — server bootstrap and route wiring
- `internal/` — API handlers, auth, chain adapters, retrieval, org/member/billing logic, and Umbral integration
- `docs/` — topology and design docs
- `tests/` — integration-focused test assets

## Links

- Docs: https://github.com/WeVibe-Network/wevibe-docs
- Org: https://github.com/WeVibe-Network
- X: https://x.com/WeVibe_Network
