import assert from "node:assert/strict";
import test from "node:test";
import { RelayError } from "../packages/core/src/errors.ts";
import { OpenAiCompatibleHttpAdapter } from "../packages/adapters/src/openai-compatible.ts";
import { StaticSecretResolver } from "../packages/adapters/src/in-memory.ts";
import type { ProviderChatRequest, ProviderConfig } from "../packages/core/src/types.ts";

const provider: ProviderConfig = {
  tenantId: "tenant_a",
  providerId: "local",
  adapterType: "openai-compatible",
  baseUrl: "http://127.0.0.1:11434",
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
    secretResolver: new StaticSecretResolver(new Map([["secret://local", "sk-secret-must-not-leak"]])),
    timeoutMs: 5,
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
    secretResolver: new StaticSecretResolver(new Map([["secret://local", "sk-adapter-only"]])),
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
