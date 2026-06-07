# WeVibe Server

> **Alpha status:** WeVibe Server is under active development. Expect breaking changes while deployment and operations tooling continues to mature.

`wevibe-server` is the deployment and backend umbrella repository for the public WeVibe Network. It ties together three subprojects:

- [`wevibe-hub`](./wevibe-hub/README.md) — Go API server
- [`wevibe-dashboard`](./wevibe-dashboard/README.md) — Next.js web application
- [`wevibe-infra`](./wevibe-infra/README.md) — reverse proxy and deployment/operations configuration

## Repository contents

Key files and directories in this repo:

- [`docker-compose.yml`](./docker-compose.yml) — full local/self-host stack
- [`docker-compose.fast.yml`](./docker-compose.fast.yml) — fast 2-second epoch overlay for testing
- [`Dockerfile.hub`](./Dockerfile.hub), [`Dockerfile.umbral-sidecar`](./Dockerfile.umbral-sidecar), [`Dockerfile.wevibe-mcp`](./Dockerfile.wevibe-mcp)
- [`db/schema.sql`](./db/schema.sql) — PostgreSQL schema source of truth for the hub
- [`scripts/`](./scripts/) — operational helper scripts
- [`.env.example`](./.env.example) — environment defaults

## Bring up the stack with Docker Compose

1. Copy environment defaults:

   ```bash
   cp .env.example .env
   ```

2. Start the stack:

   ```bash
   docker compose up -d --build
   ```

3. Optional fast-epoch mode for faster local testing:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.fast.yml up -d --build
   ```

The compose stack runs 9 services:

1. `wevibe-postgres`
2. `wevibe-qdrant`
3. `wevibe-chain`
4. `wevibe-umbral`
5. `wevibe-social-graph`
6. `wevibe-faucet`
7. `wevibe-hub`
8. `wevibe-mcp`
9. `wevibe-dashboard`

Default service ports:

- Dashboard: `3000`
- Hub API: `4440`
- Chain RPC / REST / gRPC: `26657` / `1317` / `9090`
- Qdrant API: `6333`
- Social Graph API: `4470`
- Umbral sidecar (internal): `4460`

`db/schema.sql` is applied to Postgres during hub startup (idempotent bootstrap logic), and remains the single schema source of truth for this stack.

> Ollama runs on the host (GPU), not as a Docker service in this compose file.

## Documentation

- Canonical project documentation: <https://github.com/WeVibe-Network/wevibe-docs>
- Self-hosting guide: <https://github.com/WeVibe-Network/wevibe-docs/blob/main/SELF-HOSTING.md>
- Infrastructure/deployment notes: [`./wevibe-infra/`](./wevibe-infra/)

## Links

- docs: <https://github.com/WeVibe-Network/wevibe-docs>
- org: <https://github.com/WeVibe-Network>
- X: <https://x.com/WeVibe_Network>
