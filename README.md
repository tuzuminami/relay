# RELAY

RELAY is a small, self-hostable inference gateway for routing normalized chat
requests to local or OpenAI-compatible providers only when tenant, data
classification, capability, and cost constraints permit the route.

This repository is intentionally narrow. It does not train models, provide a
secret vault, or promise feature parity across providers.

## Current MVP

- Route dry-run: `GET /v1/routes/resolve`
- Chat completion: `POST /v1/chat/completions`
- Development/test auth adapter with tenant-scope enforcement
- Deterministic route checks before any provider call
- Secret references resolved only at the adapter boundary
- Append-only audit and usage records
- Idempotency for chat completion writes
- Bounded timeout handling for OpenAI-compatible provider calls
- Public private-boundary guard for tracked and staged files

## Quick Start

```bash
pnpm install
pnpm run check:private-boundary
pnpm run build
pnpm test
```

Start PostgreSQL for local integration work:

```bash
docker compose up -d postgres
```

Start the API in development mode:

```bash
pnpm run start:api
```

Development auth uses an explicit local-only bearer token format:

```text
Authorization: Bearer dev:actor_1:tenant_demo:relay:invoke
X-Tenant-Id: tenant_demo
X-Correlation-Id: corr_demo
```

## Example

Resolve a route without sending data to a provider:

```bash
curl -s "http://127.0.0.1:8787/v1/routes/resolve?purpose=chat&dataClassification=internal&capability=chat&maxCostCents=10" \
  -H "Authorization: Bearer dev:actor_1:tenant_demo:relay:invoke" \
  -H "X-Tenant-Id: tenant_demo"
```

Submit a chat completion:

```bash
curl -s "http://127.0.0.1:8787/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer dev:actor_1:tenant_demo:relay:invoke" \
  -H "X-Tenant-Id: tenant_demo" \
  -H "Idempotency-Key: idem_demo_1" \
  -d '{
    "model": "local-demo",
    "purpose": "chat",
    "dataClassification": "internal",
    "messages": [{"role": "user", "content": "hello"}],
    "requiredCapabilities": ["chat"],
    "maxCostCents": 10
  }'
```

## Configuration Notes

Production startup fails if the development auth adapter is enabled. Provider
credentials are configured as secret references and are not included in public
configuration exports, audit events, usage records, or test fixtures.

## Repository Boundary

This public repository must contain only public-safe source code,
documentation, contracts, and synthetic tests. Run the guard before committing:

```bash
pnpm run check:private-boundary
```

The guard is conservative and fails closed when it cannot inspect Git-tracked or
staged files.

## License

Apache-2.0.
