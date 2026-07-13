import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Pool } from "pg";

const execFileAsync = promisify(execFile);

const testDatabaseUrl = process.env.RELAY_TEST_DATABASE_URL;

function assertIsolatedTestDatabase(): string {
  if (testDatabaseUrl === undefined) {
    throw new Error("RELAY_TEST_DATABASE_URL is required for migration integration tests.");
  }
  const databaseName = new URL(testDatabaseUrl).pathname.slice(1);
  if (!databaseName.endsWith("_test")) {
    throw new Error("RELAY_TEST_DATABASE_URL must target a database ending in _test.");
  }
  return testDatabaseUrl;
}

async function runMigration(directory?: string): Promise<void> {
  await execFileAsync("node", ["scripts/apply-sql.mjs", "--migrate"], {
    cwd: process.cwd(),
    env: { ...process.env, RELAY_MIGRATION_DATABASE_URL: assertIsolatedTestDatabase(), ...(directory === undefined ? {} : { RELAY_MIGRATIONS_DIRECTORY: directory }) },
  });
}

async function createMigrationDirectory(name: string, sql?: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `relay-migrations-${name}-`));
  await writeFile(join(directory, "0001_initial.sql"), await readFile("db/migrations/0001_initial.sql", "utf8"));
  if (sql !== undefined) {
    await writeFile(join(directory, name), sql);
  }
  return directory;
}

test("TEST-MIGRATION-001 PostgreSQL migrations are repeatable, checksummed, and advisory-lock safe", { skip: testDatabaseUrl === undefined }, async (t) => {
  const pool = new Pool({
    connectionString: assertIsolatedTestDatabase(),
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 5_000,
    allowExitOnIdle: true,
  });
  const concurrentName = `0002_concurrent_${randomUUID().replaceAll("-", "")}.sql`;
  const brokenName = `0002_broken_${randomUUID().replaceAll("-", "")}.sql`;
  const staleName = `9999_missing_${randomUUID().replaceAll("-", "")}.sql`;
  const tableName = `relay_migration_test_${randomUUID().replaceAll("-", "")}`;
  const concurrentDirectory = await createMigrationDirectory(concurrentName, `CREATE TABLE ${tableName} (id integer PRIMARY KEY);\n`);
  const brokenTable = `relay_migration_broken_${randomUUID().replaceAll("-", "")}`;
  const brokenDirectory = await createMigrationDirectory(brokenName, `CREATE TABLE ${brokenTable} (id integer PRIMARY KEY);\nSELECT 1 / 0;\n`);
  const invalidDirectory = await createMigrationDirectory("not-a-migration.sql", "SELECT 1;\n");
  const changedDirectory = await createMigrationDirectory("changed", `${await readFile("db/migrations/0001_initial.sql", "utf8")}\n-- changed\n`);
  await rm(join(changedDirectory, "0001_initial.sql"));
  await writeFile(join(changedDirectory, "0001_initial.sql"), `${await readFile("db/migrations/0001_initial.sql", "utf8")}\n-- changed\n`);
  t.after(async () => {
    await Promise.all([rm(concurrentDirectory, { recursive: true, force: true }), rm(brokenDirectory, { recursive: true, force: true }), rm(invalidDirectory, { recursive: true, force: true }), rm(changedDirectory, { recursive: true, force: true })]);
    try {
      await pool.query(`DROP TABLE IF EXISTS ${tableName}`);
      await pool.query(`DROP TABLE IF EXISTS ${brokenTable}`);
      await pool.query("DELETE FROM relay_meta.schema_migrations WHERE migration_name = ANY($1)", [[concurrentName, brokenName, staleName]]);
    } finally {
      await pool.end();
    }
  });

  await runMigration();
  await pool.query("DELETE FROM relay_meta.schema_migrations");
  await runMigration();
  await runMigration();
  const initialLedger = await pool.query("SELECT migration_name, checksum_sha256 FROM relay_meta.schema_migrations WHERE migration_name = $1", ["0001_initial.sql"]);
  assert.equal(initialLedger.rowCount, 1);
  assert.match(initialLedger.rows[0]?.checksum_sha256 ?? "", /^[a-f0-9]{64}$/);

  await assert.rejects(runMigration(changedDirectory), /Migration checksum mismatch for 0001_initial\.sql/);
  await assert.rejects(runMigration(invalidDirectory), /Invalid migration filenames: not-a-migration\.sql/);
  await pool.query("INSERT INTO relay_meta.schema_migrations (migration_name, checksum_sha256) VALUES ($1, $2)", [staleName, "0".repeat(64)]);
  await assert.rejects(runMigration(), /Applied migration .* is absent from the migration manifest/);
  await pool.query("DELETE FROM relay_meta.schema_migrations WHERE migration_name = $1", [staleName]);

  await Promise.all([runMigration(concurrentDirectory), runMigration(concurrentDirectory)]);
  const concurrentLedger = await pool.query("SELECT migration_name FROM relay_meta.schema_migrations WHERE migration_name = $1", [concurrentName]);
  assert.equal(concurrentLedger.rowCount, 1);

  await assert.rejects(runMigration(brokenDirectory));
  const brokenLedger = await pool.query("SELECT migration_name FROM relay_meta.schema_migrations WHERE migration_name = $1", [brokenName]);
  assert.equal(brokenLedger.rowCount, 0);
  const brokenTableResult = await pool.query("SELECT to_regclass($1) AS table_name", [brokenTable]);
  assert.equal(brokenTableResult.rows[0]?.table_name, null);
});
