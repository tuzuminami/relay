# RELAY
<p align="center">
  <img src="./docs/brand/banner.svg" width="100%" alt="RELAY — Inference Gateway" />
</p>

<p align="center"><strong>Part of the Tuzuminami AI Systems reference architecture.</strong><br />Independent packages, designed to compose — without claiming runtime package dependencies.</p>

> **System role:** Route every inference with intent. RELAY enforces tenant-scoped routing to approved providers.

## Ecosystem reference architecture

The map below describes an **intended composition**, not current npm/package dependencies. Every repository remains independently usable and independently versioned. An application verifies a VEIL decision before it invokes RELAY; this does not indicate direct VEIL-to-RELAY SDK integration.

```mermaid
flowchart LR
  ASTER["ASTER<br/>Persona contracts"] -->|"compiled artifact reference"| DRIFT["DRIFT<br/>Scenarios & replay"]
  MORROW["MORROW<br/>Consent-aware memory"] --> APP["AI application"]
  TETHER["TETHER<br/>Relationship state"] --> APP
  APP -->|"action context"| VEIL["VEIL<br/>Policy decision"]
  APP -->|"model request after decision verification"| RELAY["RELAY<br/>Inference gateway"]
  RELAY --> PROVIDER["Model / tool provider"]
  PULSE["PULSE<br/>Evaluation harness"] -. "evaluates HTTP targets" .-> APP
  PULSE -.-> VEIL
  PULSE -.-> RELAY
  classDef policy fill:#1D2645,stroke:#6FF6C8,color:#FFFFFF
  classDef relationship fill:#3C144C,stroke:#E82973,color:#FFFFFF
  classDef gateway fill:#113A48,stroke:#31D2C9,color:#FFFFFF
  classDef eval fill:#3F215A,stroke:#E8A1FF,color:#FFFFFF
  classDef memory fill:#3D3A20,stroke:#EFD576,color:#FFFFFF
  classDef orchestration fill:#1D3942,stroke:#6DD9DF,color:#FFFFFF
  classDef persona fill:#3B1E14,stroke:#FFC79F,color:#FFFFFF
  class VEIL policy
  class TETHER relationship
  class RELAY gateway
  class PULSE eval
  class MORROW memory
  class DRIFT orchestration
  class ASTER persona
```

| System | What it contributes |
| --- | --- |
| [VEIL](https://github.com/tuzuminami/veil) | Fail-closed policy decisions and receipts before agent actions. |
| [TETHER](https://github.com/tuzuminami/tether) | Explicit, explainable relationship state. |
| [RELAY](https://github.com/tuzuminami/relay) | Tenant-aware inference routing and provider enforcement. |
| [PULSE](https://github.com/tuzuminami/pulse) | Regression evaluation for HTTP targets and release evidence. |
| [MORROW](https://github.com/tuzuminami/morrow) | Consent, purpose, retention, and revocation-aware memory. |
| [DRIFT](https://github.com/tuzuminami/drift) | Deterministic scenario/session orchestration and replay. |
| [ASTER](https://github.com/tuzuminami/aster) | Versioned persona contracts compiled into portable artifacts. |



RELAY is a small, self-hostable inference gateway for routing normalized chat
requests to local or OpenAI-compatible providers only when tenant, data
classification, capability, and cost constraints permit the route.

This repository is intentionally narrow. It does not train models, provide a
secret vault, or promise feature parity across providers.

## Status

RELAY V1.0.0 is a narrow Policy Enforcement Point for VEIL-governed model
requests. It resolves an approved route before a provider call, rather than
trying to compete as a general-purpose inference gateway.

- Route dry-run: `GET /v1/routes/resolve`
- Chat completion: `POST /v1/chat/completions`
- Production auth-module boundary with verified tenant-scope enforcement
- Deterministic route checks before any provider call
- Secret references resolved only at the adapter boundary
- Append-only audit and usage records
- Idempotency for chat completion writes
- Bounded timeout handling for OpenAI-compatible provider calls
- Public private-boundary guard for tracked and staged files

## Quick Start

```bash
pnpm install
pnpm run verify
```

Start PostgreSQL for local integration work:

```bash
docker compose up -d postgres
pnpm run db:migrate
pnpm run db:seed
```

Start the API in development mode:

```bash
export RELAY_DATABASE_URL=postgres://relay:relay_dev_password@127.0.0.1:54329/relay
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

Production requires `RELAY_AUTH_ADAPTER=production` and a `RELAY_AUTH_MODULE`
that exports `authAdapter.authenticate(authorization, tenantHeader)`. The
adapter is responsible for returning verified actor, tenant, and scopes;
development bearer tokens are rejected in production. Provider credentials are
configured as secret references and are not included in public
configuration exports, audit events, usage records, or test fixtures.

Production provider egress is fail-closed. Set `RELAY_PROVIDER_ALLOWED_ORIGINS`
to a comma-separated list of exact HTTPS origins (for example,
`https://api.openai.com`). RELAY rejects provider URLs outside that allowlist,
non-HTTPS URLs, redirects, loopback/private/link-local/metadata targets, and
numeric or IPv6 host forms. Provider secrets are resolved only after this check.

When `RELAY_DATABASE_URL` is set, the API uses PostgreSQL-backed route, usage,
audit, and idempotency adapters. Without it, the API uses in-memory development
fixtures only.

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
