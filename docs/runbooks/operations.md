# Operations Runbook

## Local Start

```bash
docker compose up -d postgres
export RELAY_DATABASE_URL=postgres://relay:relay_dev_password@127.0.0.1:54329/relay
export RELAY_MIGRATION_DATABASE_URL="$RELAY_DATABASE_URL"
pnpm run db:migrate
pnpm run db:seed
pnpm run start:api
```

## Required Checks

```bash
pnpm run check:private-boundary
pnpm run check:version
pnpm run build
pnpm test
```

## Failure Behavior

- Missing authentication returns a typed 401 response.
- Tenant mismatch returns a typed 403 response.
- No compliant route returns a typed 403 response before provider I/O.
- Missing secret references return a typed safe failure.
- Reusing an idempotency key with a different request returns a typed conflict
  before provider I/O.
- Provider HTTP timeouts return a typed safe dependency failure.
- When PostgreSQL is enabled, chat completion evidence is recorded through one
  transaction containing idempotency, usage, and audit writes.

## Migrations

`pnpm run db:migrate` discovers only the ordered `db/migrations/NNNN_name.sql`
manifest. It takes a PostgreSQL advisory lock, records SHA-256 checksums in
`relay_meta.schema_migrations`, and applies each pending migration in its own
transaction. Re-running is a no-op; a missing or changed applied migration
fails closed before schema changes proceed.

Production uses a dedicated `RELAY_MIGRATION_DATABASE_URL` and migration role.
Do not grant the runtime role access to the `relay_meta` schema or its migration
ledger. The runner refuses to use `RELAY_DATABASE_URL` as a production fallback.

## Rollback

The initial migration creates additive tables only. For local development,
rollback is dropping the RELAY database and recreating it from migrations.
# Authentication Adapter Availability

Production adapters may resolve identity asynchronously while refreshing JWKS data,
introspecting a token, or consulting an authorization service. RELAY waits for that
work before route resolution or provider I/O. Invalid credentials retain their stable
authentication or tenant-scope error. An adapter dependency failure or malformed identity
returns `503 DEPENDENCY_UNAVAILABLE` with a secret-safe reason code, and no provider is called.
