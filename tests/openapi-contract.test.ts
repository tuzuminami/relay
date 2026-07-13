import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const openApi = readFileSync("packages/contracts/openapi.yaml", "utf8");

test("TEST-CONTRACT-001 OpenAPI documents route dry-run and idempotency errors", () => {
  assert.match(openApi, /version:\s+0\.2\.0/);
  assert.match(openApi, /\/v1\/routes\/resolve:/);
  assert.match(openApi, /Route resolution is a dry-run and never calls a provider\./);
  assert.match(openApi, /IDEMPOTENCY_CONFLICT/);
  assert.match(openApi, /IDEMPOTENCY_IN_PROGRESS/);
  assert.match(openApi, /IDEMPOTENCY_FAILED/);
  assert.match(openApi, /X-VEIL-Enforcement/);
  assert.match(openApi, /VEIL_DECISION_REQUIRED/);
  assert.match(openApi, /VEIL_DECISION_INVALID/);
  assert.match(openApi, /VEIL_DECISION_REPLAYED/);
});

test("TEST-CONTRACT-002 OpenAPI keeps secret references out of route resolution response", () => {
  const routeResolveSection = openApi.slice(
    openApi.indexOf("  /v1/routes/resolve:"),
    openApi.indexOf("  /v1/chat/completions:"),
  );

  assert.notEqual(routeResolveSection.length, 0);
  assert.equal(routeResolveSection.includes("secretReference"), false);
});
