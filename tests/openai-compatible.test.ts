import assert from "node:assert/strict";
import test from "node:test";
import { RelayError } from "../packages/core/src/errors.ts";
import { OpenAiCompatibleHttpAdapter } from "../packages/adapters/src/openai-compatible.ts";
import { StaticSecretResolver } from "../packages/adapters/src/in-memory.ts";
import type { ProviderChatRequest, ProviderConfig } from "../packages/core/src/types.ts";
import type { Dispatcher } from "undici";

const developmentEgressPolicy = { production: false, allowedOrigins: [] };
const publicAddressResolver = { resolve: async () => ["93.184.216.34"] };

const provider: ProviderConfig = {
  tenantId: "tenant_a",
  providerId: "local",
  adapterType: "openai-compatible",
  baseUrl: "https://provider.example.test",
  capabilities: ["chat"],
  secretReference: "secret://local",
  enabled: true,
};

const request: ProviderChatRequest = {
  provider,
  model: "local-demo",
  messages: [{ role: "user", content: "hello" }],
  correlationId: "corr_1",
};

test("TEST-FAILCLOSED-001 provider timeout maps to typed safe failure without leaking secret", async () => {
  const adapter = new OpenAiCompatibleHttpAdapter({
    secretResolver: new StaticSecretResolver(new Map([["secret://local", { value: "sk-secret-must-not-leak", tenantId: "tenant_a", allowedOrigin: "https://provider.example.test" }]])),
    timeoutMs: 5,
    egressPolicy: developmentEgressPolicy,
    addressResolver: publicAddressResolver,
    fetchFn: (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      }),
  });

  await assert.rejects(() => adapter.completeChat(request), (error) => {
    assert.ok(error instanceof RelayError);
    assert.equal(error.code, "DEPENDENCY_UNAVAILABLE");
    assert.equal(error.status, 503);
    assert.equal(JSON.stringify(error).includes("sk-secret-must-not-leak"), false);
    assert.deepEqual(error.details, ["provider_timeout"]);
    return true;
  });
});

