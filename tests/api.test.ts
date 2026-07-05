import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { buildDefaultService, createRelayHttpServer } from "../apps/api/src/server.ts";
import { validateRuntimeAuthMode } from "../apps/api/src/auth.ts";
import { RelayError } from "../packages/core/src/errors.ts";
import { RelayService } from "../packages/core/src/relay-service.ts";
import { FixedClock, InMemoryRelayStore, InMemoryUsageRepository, SequentialIdGenerator, StubProviderAdapter } from "../packages/adapters/src/in-memory.ts";
import type { ModelRoute, ProviderConfig } from "../packages/core/src/types.ts";

test("TEST-AUTH-001 production startup rejects development auth adapter", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousAuthAdapter = process.env.RELAY_AUTH_ADAPTER;
  process.env.NODE_ENV = "production";
  delete process.env.RELAY_AUTH_ADAPTER;

  try {
    assert.throws(
      () => validateRuntimeAuthMode(),
      (error) => {
        assert.ok(error instanceof RelayError);
        assert.equal(error.code, "CONFIGURATION_INVALID");
        return true;
      },
    );
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
    if (previousAuthAdapter === undefined) {
      delete process.env.RELAY_AUTH_ADAPTER;
    } else {
      process.env.RELAY_AUTH_ADAPTER = previousAuthAdapter;
    }
  }
});

test("TEST-AUTH-002 production auth adapter selection fails closed until implemented", () => {
  const previousAuthAdapter = process.env.RELAY_AUTH_ADAPTER;
  process.env.RELAY_AUTH_ADAPTER = "production";

  try {
    assert.throws(
      () => validateRuntimeAuthMode(),
      (error) => {
        assert.ok(error instanceof RelayError);
        assert.equal(error.code, "CONFIGURATION_INVALID");
        return true;
      },
    );
  } finally {
    if (previousAuthAdapter === undefined) {
      delete process.env.RELAY_AUTH_ADAPTER;
    } else {
      process.env.RELAY_AUTH_ADAPTER = previousAuthAdapter;
    }
  }
});

test("TEST-CONFIG-001 production startup rejects placeholder provider credentials", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousProviderKey = process.env.RELAY_PROVIDER_API_KEY;
  const previousDatabaseUrl = process.env.RELAY_DATABASE_URL;
  process.env.NODE_ENV = "production";
  delete process.env.RELAY_PROVIDER_API_KEY;
  delete process.env.RELAY_DATABASE_URL;

  try {
    assert.throws(
      () => buildDefaultService(),
      (error) => {
        assert.ok(error instanceof RelayError);
        assert.equal(error.code, "CONFIGURATION_INVALID");
        return true;
      },
    );
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
    if (previousProviderKey === undefined) {
      delete process.env.RELAY_PROVIDER_API_KEY;
    } else {
      process.env.RELAY_PROVIDER_API_KEY = previousProviderKey;
    }
    if (previousDatabaseUrl === undefined) {
      delete process.env.RELAY_DATABASE_URL;
    } else {
      process.env.RELAY_DATABASE_URL = previousDatabaseUrl;
    }
  }
});

test("TEST-API-001 HTTP route resolve enforces auth tenant scope", async () => {
  const provider: ProviderConfig = {
    tenantId: "tenant_a",
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
    provider: new StubProviderAdapter(),
    audit: store,
    usage: new InMemoryUsageRepository(store),
    idempotency: store,
    completions: store,
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
