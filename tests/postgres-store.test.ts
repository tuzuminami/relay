import assert from "node:assert/strict";
import test from "node:test";
import { PostgresRelayStore, type PgClientLike, type PgPoolLike, type PgQueryResult } from "../packages/adapters/src/postgres.ts";
import type { AuditEvent, ChatCompletionResponse, UsageRecord } from "../packages/core/src/types.ts";

class FakeClient implements PgClientLike {
  readonly queries: { readonly text: string; readonly values: readonly unknown[] }[] = [];

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<PgQueryResult<Row>> {
    this.queries.push({ text, values });
    if (text.startsWith("INSERT INTO relay_idempotency_records") || text.startsWith("UPDATE relay_idempotency_records")) {
      return { rowCount: 1, rows: [] };
    }
    return { rowCount: null, rows: [] };
  }

  release(): void {
    this.queries.push({ text: "RELEASE", values: [] });
  }
}

class FakePool implements PgPoolLike {
  readonly queries: { readonly text: string; readonly values: readonly unknown[] }[] = [];
  readonly client = new FakeClient();

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<PgQueryResult<Row>> {
    this.queries.push({ text, values });
    return { rowCount: 0, rows: [] };
  }

  async connect(): Promise<PgClientLike> {
    return this.client;
  }
}

test("TEST-DB-001 route lookup uses tenant_id predicate", async () => {
  const pool = new FakePool();
  const store = new PostgresRelayStore(pool);

  await store.listRoutesForTenant("tenant_a");

  assert.equal(pool.queries.length, 1);
  const query = pool.queries[0];
  assert.ok(query);
  assert.match(query.text, /WHERE tenant_id = \$1/);
  assert.deepEqual(query.values, ["tenant_a"]);
});

test("TEST-DB-005 provider lookup uses tenant_id and provider_id predicates", async () => {
  const pool = new FakePool();
  const store = new PostgresRelayStore(pool);

  await store.getProvider("tenant_a", "local");

  assert.equal(pool.queries.length, 1);
  const query = pool.queries[0];
  assert.ok(query);
  assert.match(query.text, /WHERE tenant_id = \$1 AND provider_id = \$2/);
  assert.deepEqual(query.values, ["tenant_a", "local"]);
});

test("TEST-DB-003 usage lookup uses tenant_id predicate", async () => {
  const pool = new FakePool();
  const store = new PostgresRelayStore(pool);

  await store.listForTenant("tenant_a");

  assert.equal(pool.queries.length, 1);
  const query = pool.queries[0];
  assert.ok(query);
  assert.match(query.text, /WHERE tenant_id = \$1/);
  assert.deepEqual(query.values, ["tenant_a"]);
});

test("TEST-DB-004 idempotency lookup uses tenant_id and key predicates", async () => {
  const pool = new FakePool();
  const store = new PostgresRelayStore(pool);

  await store.get("tenant_a", "idem_1");

  assert.equal(pool.queries.length, 1);
  const query = pool.queries[0];
  assert.ok(query);
  assert.match(query.text, /WHERE tenant_id = \$1 AND idempotency_key = \$2/);
  assert.deepEqual(query.values, ["tenant_a", "idem_1"]);
});

test("TEST-DB-002 completion persistence uses one transaction and records idempotency before evidence", async () => {
  const pool = new FakePool();
  const store = new PostgresRelayStore(pool);
  const response: ChatCompletionResponse = {
    id: "chat_1",
    model: "local-demo",
    providerId: "local",
    routeId: "route_1",
    message: { role: "assistant", content: "ok" },
    usage: { inputTokens: 1, outputTokens: 1, estimatedCostCents: 0 },
    terminalReason: "stop",
  };
  const usage: UsageRecord = {
    id: "usage_1",
    tenantId: "tenant_a",
    requestId: "req_1",
    routeId: "route_1",
    providerId: "local",
    model: "local-demo",
    usage: response.usage,
    latencyMs: 4,
    terminalReason: "stop",
    correlationId: "corr_1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  const audit: AuditEvent = {
    id: "audit_1",
    tenantId: "tenant_a",
    actorId: "actor_1",
    action: "relay.chat.complete",
    resourceType: "chat_completion",
    resourceId: "chat_1",
    reasonCode: "CHAT_COMPLETION_ROUTED",
    correlationId: "corr_1",
    metadata: { routeId: "route_1" },
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  await store.recordCompletion({
    tenantId: "tenant_a",
    idempotencyKey: "idem_1",
    requestHash: "hash_1",
    response,
    usage,
    audit,
  });

  const statements = pool.client.queries.map((query) => query.text);
  assert.deepEqual(statements.slice(0, 6), [
    "BEGIN",
    statements[1],
    statements[2],
    statements[3],
    "COMMIT",
    "RELEASE",
  ]);
  assert.match(statements[1] ?? "", /UPDATE relay_idempotency_records/);
  assert.match(statements[2] ?? "", /INSERT INTO relay_usage_records/);
  assert.match(statements[3] ?? "", /INSERT INTO relay_audit_events/);
});
