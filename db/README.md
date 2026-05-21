# WeVibe Hub Database Migrations

This directory contains PostgreSQL schema migrations for `wevibe-hub`.

## Prerequisites

- Install `golang-migrate` CLI: <https://github.com/golang-migrate/migrate/tree/master/cmd/migrate>
- Set `DATABASE_URL` (example: `postgres://wevibe:wevibe_dev@localhost:5433/wevibe_hub?sslmode=disable`)

## Create a new migration

```bash
migrate create -ext sql -dir db/migrations -seq add_feature_name
```

## Apply migrations

Migrations are applied automatically on `wevibe-hub` startup.

```bash
migrate -path db/migrations -database "$DATABASE_URL" up
```

## Roll back one migration

```bash
migrate -path db/migrations -database "$DATABASE_URL" down 1
```

## Show current migration version

```bash
migrate -path db/migrations -database "$DATABASE_URL" version
```

## Local reset behavior

Pre-MVP local development can still reset state with:

```bash
docker compose down -v
```

That reset is no longer required for schema changes because startup migrations now apply incrementally.
