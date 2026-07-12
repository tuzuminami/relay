# Changelog

## 1.0.0 - 2026-07-13

- Added a production auth-module boundary. Production startup now requires an
  explicit `RELAY_AUTH_MODULE` that supplies verified tenant, actor, and scopes.
- Finalized the tenant-scoped route dry-run, idempotent chat completion,
  PostgreSQL persistence, audit/usage redaction, and OpenAPI contract.
- Added V1 release verification through the PostgreSQL GitHub Actions service.

## 0.2.0

- Added release-oriented PostgreSQL migration and seed scripts.
- Added CI PostgreSQL service coverage for tenant-scoped route integration.
- Replaced the license text with the full standard Apache License 2.0 text so
  GitHub can detect repository license metadata.

## 0.1.0

- Added the initial RELAY MVP foundation.
- Added tenant-scoped route resolution, chat completion, usage lookup, and
  provider configuration validation.
- Added private-boundary checks for public repository hygiene.
- Renamed the license file to `LICENSE` for standard GitHub license detection.
- Added idempotency-key conflict detection for changed request bodies.
- Added bounded timeout handling for OpenAI-compatible provider calls.
- Added PostgreSQL-backed route, provider, usage, audit, and idempotency
  adapters with transaction-order tests.
