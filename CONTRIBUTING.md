# Contributing

Thank you for helping improve RELAY.

Before opening a pull request:

1. Run `pnpm run check:private-boundary`.
2. Run `pnpm run build`.
3. Run `pnpm test`.
4. Keep fixtures synthetic. Do not include secrets or production conversation data.

Core changes should preserve tenant isolation, typed errors, explicit capability
checks, and append-only audit behavior.
