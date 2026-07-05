import assert from "node:assert/strict";
import test from "node:test";
import { RelayError } from "../packages/core/src/errors.ts";
import { RelayService } from "../packages/core/src/relay-service.ts";
import { parseChatCompletionRequest } from "../packages/core/src/validation.ts";
import { FixedClock, InMemoryRelayStore, InMemoryUsageRepository, SequentialIdGenerator, StaticSecretResolver, StubProviderAdapter } from "../packages/adapters/src/in-memory.ts";
import type { ModelRoute, ProviderConfig, RequestContext } from "../packages/core/src/types.ts";

const provider: ProviderConfig = {
  providerId: "local",
  adapterType: "openai-compatible",
  baseUrl: "http://127.0.0.1:9999",
  capabilities: ["chat"],
  secretReference: "secret://local",
  enabled: true,
};

const route: ModelRoute = {
  routeId: "route_1",
  tenantId: "tenant_a",
  purpose: "chat",
  allowedDataClassifications: ["public", "internal"],
  requiredCapabilities: ["chat"],
  maxCostCents: 5,
  providerId: "local",
  model: "local-demo",
  enabled: true,
};

function fixture() {
  const store = new InMemoryRelayStore([route], [provider]);
  const adapter = new StubProviderAdapter();
  const service = new RelayService({
    routes: store,
    secrets: new StaticSecretResolver(new Map([["secret://local", "sk-test-not-logged"]])),
    provider: adapter,
    audit: store,
    usage: new InMemoryUsageRepository(store),
    idempotency: store,
    completions: store,
    clock: new FixedClock(),
    ids: new SequentialIdGenerator(),
  });
  const ctx: RequestContext = {
    auth: {
      actorId: "actor_1",
      tenantId: "tenant_a",
      scopes: ["relay:invoke"],
      authAdapter: "test",
    },
    requestId: "req_1",
    correlationId: "corr_1",
    now: new Date("2026-01-01T00:00:00.000Z"),
  };
  return { store, adapter, service, ctx };
}

test("TEST-ROUTE-001 route denial happens before provider call", async () => {
  const { service, adapter, ctx } = fixture();
  const request = parseChatCompletionRequest({
    model: "local-demo",
    purpose: "chat",
    dataClassification: "restricted",
    messages: [{ role: "user", content: "hello" }],
    requiredCapabilities: ["chat"],
    maxCostCents: 5,
  });

  await assert.rejects(() => service.completeChat(ctx, request, "idem_1"), (error) => {
    assert.ok(error instanceof RelayError);
    assert.equal(error.code, "POLICY_BLOCKED");
    return true;
  });
  assert.equal(adapter.calls, 0);
});

test("TEST-IDEMP-001 repeated idempotency key returns original response", async () => {
  const { service, adapter, ctx } = fixture();
  const request = parseChatCompletionRequest({
    model: "local-demo",
    purpose: "chat",
    dataClassification: "internal",
    messages: [{ role: "user", content: "hello" }],
    requiredCapabilities: ["chat"],
    maxCostCents: 5,
  });

  const first = await service.completeChat(ctx, request, "idem_1");
  const second = await service.completeChat(ctx, request, "idem_1");

  assert.deepEqual(second, first);
  assert.equal(adapter.calls, 1);
});

test("TEST-IDEMP-002 repeated idempotency key with different request returns conflict before provider I/O", async () => {
  const { service, adapter, ctx } = fixture();
  const firstRequest = parseChatCompletionRequest({
    model: "local-demo",
    purpose: "chat",
    dataClassification: "internal",
    messages: [{ role: "user", content: "hello" }],
    requiredCapabilities: ["chat"],
    maxCostCents: 5,
  });
  const secondRequest = parseChatCompletionRequest({
    model: "local-demo",
    purpose: "chat",
    dataClassification: "internal",
    messages: [{ role: "user", content: "different" }],
    requiredCapabilities: ["chat"],
    maxCostCents: 5,
  });

  await service.completeChat(ctx, firstRequest, "idem_1");
  await assert.rejects(() => service.completeChat(ctx, secondRequest, "idem_1"), (error) => {
    assert.ok(error instanceof RelayError);
    assert.equal(error.code, "IDEMPOTENCY_CONFLICT");
    assert.equal(error.status, 409);
    return true;
  });

  assert.equal(adapter.calls, 1);
});

test("TEST-AUDIT-001 permitted chat records audit and usage without raw prompt", async () => {
  const { service, store, ctx } = fixture();
  const request = parseChatCompletionRequest({
    model: "local-demo",
    purpose: "chat",
    dataClassification: "internal",
    messages: [{ role: "user", content: "private synthetic prompt" }],
    requiredCapabilities: ["chat"],
    maxCostCents: 5,
  });

  await service.completeChat(ctx, request, "idem_1");

  assert.equal(store.auditEvents.length, 1);
  assert.equal(store.usageRecords.length, 1);
  assert.equal(JSON.stringify(store.auditEvents).includes("private synthetic prompt"), false);
  assert.equal(JSON.stringify(store.usageRecords).includes("private synthetic prompt"), false);
});

test("TEST-TENANT-001 foreign tenant cannot use another tenant route", async () => {
  const { service } = fixture();
  const ctx: RequestContext = {
    auth: {
      actorId: "actor_2",
      tenantId: "tenant_b",
      scopes: ["relay:invoke"],
      authAdapter: "test",
    },
    requestId: "req_2",
    correlationId: "corr_2",
    now: new Date("2026-01-01T00:00:00.000Z"),
  };
  const request = parseChatCompletionRequest({
    model: "local-demo",
    purpose: "chat",
    dataClassification: "internal",
    messages: [{ role: "user", content: "hello" }],
    requiredCapabilities: ["chat"],
    maxCostCents: 5,
  });

  await assert.rejects(() => service.completeChat(ctx, request, "idem_1"), RelayError);
});

test("TEST-SECRET-001 secret value does not appear in audit or usage", async () => {
  const { service, store, ctx } = fixture();
  const request = parseChatCompletionRequest({
    model: "local-demo",
    purpose: "chat",
    dataClassification: "internal",
    messages: [{ role: "user", content: "hello" }],
    requiredCapabilities: ["chat"],
    maxCostCents: 5,
  });

  await service.completeChat(ctx, request, "idem_1");

  const publicEvidence = JSON.stringify({ audit: store.auditEvents, usage: store.usageRecords });
  assert.equal(publicEvidence.includes("sk-test-not-logged"), false);
});

test("TEST-PROVIDER-001 provider validation audits without exposing secret value", async () => {
  const { service, store, ctx } = fixture();

  const result = await service.validateProvider(ctx, {
    providerId: "candidate",
    adapterType: "openai-compatible",
    baseUrl: "http://127.0.0.1:11434",
    capabilities: ["chat"],
    secretReference: "secret://candidate",
  });

  assert.equal(result.valid, true);
  assert.equal(store.auditEvents.length, 1);
  assert.equal(JSON.stringify(store.auditEvents).includes("secret://candidate"), false);
});
