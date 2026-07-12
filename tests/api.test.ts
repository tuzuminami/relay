import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { buildDefaultService, createRelayHttpServer } from "../apps/api/src/server.ts";
import { loadRuntimeAuthAdapter, validateRuntimeAuthMode } from "../apps/api/src/auth.ts";
import { RelayError } from "../packages/core/src/errors.ts";
import { RelayService } from "../packages/core/src/relay-service.ts";
import { FixedClock, InMemoryRelayStore, InMemoryUsageRepository, SequentialIdGenerator, StubProviderAdapter } from "../packages/adapters/src/in-memory.ts";
import type { ModelRoute, ProviderConfig } from "../packages/core/src/types.ts";

const apiProvider: ProviderConfig = {
  tenantId: "tenant_a",
  providerId: "local",
  adapterType: "openai-compatible",
  baseUrl: "http://127.0.0.1:9999",
  capabilities: ["chat"],
  secretReference: "secret://local",
  enabled: true,
};

const apiRoute: ModelRoute = {
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

function buildApiFixture() {
  const store = new InMemoryRelayStore([apiRoute], [apiProvider]);
  const adapter = new StubProviderAdapter();
  const service = new RelayService({
    routes: store,
    provider: adapter,
    audit: store,
    usage: new InMemoryUsageRepository(store),
    idempotency: store,
    completions: store,
    clock: new FixedClock(),
    ids: new SequentialIdGenerator(),
  });
  return { adapter, service, store };
}

async function withRelayServer<T>(service: RelayService, run: (port: number) => Promise<T>): Promise<T> {
  const server = createRelayHttpServer(service);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.notEqual(address, null);
  try {
    return await run((address as AddressInfo).port);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

function authHeaders(): Record<string, string> {
  return {
    authorization: "Bearer dev:actor_1:tenant_a:relay:invoke",
    "x-tenant-id": "tenant_a",
  };
}

function chatBody(content: string): string {
  return JSON.stringify({
    model: "local-demo",
    purpose: "chat",
    dataClassification: "internal",
    messages: [{ role: "user", content }],
    requiredCapabilities: ["chat"],
    maxCostCents: 5,
  });
}

async function readDataId(response: Response): Promise<string> {
  const payload = await response.json();
  assert.equal(typeof payload, "object");
  assert.notEqual(payload, null);
  const data = (payload as Record<string, unknown>).data;
  assert.equal(typeof data, "object");
  assert.notEqual(data, null);
  const id = (data as Record<string, unknown>).id;
  if (typeof id !== "string") {
    throw new TypeError("response data.id must be a string");
  }
  return id;
}

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

test("TEST-AUTH-002 production auth module selection fails closed when missing", async () => {
  const previousAuthAdapter = process.env.RELAY_AUTH_ADAPTER;
  const previousAuthModule = process.env.RELAY_AUTH_MODULE;
  process.env.RELAY_AUTH_ADAPTER = "production";
  delete process.env.RELAY_AUTH_MODULE;

  try {
    await assert.rejects(
      () => loadRuntimeAuthAdapter(),
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
    if (previousAuthModule === undefined) {
      delete process.env.RELAY_AUTH_MODULE;
    } else {
      process.env.RELAY_AUTH_MODULE = previousAuthModule;
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
  const { service } = buildApiFixture();
  await withRelayServer(service, async (port) => {
    const ok = await fetch(`http://127.0.0.1:${port}/v1/routes/resolve?purpose=chat&dataClassification=internal&capability=chat&maxCostCents=5`, {
      headers: authHeaders(),
    });
    assert.equal(ok.status, 200);

    const denied = await fetch(`http://127.0.0.1:${port}/v1/routes/resolve?purpose=chat&dataClassification=internal&capability=chat&maxCostCents=5`, {
      headers: {
        authorization: "Bearer dev:actor_1:tenant_b:relay:invoke",
        "x-tenant-id": "tenant_a",
      },
    });
    assert.equal(denied.status, 403);
  });
});

test("TEST-API-002 HTTP route dry-run redacts provider secret reference and avoids provider I/O", async () => {
  const { adapter, service } = buildApiFixture();

  await withRelayServer(service, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/routes/resolve?purpose=chat&dataClassification=internal&capability=chat&maxCostCents=5`, {
      headers: authHeaders(),
    });
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.equal(adapter.calls, 0);
    assert.equal(body.includes("secret://local"), false);
  });
});

test("TEST-API-004 HTTP route policy denial returns dry-run envelope", async () => {
  const { adapter, service } = buildApiFixture();

  await withRelayServer(service, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/routes/resolve?purpose=chat&dataClassification=restricted&capability=chat&maxCostCents=5`, {
      headers: authHeaders(),
    });
    const payload = await response.json();
    assert.equal(response.status, 403);
    assert.equal(adapter.calls, 0);
    assert.equal(typeof payload, "object");
    assert.notEqual(payload, null);
    const data = (payload as Record<string, unknown>).data;
    assert.equal(typeof data, "object");
    assert.notEqual(data, null);
    assert.equal((data as Record<string, unknown>).allowed, false);
    assert.equal((payload as Record<string, unknown>).error, undefined);
  });
});

test("TEST-API-003 HTTP chat idempotency replays response and usage stays redacted", async () => {
  const { adapter, service } = buildApiFixture();
  const rawPrompt = "raw prompt must not leave completion boundary";

  await withRelayServer(service, async (port) => {
    const first = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        ...authHeaders(),
        "content-type": "application/json",
        "idempotency-key": "idem_http_1",
      },
      body: chatBody(rawPrompt),
    });
    const firstId = await readDataId(first);
    assert.equal(first.status, 200);

    const second = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        ...authHeaders(),
        "content-type": "application/json",
        "idempotency-key": "idem_http_1",
      },
      body: chatBody(rawPrompt),
    });
    const secondId = await readDataId(second);
    assert.equal(second.status, 200);
    assert.equal(secondId, firstId);
    assert.equal(adapter.calls, 1);

    const usage = await fetch(`http://127.0.0.1:${port}/v1/usage`, {
      headers: authHeaders(),
    });
    const usageBody = await usage.text();
    assert.equal(usage.status, 200);
    assert.equal(usageBody.includes(rawPrompt), false);
    assert.equal(usageBody.includes("secret://local"), false);
  });
});
