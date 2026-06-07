# wevibe-infra

`wevibe-infra` is the deployment and operations layer for `wevibe-server`.

> **Alpha status:** the current setup is compose-first. Managed infrastructure automation (Terraform/IaC) is planned, but not implemented yet.

## What this directory contains

- [`Caddyfile`](./Caddyfile) — reverse proxy configuration with automatic TLS support (Let’s Encrypt) when `WEVIBE_DOMAIN` is set.
- [`docs/`](./docs/) — architecture/design references for infrastructure direction.
- [`ROADMAP.md`](./ROADMAP.md) — delivery priorities for near-term and mainnet readiness.

## Current deployment baseline

- Runtime stack definition: [`../docker-compose.yml`](../docker-compose.yml)
- Fast 2-second epoch testing overlay: [`../docker-compose.fast.yml`](../docker-compose.fast.yml)
- Hub container build: [`../Dockerfile.hub`](../Dockerfile.hub) (**Go** service)
- Schema source of truth: [`../db/schema.sql`](../db/schema.sql), applied during hub startup against Postgres

Public endpoint routing in this layer is centered on:

- hub (`4440`)
- dashboard (`3000`)
- social-graph (`4470`)

The checked-in `Caddyfile` currently includes the hub route and security headers; extend route blocks to match your deployment topology for dashboard and social-graph endpoints.

## Related documentation

- Self-hosting guide: <https://github.com/WeVibe-Network/wevibe-docs/blob/main/SELF-HOSTING.md>
- Canonical docs: <https://github.com/WeVibe-Network/wevibe-docs>
