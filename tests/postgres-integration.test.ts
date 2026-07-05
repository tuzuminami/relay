import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { PostgresRelayStore } from "../packages/adapters/src/postgres.ts";

test("TEST-DB-INT-001 PostgreSQL seed exposes only tenant-scoped route", { skip: process.env.RELAY_DATABASE_URL === undefined }, async () => {
  const pool = new Pool({
    connectionString: process.env.RELAY_DATABASE_URL,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 5_000,
    allowExitOnIdle: true,
  });
  try {
    const store = new PostgresRelayStore(pool);
    const tenantRoutes = await store.listRoutesForTenant("tenant_demo");
    const foreignRoutes = await store.listRoutesForTenant("tenant_other");

    assert.equal(tenantRoutes.length, 1);
    assert.equal(tenantRoutes[0]?.tenantId, "tenant_demo");
    assert.equal(foreignRoutes.length, 0);
  } finally {
    await pool.end();
  }
});
