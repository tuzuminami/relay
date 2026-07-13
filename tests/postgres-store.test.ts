import assert from "node:assert/strict";
import test from "node:test";
import { PostgresRelayStore, type PgClientLike, type PgPoolLike, type PgQueryResult } from "../packages/adapters/src/postgres.ts";
import type { AuditEvent, ChatCompletionResponse, UsageRecord } from "../packages/core/src/types.ts";

class FakeClient implements PgClientLike {
  readonly queries: { readonly text: string; readonly values: readonly unknown[] }[] = [];
  replayClaimRowCount = 1;

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<PgQueryResult<Row>> {
    this.queries.push({ text, values });
    if (text.startsWith("INSERT INTO relay_idempotency_records") || text.startsWith("UPDATE relay_idempotency_records")) {
      return { rowCount: 1, rows: [] };
    }
    if (text.startsWith("INSERT INTO relay_veil_decision_replays")) {
      return { rowCount: this.replayClaimRowCount, rows: [] };
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

test("TEST-DB-004 idempotency lookup uses tenant_id, actor_id, and key predicates", async () => {
  const pool = new FakePool();
  const store = new PostgresRelayStore(pool);

  await store.get("tenant_a", "actor_1", "idem_1");

  assert.equal(pool.queries.length, 1);
  const query = pool.queries[0];
  assert.ok(query);
  assert.match(query.text, /WHERE tenant_id = \$1 AND actor_id = \$2 AND idempotency_key = \$3/);
  assert.deepEqual(query.values, ["tenant_a", "actor_1", "idem_1"]);
});

test("TEST-DB-006 VEIL decision replay claim is tenant-scoped and conflict-safe", async () => {
  const pool = new FakePool();
  const store = new PostgresRelayStore(pool);

  const now = new Date("2026-01-01T00:00:00.000Z");
  const claimed = await store.claim({ tenantId: "tenant_a", decisionId: "decision_1", expiresAt: new Date("2030-01-01T00:00:00.000Z"), now });

  assert.equal(claimed, false);
  assert.equal(pool.queries.length, 2);
  assert.match(pool.queries[0]?.text ?? "", /DELETE FROM relay_veil_decision_replays/);
  assert.match(pool.queries[0]?.text ?? "", /expires_at <= \$1/);
  assert.match(pool.queries[0]?.text ?? "", /ORDER BY expires_at ASC/);
  assert.match(pool.queries[0]?.text ?? "", /LIMIT 500/);
  assert.deepEqual(pool.queries[0]?.values, [now]);
  assert.match(pool.queries[1]?.text ?? "", /INSERT INTO relay_veil_decision_replays/);
  assert.match(pool.queries[1]?.text ?? "", /ON CONFLICT \(tenant_id, decision_id\) DO NOTHING/);
  assert.deepEqual(pool.queries[1]?.values, ["tenant_a", "decision_1", new Date("2030-01-01T00:00:00.000Z")]);
});

test("TEST-DB-007 replay rejection cancels only its in-progress idempotency reservation", async () => {
  const pool = new FakePool();
  const store = new PostgresRelayStore(pool);

  await store.cancel("tenant_a", "actor_1", "idem_1", "hash_1");

  assert.equal(pool.queries.length, 1);
  assert.match(pool.queries[0]?.text ?? "", /DELETE FROM relay_idempotency_records/);
  assert.match(pool.queries[0]?.text ?? "", /status = 'in_progress'/);
  assert.deepEqual(pool.queries[0]?.values, ["tenant_a", "actor_1", "idem_1", "hash_1"]);
});

test("TEST-DB-008 PostgreSQL claims a VEIL decision and reserves idempotency in one transaction", async () => {
  const pool = new FakePool();
  const store = new PostgresRelayStore(pool);
  const reservation = await store.reserveWithVeilDecision({
    tenantId: "tenant_a",
    actorId: "actor_1",
    key: "idem_1",
    requestHash: "hash_1",
    decision: {
      tenantId: "tenant_a",
      decisionId: "decision_1",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      now: new Date("2026-01-01T00:00:00.000Z"),
    },
  });

  assert.deepEqual(reservation, { status: "reserved" });
  const statements = pool.client.queries.map((query) => query.text);
  assert.deepEqual(statements.slice(0, 6), [
    "BEGIN",
    statements[1],
    statements[2],
    statements[3],
    "COMMIT",
    "RELEASE",
  ]);
  assert.match(statements[1] ?? "", /DELETE FROM relay_veil_decision_replays/);
  assert.match(statements[2] ?? "", /INSERT INTO relay_veil_decision_replays/);
  assert.match(statements[3] ?? "", /INSERT INTO relay_idempotency_records/);
});

test("TEST-DB-009 replayed VEIL decisions roll back without reserving idempotency", async () => {
  const pool = new FakePool();
  pool.client.replayClaimRowCount = 0;
  const store = new PostgresRelayStore(pool);
  const reservation = await store.reserveWithVeilDecision({
    tenantId: "tenant_a",
    actorId: "actor_1",
    key: "idem_1",
    requestHash: "hash_1",
    decision: {
      tenantId: "tenant_a",
      decisionId: "decision_1",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      now: new Date("2026-01-01T00:00:00.000Z"),
    },
  });

  assert.deepEqual(reservation, { status: "replayed" });
  const statements = pool.client.queries.map((query) => query.text);
  assert.equal(statements.includes("ROLLBACK"), true);
  assert.equal(statements.some((statement) => statement.startsWith("INSERT INTO relay_idempotency_records")), false);
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
    actorId: "actor_1",
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
