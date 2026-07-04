import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createRelayHttpServer } from "../apps/api/src/server.ts";
import { RelayService } from "../packages/core/src/relay-service.ts";
import { FixedClock, InMemoryRelayStore, InMemoryUsageRepository, SequentialIdGenerator, StaticSecretResolver, StubProviderAdapter } from "../packages/adapters/src/in-memory.ts";
import type { ModelRoute, ProviderConfig } from "../packages/core/src/types.ts";

test("TEST-API-001 HTTP route resolve enforces auth tenant scope", async () => {
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
    allowedDataClassifications: ["internal"],
    requiredCapabilities: ["chat"],
    maxCostCents: 5,
    providerId: "local",
    model: "local-demo",
    enabled: true,
  };
  const store = new InMemoryRelayStore([route], [provider]);
  const service = new RelayService({
    routes: store,
    secrets: new StaticSecretResolver(new Map([["secret://local", "sk-test"]])),
    provider: new StubProviderAdapter(),
    audit: store,
    usage: new InMemoryUsageRepository(store),
    idempotency: store,
    clock: new FixedClock(),
    ids: new SequentialIdGenerator(),
  });
  const server = createRelayHttpServer(service);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.notEqual(address, null);
  const port = (address as AddressInfo).port;

  try {
    const ok = await fetch(`http://127.0.0.1:${port}/v1/routes/resolve?purpose=chat&dataClassification=internal&capability=chat&maxCostCents=5`, {
      headers: {
        authorization: "Bearer dev:actor_1:tenant_a:relay:invoke",
        "x-tenant-id": "tenant_a",
      },
    });
    assert.equal(ok.status, 200);

    const denied = await fetch(`http://127.0.0.1:${port}/v1/routes/resolve?purpose=chat&dataClassification=internal&capability=chat&maxCostCents=5`, {
      headers: {
        authorization: "Bearer dev:actor_1:tenant_b:relay:invoke",
        "x-tenant-id": "tenant_a",
      },
    });
    assert.equal(denied.status, 403);
  } finally {
    server.close();
  }
});
