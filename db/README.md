# WeVibe Hub Database Schema

`db/schema.sql` is the single source of truth for the hub Postgres schema.

There are no numbered migration files in pre-MVP development. The hub loads
and applies `schema.sql` directly at startup (`internal/db/migrate.go`).

## Changing the schema

1. Edit `db/schema.sql`.
2. Reset local database volumes.
3. Restart the stack.

```bash
docker compose down -v
docker compose -f docker-compose.yml -f docker-compose.fast.yml up -d --build
```

## Notes

- Schema changes are destructive in pre-MVP local/dev environments.
- Do not add `db/migrations/*` files.
