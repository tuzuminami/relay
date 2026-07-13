import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { buildDefaultService, createRelayHttpServer, runtimeProviderEgressPolicy } from "../apps/api/src/server.ts";
import { loadRuntimeAuthAdapter, validateRuntimeAuthMode, type AuthAdapter } from "../apps/api/src/auth.ts";
import { RelayError } from "../packages/core/src/errors.ts";
import { RelayService } from "../packages/core/src/relay-service.ts";
import { FixedClock, InMemoryRelayStore, InMemoryUsageRepository, SequentialIdGenerator, StubProviderAdapter } from "../packages/adapters/src/in-memory.ts";
import type { AuthContext, ModelRoute, ProviderConfig } from "../packages/core/src/types.ts";

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
    veilDecisionVerifier: { verify: async (input) => ({ decisionId: `decision-${input.inputHash}`, tenantId: input.tenantId, requestedAction: input.requestedAction, inputHash: input.inputHash, policyHash: "a".repeat(64), expiresAt: new Date("2030-01-01T00:00:00.000Z") }) },
    veilDecisionReplay: { claim: async () => true },
  });
  return { adapter, service, store };
}

async function withRelayServer<T>(service: RelayService, run: (port: number) => Promise<T>, authAdapter?: AuthAdapter): Promise<T> {
  const server = createRelayHttpServer(service, authAdapter);
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
    "x-veil-enforcement": "test-verified-decision",
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

test("TEST-CONFIG-002 production startup requires an explicit provider origin allowlist", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousProviderKey = process.env.RELAY_PROVIDER_API_KEY;
  const previousAllowedOrigins = process.env.RELAY_PROVIDER_ALLOWED_ORIGINS;
  process.env.NODE_ENV = "production";
  process.env.RELAY_PROVIDER_API_KEY = "sk-test-only";
  delete process.env.RELAY_PROVIDER_ALLOWED_ORIGINS;

  try {
    assert.throws(() => buildDefaultService(), (error) => {
      assert.ok(error instanceof RelayError);
      assert.equal(error.code, "CONFIGURATION_INVALID");
      assert.deepEqual(error.details, ["BASE_URL_ORIGIN_NOT_ALLOWED"]);
      return true;
    });
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
    if (previousAllowedOrigins === undefined) {
      delete process.env.RELAY_PROVIDER_ALLOWED_ORIGINS;
    } else {
      process.env.RELAY_PROVIDER_ALLOWED_ORIGINS = previousAllowedOrigins;
    }
  }
});

test("TEST-CONFIG-003 production auth mode enables fail-closed provider egress without NODE_ENV", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousAuthAdapter = process.env.RELAY_AUTH_ADAPTER;
  const previousAllowedOrigins = process.env.RELAY_PROVIDER_ALLOWED_ORIGINS;
  delete process.env.NODE_ENV;
  process.env.RELAY_AUTH_ADAPTER = "production";
  delete process.env.RELAY_PROVIDER_ALLOWED_ORIGINS;

  try {
    assert.throws(() => runtimeProviderEgressPolicy(), (error) => {
      assert.ok(error instanceof RelayError);
      assert.deepEqual(error.details, ["BASE_URL_ORIGIN_NOT_ALLOWED"]);
      return true;
    });
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousAuthAdapter === undefined) delete process.env.RELAY_AUTH_ADAPTER;
    else process.env.RELAY_AUTH_ADAPTER = previousAuthAdapter;
    if (previousAllowedOrigins === undefined) delete process.env.RELAY_PROVIDER_ALLOWED_ORIGINS;
    else process.env.RELAY_PROVIDER_ALLOWED_ORIGINS = previousAllowedOrigins;
  }
});

test("TEST-CONFIG-004 unknown runtime and auth modes fail at startup", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousAuthAdapter = process.env.RELAY_AUTH_ADAPTER;
  try {
    process.env.NODE_ENV = "staging";
    process.env.RELAY_AUTH_ADAPTER = "development";
    assert.throws(() => runtimeProviderEgressPolicy(), RelayError);

    process.env.NODE_ENV = "development";
    process.env.RELAY_AUTH_ADAPTER = "passthrough";
    assert.throws(() => validateRuntimeAuthMode(), RelayError);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousAuthAdapter === undefined) delete process.env.RELAY_AUTH_ADAPTER;
    else process.env.RELAY_AUTH_ADAPTER = previousAuthAdapter;
  }
});

