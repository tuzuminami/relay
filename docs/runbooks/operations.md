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
- `GET /ready` returns a typed safe 503 when its PostgreSQL dependency cannot
  answer `SELECT 1`; it does not authenticate, consume VEIL decisions, or call
  a provider.
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
## Authentication Adapter Availability

Production adapters may resolve identity asynchronously while refreshing JWKS data,
introspecting a token, or consulting an authorization service. RELAY waits for that
work before route resolution or provider I/O. Invalid credentials retain their stable
authentication or tenant-scope error. An adapter dependency failure or malformed identity
returns `503 DEPENDENCY_UNAVAILABLE` with a secret-safe reason code, and no provider is called.

`RELAY_AUTH_TIMEOUT_MS` is parsed before the server starts and bounds an adapter call from 1 to 30,000 milliseconds;
the default is 5,000 milliseconds. A timeout returns
`DEPENDENCY_UNAVAILABLE` with `auth_adapter_timeout`. Adapter failures must use
the public `authAdapterFailure` helper from `@tuzuminami/relay/server` or its three documented codes. The optional adapter `AbortSignal` is aborted at timeout so adapters can cancel their external I/O. RELAY
discards every adapter-owned message, detail, status, and retry hint.

## Secret Resolver Deployment and Rotation

Production requires `RELAY_SECRET_RESOLVER_MODULE` to name a local module that
exports `secretResolver.resolveSecret({ tenantId, reference, allowedOrigin })`.
The resolver owns the connection to the approved secret system and must validate
the complete tenant, reference, and canonical provider-origin binding before it
returns a value. RELAY loads the module before accepting traffic; a missing,
invalid, or unavailable resolver produces only a fixed safe 503 and never
persists resolver diagnostics or secret material.

Rotate provider credentials by adding the new value to the secret system,
updating the tenant-scoped reference mapping, and then revoking the old value
after the deployment has converged. Do not place production values in
`RELAY_PROVIDER_API_KEY`: that variable is development/test-only. Verify the
rollout with `/ready` and one tenant-scoped dry-run before enabling model calls.