test("TEST-SECRET-002 OpenAI-compatible adapter resolves secret reference inside adapter boundary", async () => {
  let authorizationHeader = "";
  const adapter = new OpenAiCompatibleHttpAdapter({
    secretResolver: new StaticSecretResolver(new Map([["secret://local", { value: "sk-adapter-only", tenantId: "tenant_a", allowedOrigin: "https://provider.example.test" }]])),
    egressPolicy: developmentEgressPolicy,
    addressResolver: publicAddressResolver,
    fetchFn: async (_input, init) => {
      const headers = init.headers as Record<string, string>;
      authorizationHeader = headers.authorization ?? "";
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  await adapter.completeChat(request);

  assert.equal(authorizationHeader, "Bearer sk-adapter-only");
  assert.equal(JSON.stringify(request).includes("sk-adapter-only"), false);
});

test("TEST-SECRET-003 missing adapter secret fails closed before provider fetch", async () => {
  let fetchCalls = 0;
  const adapter = new OpenAiCompatibleHttpAdapter({
    secretResolver: new StaticSecretResolver(new Map()),
    egressPolicy: developmentEgressPolicy,
    addressResolver: publicAddressResolver,
    fetchFn: async () => {
      fetchCalls += 1;
      return new Response("{}", { status: 200 });
    },
  });

  await assert.rejects(() => adapter.completeChat(request), (error) => {
    assert.ok(error instanceof RelayError);
    assert.equal(error.code, "CONFIGURATION_INVALID");
    return true;
  });
  assert.equal(fetchCalls, 0);
});

test("TEST-EGRESS-001 blocked provider origins fail before resolving or sending a secret", async () => {
  let resolved = 0;
  let fetchCalls = 0;
  const adapter = new OpenAiCompatibleHttpAdapter({
    secretResolver: {
      resolveSecret: async () => {
        resolved += 1;
        return "sk-must-not-leak";
      },
    },
    egressPolicy: developmentEgressPolicy,
    addressResolver: publicAddressResolver,
    fetchFn: async () => {
      fetchCalls += 1;
      return new Response("{}", { status: 200 });
    },
  });

  await assert.rejects(() => adapter.completeChat({ ...request, provider: { ...provider, baseUrl: "http://169.254.169.254/latest/meta-data" } }), (error) => {
    assert.ok(error instanceof RelayError);
    assert.equal(error.code, "CONFIGURATION_INVALID");
    assert.deepEqual(error.details, ["BASE_URL_EGRESS_BLOCKED"]);
    assert.equal(JSON.stringify(error).includes("sk-must-not-leak"), false);
    return true;
  });
  assert.equal(resolved, 0);
  assert.equal(fetchCalls, 0);

  for (const baseUrl of ["http://2130706433", "https://[::1]"]) {
    await assert.rejects(() => adapter.completeChat({ ...request, provider: { ...provider, baseUrl } }), (error) => {
      assert.ok(error instanceof RelayError);
      assert.deepEqual(error.details, ["BASE_URL_EGRESS_BLOCKED"]);
      return true;
    });
  }
  assert.equal(resolved, 0);
  assert.equal(fetchCalls, 0);
});

test("TEST-EGRESS-002 production requires HTTPS and an explicit allowed origin, and rejects redirects", async () => {
  let redirectMode: RequestRedirect | undefined;
  const adapter = new OpenAiCompatibleHttpAdapter({
    secretResolver: new StaticSecretResolver(new Map([["secret://local", { value: "sk-safe", tenantId: "tenant_a", allowedOrigin: "https://provider.example.test" }]])),
    egressPolicy: { production: true, allowedOrigins: ["https://provider.example.test"] },
    addressResolver: publicAddressResolver,
    fetchFn: async (_input, init) => {
      redirectMode = init.redirect;
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  await adapter.completeChat(request);
  assert.equal(redirectMode, "error");

  await assert.rejects(() => adapter.completeChat({ ...request, provider: { ...provider, baseUrl: "http://provider.example.test" } }), (error) => {
    assert.ok(error instanceof RelayError);
    assert.deepEqual(error.details, ["BASE_URL_HTTPS_REQUIRED", "BASE_URL_ORIGIN_NOT_ALLOWED"]);
    return true;
  });
});

test("TEST-SECRET-004 resolver receives a tenant and canonical origin binding before fetch", async () => {
  let binding: unknown;
  let fetchCalls = 0;
  const adapter = new OpenAiCompatibleHttpAdapter({
    secretResolver: {
      resolveSecret: async (input) => {
        binding = input;
        return "sk-bound";
      },
    },
    egressPolicy: { production: true, allowedOrigins: ["https://provider.example.test"] },
    addressResolver: publicAddressResolver,
    fetchFn: async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  await adapter.completeChat({ ...request, provider: { ...provider, baseUrl: "https://PROVIDER.example.test./v1" } });
  assert.deepEqual(binding, { tenantId: "tenant_a", reference: "secret://local", allowedOrigin: "https://provider.example.test" });
  assert.equal(fetchCalls, 1);
});

test("TEST-SECRET-005 tenant or origin binding mismatch fails before fetch", async () => {
  let fetchCalls = 0;
  const adapter = new OpenAiCompatibleHttpAdapter({
    secretResolver: new StaticSecretResolver(new Map([["secret://local", { value: "sk-bound", tenantId: "tenant_b", allowedOrigin: "https://provider.example.test" }]])),
    egressPolicy: developmentEgressPolicy,
    addressResolver: publicAddressResolver,
    fetchFn: async () => { fetchCalls += 1; return new Response("{}"); },
  });

  await assert.rejects(() => adapter.completeChat(request), (error) => {
    assert.ok(error instanceof RelayError);
    assert.equal(error.code, "CONFIGURATION_INVALID");
    return true;
  });
  assert.equal(fetchCalls, 0);
});

test("TEST-EGRESS-003 private or rebinding DNS answers fail before secret resolution", async () => {
  for (const addresses of [["10.0.0.8"], ["93.184.216.34", "127.0.0.1"], ["::ffff:127.0.0.1"], ["ff02::1"], ["fec0::1"], ["2001:db8::1"]]) {
    let resolved = 0;
    let fetchCalls = 0;
    const adapter = new OpenAiCompatibleHttpAdapter({
      secretResolver: { resolveSecret: async () => { resolved += 1; return "sk-must-not-leak"; } },
      egressPolicy: { production: true, allowedOrigins: ["https://provider.example.test"] },
      addressResolver: { resolve: async () => addresses },
      fetchFn: async () => { fetchCalls += 1; return new Response("{}"); },
    });

    await assert.rejects(() => adapter.completeChat(request), (error) => {
      assert.ok(error instanceof RelayError);
      assert.deepEqual(error.details, ["BASE_URL_DNS_PRIVATE"]);
      return true;
    });
    assert.equal(resolved, 0);
    assert.equal(fetchCalls, 0);
  }
});

test("TEST-EGRESS-004 pins the request to the validated DNS answer when a hostname rebinds", async () => {
  let lookups = 0;
  let pinnedAddresses: readonly string[] = [];
  let fetchCalls = 0;
  const adapter = new OpenAiCompatibleHttpAdapter({
    secretResolver: new StaticSecretResolver(new Map([["secret://local", { value: "sk-safe", tenantId: "tenant_a", allowedOrigin: "https://provider.example.test" }]])),
    egressPolicy: developmentEgressPolicy,
    addressResolver: {
      resolve: async () => {
        lookups += 1;
        return lookups === 1 ? ["93.184.216.34"] : ["127.0.0.1"];
      },
    },
    dispatcherFactory: (_hostname, addresses) => {
      pinnedAddresses = addresses;
      return { close: async () => {} } as Dispatcher;
    },
    fetchFn: async (_input, init) => {
      fetchCalls += 1;
      assert.ok(init.dispatcher);
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  await adapter.completeChat(request);

  assert.equal(lookups, 1);
  assert.deepEqual(pinnedAddresses, ["93.184.216.34"]);
  assert.equal(fetchCalls, 1);
});
