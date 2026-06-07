# wevibe-infra roadmap

## Status

- `wevibe-server/docker-compose.yml` is the active deployment baseline for local and self-host setups.
- `wevibe-server/docker-compose.fast.yml` provides a fast-epoch overlay for short feedback loops (`WEVIBE_EPOCH_DURATION_SECONDS=2`).
- `wevibe-infra/Caddyfile` is present for reverse proxying and automatic TLS issuance when `WEVIBE_DOMAIN` is configured.
- `wevibe-server/db/schema.sql` is the PostgreSQL schema source of truth and is applied by hub startup logic.
- Overall maturity is still alpha: production automation and hardening are in progress.

## Near-term

- Verify TLS coverage across all public endpoints and document validation checks.
- Finalize and validate public reverse-proxy routes for hub (`4440`), dashboard (`3000`), and social-graph (`4470`).
- Deliver an automated, rate-limited testnet faucet operating profile.
- Expand deployment runbooks for backup, restore, and endpoint health verification.

## Mainnet

- Complete mainnet deployment hardening (secrets handling, network exposure controls, observability, recovery procedures).
- Implement Terraform/IaC automation for repeatable multi-environment deployments.
- Add release-gated infrastructure checks (TLS, health, dependency readiness, rollback safety).

## Design references

- [`../docker-compose.yml`](../docker-compose.yml)
- [`../docker-compose.fast.yml`](../docker-compose.fast.yml)
- [`./Caddyfile`](./Caddyfile)
- [`../db/schema.sql`](../db/schema.sql)
- [`./docs/TOPOLOGY.md`](./docs/TOPOLOGY.md)
- [`./docs/PDP.md`](./docs/PDP.md)
- [`./docs/WHITEPAPER.md`](./docs/WHITEPAPER.md)
- <https://github.com/WeVibe-Network/wevibe-docs/blob/main/SELF-HOSTING.md>
