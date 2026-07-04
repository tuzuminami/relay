# Operations Runbook

## Local Start

```bash
docker compose up -d postgres
pnpm run start:api
```

## Required Checks

```bash
pnpm run check:private-boundary
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

## Rollback

The initial migration creates additive tables only. For local development,
rollback is dropping the RELAY database and recreating it from migrations.
