<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:02100a,100:2fe07a&height=160&section=header&text=WeVibe%20Infra&fontColor=54f59a&fontSize=42&fontAlignY=40&desc=Reverse%20proxy%20and%20deployment%20config&descAlignY=64&descSize=16" alt="WeVibe Infra" width="100%" />

![Caddy](https://img.shields.io/badge/Caddy-1F88C0?style=flat-square&logo=caddy&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat-square&logo=docker&logoColor=white)
[![status-alpha](https://img.shields.io/badge/status-alpha-ffc266?style=flat-square)](https://github.com/WeVibe-Network)
[![license-Apache--2.0](https://img.shields.io/badge/license-Apache--2.0-82aaff?style=flat-square)](../LICENSE)
[![docs-wevibe-docs](https://img.shields.io/badge/docs-wevibe--docs-54f59a?style=flat-square)](https://github.com/WeVibe-Network/wevibe-docs)
[![%40WeVibe__Network](https://img.shields.io/badge/%40WeVibe__Network-0a0a0a?style=flat-square&logo=x&logoColor=white)](https://x.com/WeVibe_Network)

</div>

---

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
