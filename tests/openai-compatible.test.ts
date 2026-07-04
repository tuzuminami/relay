import assert from "node:assert/strict";
import test from "node:test";
import { RelayError } from "../packages/core/src/errors.ts";
import { OpenAiCompatibleHttpAdapter } from "../packages/adapters/src/openai-compatible.ts";
import type { ProviderChatRequest, ProviderConfig } from "../packages/core/src/types.ts";

const provider: ProviderConfig = {
  providerId: "local",
  adapterType: "openai-compatible",
  baseUrl: "http://127.0.0.1:11434",
  capabilities: ["chat"],
  secretReference: "secret://local",
  enabled: true,
};

const request: ProviderChatRequest = {
  provider,
  secretValue: "sk-secret-must-not-leak",
  model: "local-demo",
  messages: [{ role: "user", content: "hello" }],
  correlationId: "corr_1",
};

test("TEST-FAILCLOSED-001 provider timeout maps to typed safe failure without leaking secret", async () => {
  const adapter = new OpenAiCompatibleHttpAdapter({
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
