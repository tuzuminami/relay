import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("TEST-MIGRATION-CLI-001 migration runner rejects positional SQL paths", () => {
  assert.throws(
    () => execFileSync("node", ["scripts/apply-sql.mjs", "--migrate", "db/migrations/0001_initial.sql"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    /Usage: node scripts\/apply-sql\.mjs --migrate/,
  );
});

test("TEST-MIGRATION-CLI-002 migration runner enforces a distinct production migration URL", () => {
  const { RELAY_MIGRATION_DATABASE_URL: _ignoredMigrationUrl, ...inheritedEnvironment } = process.env;
  const productionEnvironment = {
    ...inheritedEnvironment,
    RELAY_AUTH_ADAPTER: "production",
    RELAY_DATABASE_URL: "postgres://runtime:runtime@127.0.0.1:5432/relay",
  };
  assert.throws(
    () => execFileSync("node", ["scripts/apply-sql.mjs", "--migrate"], { encoding: "utf8", env: productionEnvironment, stdio: ["ignore", "pipe", "pipe"] }),
    /Production migrations require RELAY_MIGRATION_DATABASE_URL/,
  );
  assert.throws(
    () => execFileSync("node", ["scripts/apply-sql.mjs", "--migrate"], { encoding: "utf8", env: { ...productionEnvironment, NODE_ENV: "production", RELAY_AUTH_ADAPTER: "development" }, stdio: ["ignore", "pipe", "pipe"] }),
    /Production migrations require RELAY_MIGRATION_DATABASE_URL/,
  );
  assert.throws(
    () => execFileSync("node", ["scripts/apply-sql.mjs", "--migrate"], { encoding: "utf8", env: { ...productionEnvironment, RELAY_MIGRATION_DATABASE_URL: productionEnvironment.RELAY_DATABASE_URL }, stdio: ["ignore", "pipe", "pipe"] }),
    /Production migrations require a database URL distinct from RELAY_DATABASE_URL/,
  );
});
