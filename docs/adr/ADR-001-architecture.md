# ADR-001: Hexagonal RELAY Core

## Status

Accepted.

## Context

RELAY needs to call provider adapters while preserving tenant isolation, route
policy, secret-reference handling, usage records, and audit evidence.

## Decision

The repository separates transport, application/domain logic, contracts, and
adapters:

- `apps/api` owns HTTP mapping and auth context extraction.
- `packages/core` owns route policy, typed errors, use cases, and ports.
- `packages/adapters` owns provider, secret, persistence, and test adapters.
- `packages/contracts` owns released OpenAPI and JSON Schema artifacts.

## Consequences

Provider-specific behavior stays behind adapter interfaces. Production auth and
storage adapters can replace the current development/test implementations
without changing the core route policy.
