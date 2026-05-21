# WeVibe Dogfood — Local Development Stack

This document describes how to run the WeVibe network locally for development and testing.

## TL;DR

```bash
make dogfood
```

This runs the full test cycle: tear down stack → bring up Docker stack → run health + pipeline tests → tear down stack.

## Architecture

All WeVibe services run in Docker via `docker compose` EXCEPT for one host process exception documented below (see DECISIONS.md D-13.10).

| Service | Container | Image / Build | Port |
|---|---|---|---|
| Postgres | wevibe-postgres | postgres:16-alpine | 5433 |
| Qdrant | wevibe-qdrant | qdrant/qdrant:v1.9.0 | 6333 |
| wevibe-chain | wevibe-chain | ../wevibe-chain/Dockerfile | 26657, 9090, 1317 |
| wevibe-hub | wevibe-hub | ./Dockerfile.hub | 4440 |
| wevibe-dashboard | wevibe-dashboard | ./wevibe-dashboard/Dockerfile | 3000 |
| wevibe-mcp | wevibe-mcp | ./Dockerfile.wevibe-mcp | 4450 |
| Ollama | **NOT containerized** (see below) | macOS host app | 11434 |

### Host Exceptions

One service runs on the macOS host instead of in containers (see DECISIONS.md D-13.10):

#### Ollama (long-term exception)
Ollama runs natively for Metal GPU acceleration. Container Linux without Metal is dramatically slower for inference. Containers reach Ollama via `host.docker.internal:11434`.

## Common Commands

```bash
# Full test cycle (destroys state)
make dogfood

# Bring up the full stack (wevibe-mcp included)
make docker-up

# Tear down stack + WIPE all volumes
make docker-down

# Check stack health (containers + Ollama host exception)
make health

# Kill any host-process WeVibe services
make stop-host

# Everything: tear down + kill host procs
make clean
```

## Schema Changes (Pre-MVP)

Schema lives at `db/schema.sql`. To change schema:

```bash
# 1. Edit db/schema.sql
# 2. Tear down and wipe volumes
make docker-down

# 3. Bring up fresh stack
make docker-up
```

**Pre-MVP model:** No migrations. Schema is re-applied from `schema.sql` on every fresh Postgres volume. See DECISIONS.md D-13.10.

**Public testnet requires this to change.** See GAP-T2 in MASTER.md.

## Ollama (Host Exception)

Ollama runs natively on macOS via the Ollama.app. Start it manually if needed:

```bash
open /Applications/Ollama.app
```

Containers reach Ollama at `host.docker.internal:11434`.

**wevibe-mcp UNREACHABLE in `make health`:**

wevibe-mcp is containerized. Check its logs:

```bash
cd wevibe-server && docker compose logs -f wevibe-mcp
```

## Troubleshooting

**"connection refused" on port 4440 / 3000 / 26657:**

```bash
# Stack may not have come up. Check status.
docker compose ps

# Watch logs of a specific service
docker compose logs -f wevibe-hub

# Try a clean rebuild
make docker-down
make docker-up
```

**"chain_commit_events does not exist":**

This is a schema issue. The Postgres volume has stale data. Reset:

```bash
make docker-down  # WIPES volumes
make docker-up
```

**Tests fail at random scenarios:**

Tests accumulate state within a single dogfood run. Per CO-253, between-test reset is not supported (the `/v1/test/reset` endpoint was removed). Each `make dogfood` run starts fresh because `docker compose down -v` wipes everything before. Within a run, write tests that use unique IDs per scenario.

## Operating Modes

| Mode | Services | Command |
|---|---|---|
| Full stack | All services + Ollama on host | `make docker-up` |
| Dogfood test | Full stack + tests | `make dogfood` |
| Chain only | Just wevibe-chain (standalone chain dev) | `cd ../wevibe-chain && docker compose up` |
