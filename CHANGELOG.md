# Changelog

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
