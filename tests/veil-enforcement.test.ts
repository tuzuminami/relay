import assert from "node:assert/strict";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { InMemoryRelayStore, InMemoryUsageRepository, SequentialIdGenerator, StubProviderAdapter } from "../packages/adapters/src/in-memory.ts";
import { createVeilDecisionVerifier, InMemoryVeilDecisionReplayStore } from "../packages/adapters/src/veil-enforcement.ts";
import { RelayError } from "../packages/core/src/errors.ts";
import { computeRelayVeilInputHash, RelayService } from "../packages/core/src/relay-service.ts";
import type { ChatCompletionRequest, ModelRoute, ProviderConfig, RequestContext } from "../packages/core/src/types.ts";

const now = new Date("2026-07-13T00:00:00.000Z");
const issuer = "https://veil.example.test";
const audience = "relay-api";

const provider: ProviderConfig = {
  tenantId: "tenant_a",
  providerId: "local",
  adapterType: "openai-compatible",
  baseUrl: "https://provider.example.test",
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

const ctx: RequestContext = {
  auth: { actorId: "actor_1", tenantId: "tenant_a", scopes: ["relay:invoke"], authAdapter: "test" },
  requestId: "req_1",
  correlationId: "corr_1",
  now,
};

const request: ChatCompletionRequest = {
  model: "local-demo",
  purpose: "chat",
  dataClassification: "internal",
  messages: [{ role: "user", content: "hello" }],
  requiredCapabilities: ["chat"],
  maxCostCents: 5,
};

async function signer() {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA");
  const publicJwk = await exportJWK(publicKey);
  return {
    privateKey,
    verifier: createVeilDecisionVerifier({
      issuer,
      audience,
      jwks: { keys: [{ ...publicJwk, kid: "veil-key-1", alg: "EdDSA", use: "sig" }] },
    }),
  };
}

async function issueDecision(privateKey: CryptoKey, overrides: Record<string, unknown> = {}, kid = "veil-key-1"): Promise<string> {
  return new SignJWT({
    tenant_id: "tenant_a",
    action: "ALLOW",
    requested_action: "model_call",
    decision_id: "decision_1",
    input_hash: "a".repeat(64),
    policy_hash: "b".repeat(64),
    receipt_hash: "c".repeat(64),
    ...overrides,
  })
    .setProtectedHeader({ alg: "EdDSA", kid })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt(Math.floor(now.getTime() / 1000) - 1)
    .setExpirationTime(Math.floor(now.getTime() / 1000) + 60)
    .setJti(String(overrides.decision_id ?? "decision_1"))
    .sign(privateKey);
}

class MutableClock {
  current: Date;

  constructor(current: Date) {
    this.current = current;
  }

  now(): Date {
    return new Date(this.current);
  }
}

test("TEST-VEIL-001 verifier accepts only a complete matching VEIL JWS", async () => {
  const { privateKey, verifier } = await signer();
  const token = await issueDecision(privateKey);

  const result = await verifier.verify({
    token,
    tenantId: "tenant_a",
    requestedAction: "model_call",
    inputHash: "a".repeat(64),
    now,
  });

  assert.deepEqual(result, {
    decisionId: "decision_1",
    tenantId: "tenant_a",
    requestedAction: "model_call",
    inputHash: "a".repeat(64),
    policyHash: "b".repeat(64),
    expiresAt: new Date("2026-07-13T00:01:00.000Z"),
  });
});

test("TEST-VEIL-002 verifier rejects forged, expired, cross-tenant, action, hash, and key mismatches", async () => {
  const { privateKey, verifier } = await signer();
  const { privateKey: forgedKey } = await generateKeyPair("EdDSA");
  const cases = [
    issueDecision(forgedKey),
    issueDecision(privateKey, { tenant_id: "tenant_b" }),
    issueDecision(privateKey, { action: "BLOCK" }),
    issueDecision(privateKey, { requested_action: "tool_call" }),
    issueDecision(privateKey, { input_hash: "d".repeat(64) }),
    issueDecision(privateKey, {}, "unknown-key"),
    new SignJWT({ tenant_id: "tenant_a", action: "ALLOW", requested_action: "model_call", decision_id: "expired", input_hash: "a".repeat(64), policy_hash: "b".repeat(64) })
      .setProtectedHeader({ alg: "EdDSA", kid: "veil-key-1" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt(Math.floor(now.getTime() / 1000) - 120)
      .setExpirationTime(Math.floor(now.getTime() / 1000) - 60)
      .setJti("expired")
      .sign(privateKey),
  ];

  for (const token of await Promise.all(cases)) {
    await assert.rejects(
      () => verifier.verify({ token, tenantId: "tenant_a", requestedAction: "model_call", inputHash: "a".repeat(64), now }),
      (error) => error instanceof RelayError && error.code === "VEIL_DECISION_INVALID" && error.status === 403,
    );
  }
});

test("TEST-VEIL-003 Relay permits a matching decision once and never calls a provider for invalid or replayed decisions", async () => {
  const { privateKey, verifier } = await signer();
  const store = new InMemoryRelayStore([route], [provider]);
  const adapter = new StubProviderAdapter();
  const clock = new MutableClock(now);
  const service = new RelayService({
    routes: store,
    provider: adapter,
    audit: store,
    usage: new InMemoryUsageRepository(store),
    idempotency: store,
    completions: store,
    clock,
    ids: new SequentialIdGenerator(),
    veilDecisionVerifier: verifier,
    veilDecisionReplay: new InMemoryVeilDecisionReplayStore(),
  });
  const matchingToken = await issueDecision(privateKey, {
    input_hash: computeRelayVeilInputHash(ctx, request, { allowed: true, reasonCodes: ["ROUTE_ALLOWED"], route, provider }),
  });

  await service.completeChat(ctx, request, "idem_valid", { token: matchingToken });
  assert.equal(adapter.calls, 1);

  await assert.rejects(
    () => service.completeChat(ctx, request, "idem_valid", { token: matchingToken }),
    (error) => error instanceof RelayError && error.code === "VEIL_DECISION_REPLAYED",
  );
  await assert.rejects(
    () => service.completeChat(ctx, request, "idem_replayed", { token: matchingToken }),
    (error) => error instanceof RelayError && error.code === "VEIL_DECISION_REPLAYED",
  );
  const replacementToken = await issueDecision(privateKey, {
    decision_id: "decision_3",
    input_hash: computeRelayVeilInputHash(ctx, request, { allowed: true, reasonCodes: ["ROUTE_ALLOWED"], route, provider }),
  });
  await service.completeChat(ctx, request, "idem_replayed", { token: replacementToken });
  assert.equal(adapter.calls, 2);
  const idempotentRetryToken = await issueDecision(privateKey, {
    decision_id: "decision_4",
    input_hash: computeRelayVeilInputHash(ctx, request, { allowed: true, reasonCodes: ["ROUTE_ALLOWED"], route, provider }),
  });
  await service.completeChat(ctx, request, "idem_valid", { token: idempotentRetryToken });
  assert.equal(adapter.calls, 2);
  const mismatchedToken = await issueDecision(privateKey, { decision_id: "decision_2", input_hash: "e".repeat(64) });
  await assert.rejects(
    () => service.completeChat(ctx, request, "idem_invalid", { token: mismatchedToken }),
    (error) => error instanceof RelayError && error.code === "VEIL_DECISION_INVALID",
  );
  assert.equal(adapter.calls, 2);
});

test("TEST-VEIL-004 expired and over-age decisions fail against the request clock before provider I/O", async () => {
  const { privateKey, verifier } = await signer();
  const store = new InMemoryRelayStore([route], [provider]);
  const adapter = new StubProviderAdapter();
  const clock = new MutableClock(new Date("2026-07-13T00:02:00.000Z"));
  const service = new RelayService({
    routes: store,
    provider: adapter,
    audit: store,
    usage: new InMemoryUsageRepository(store),
    idempotency: store,
    completions: store,
    clock,
    ids: new SequentialIdGenerator(),
    veilDecisionVerifier: verifier,
    veilDecisionReplay: new InMemoryVeilDecisionReplayStore(),
  });
  const expiredToken = await issueDecision(privateKey, {
    input_hash: computeRelayVeilInputHash(ctx, request, { allowed: true, reasonCodes: ["ROUTE_ALLOWED"], route, provider }),
  });

  await assert.rejects(
    () => service.completeChat(ctx, request, "idem_expired", { token: expiredToken }),
    (error) => error instanceof RelayError && error.code === "VEIL_DECISION_INVALID",
  );
  const overAgeToken = await new SignJWT({
    tenant_id: "tenant_a",
    action: "ALLOW",
    requested_action: "model_call",
    decision_id: "over-age",
    input_hash: "a".repeat(64),
    policy_hash: "b".repeat(64),
  })
    .setProtectedHeader({ alg: "EdDSA", kid: "veil-key-1" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt(Math.floor(now.getTime() / 1000) - 360)
    .setExpirationTime(Math.floor(now.getTime() / 1000) + 60)
    .setJti("over-age")
    .sign(privateKey);
  await assert.rejects(
    () => verifier.verify({ token: overAgeToken, tenantId: "tenant_a", requestedAction: "model_call", inputHash: "a".repeat(64), now }),
    (error) => error instanceof RelayError && error.code === "VEIL_DECISION_INVALID",
  );
  assert.equal(adapter.calls, 0);
});