test("TEST-CONFIG-005 production requires VEIL verification and persistent replay protection", () => {
  const keys = [
    "NODE_ENV",
    "RELAY_PROVIDER_API_KEY",
    "RELAY_PROVIDER_ALLOWED_ORIGINS",
    "RELAY_DATABASE_URL",
    "RELAY_VEIL_ISSUER",
    "RELAY_VEIL_AUDIENCE",
    "RELAY_VEIL_JWKS_URL",
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.NODE_ENV = "production";
    process.env.RELAY_PROVIDER_API_KEY = "sk-test-only";
    process.env.RELAY_PROVIDER_ALLOWED_ORIGINS = "https://api.openai.com";
    delete process.env.RELAY_DATABASE_URL;
    delete process.env.RELAY_VEIL_ISSUER;
    delete process.env.RELAY_VEIL_AUDIENCE;
    delete process.env.RELAY_VEIL_JWKS_URL;
    assert.throws(() => buildDefaultService(), (error) => error instanceof RelayError && error.code === "CONFIGURATION_INVALID");

    process.env.RELAY_VEIL_ISSUER = "https://veil.example.test";
    process.env.RELAY_VEIL_AUDIENCE = "relay-api";
    process.env.RELAY_VEIL_JWKS_URL = "https://veil.example.test/.well-known/jwks.json";
    assert.throws(
      () => buildDefaultService(),
      (error) => error instanceof RelayError && error.code === "CONFIGURATION_INVALID" && error.message.includes("RELAY_DATABASE_URL"),
    );
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
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

test("TEST-AUTH-003 awaits a production authentication adapter before route resolution", async () => {
  const { service, adapter } = buildApiFixture();
  const asyncAuthAdapter: AuthAdapter = {
    async authenticate(): Promise<AuthContext> {
      await Promise.resolve();
      return { actorId: "actor_1", tenantId: "tenant_a", scopes: ["relay:invoke"], authAdapter: "production" };
    },
  };

  await withRelayServer(service, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/routes/resolve?purpose=chat&dataClassification=internal&capability=chat&maxCostCents=5`, {
      headers: { authorization: "Bearer async", "x-tenant-id": "tenant_a" },
    });
    assert.equal(response.status, 200);
    assert.equal(adapter.calls, 0);
  }, asyncAuthAdapter);
});

test("TEST-AUTH-004 rejects authentication failures before provider I/O", async () => {
  const invalidCredentials = buildApiFixture();
  const rejectedAdapter: AuthAdapter = {
    async authenticate() {
      throw new RelayError("AUTHENTICATION_REQUIRED", "Authentication is required.", 401);
    },
  };
  await withRelayServer(invalidCredentials.service, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: chatBody("never sent"),
    });
    assert.equal(response.status, 401);
    assert.equal(invalidCredentials.adapter.calls, 0);
  }, rejectedAdapter);

  const dependencyFailure = buildApiFixture();
  const failingAdapter: AuthAdapter = { async authenticate() { throw new Error("jwks unavailable"); } };
  await withRelayServer(dependencyFailure.service, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: chatBody("never sent"),
    });
    const payload = await response.json() as { error: { code: string; details: string[] } };
    assert.equal(response.status, 503);
    assert.equal(payload.error.code, "DEPENDENCY_UNAVAILABLE");
    assert.deepEqual(payload.error.details, ["auth_adapter_unavailable"]);
    assert.equal(dependencyFailure.adapter.calls, 0);
  }, failingAdapter);
});

test("TEST-AUTH-005 rejects malformed asynchronous identities before route or provider access", async () => {
  const fixture = buildApiFixture();
  const malformedAdapter: AuthAdapter = {
    async authenticate() {
      return { actorId: "actor_1", tenantId: "tenant_a", scopes: "relay:invoke", authAdapter: "production" } as unknown as AuthContext;
    },
  };

  await withRelayServer(fixture.service, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: chatBody("never sent"),
    });
    const payload = await response.json() as { error: { code: string; details: string[] } };
    assert.equal(response.status, 503);
    assert.equal(payload.error.code, "DEPENDENCY_UNAVAILABLE");
    assert.deepEqual(payload.error.details, ["auth_adapter_invalid_response"]);
    assert.equal(fixture.adapter.calls, 0);
  }, malformedAdapter);
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

test("TEST-API-005 HTTP chat requires VEIL enforcement before provider I/O", async () => {
  const { adapter, service } = buildApiFixture();
  await withRelayServer(service, async (port) => {
    const { "x-veil-enforcement": _veilEnforcement, ...headers } = authHeaders();
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": "idem_missing_veil" },
      body: chatBody("hello"),
    });
    const payload = await response.json() as { error: { code: string } };
    assert.equal(response.status, 403);
    assert.equal(payload.error.code, "VEIL_DECISION_REQUIRED");
  });
  assert.equal(adapter.calls, 0);
});
