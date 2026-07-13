import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Pool } from "pg";

const [mode, ...files] = process.argv.slice(2);
if (mode !== "--migrate" && mode !== "--seed") {
  process.stderr.write("Usage: node scripts/apply-sql.mjs --migrate | --seed <sql-file> [...sql-file]\n");
  process.exit(1);
}
if (mode === "--seed" && files.length === 0) {
  process.stderr.write("Usage: node scripts/apply-sql.mjs --seed <sql-file> [...sql-file]\n");
  process.exit(1);
}
if (mode === "--migrate" && files.length > 0) {
  process.stderr.write("Usage: node scripts/apply-sql.mjs --migrate\n");
  process.exit(1);
}

const databaseUrl = mode === "--migrate"
  ? process.env.RELAY_MIGRATION_DATABASE_URL ?? process.env.RELAY_DATABASE_URL
  : process.env.RELAY_DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) {
  process.stderr.write(mode === "--migrate" ? "RELAY_MIGRATION_DATABASE_URL or RELAY_DATABASE_URL is required\n" : "RELAY_DATABASE_URL is required\n");
  process.exit(1);
}
const productionRuntime = process.env.NODE_ENV === "production" || process.env.RELAY_AUTH_ADAPTER === "production";
if (mode === "--migrate" && productionRuntime) {
  if (process.env.RELAY_MIGRATION_DATABASE_URL === undefined) {
    process.stderr.write("Production migrations require RELAY_MIGRATION_DATABASE_URL.\n");
    process.exit(1);
  }
  if (process.env.RELAY_MIGRATION_DATABASE_URL === process.env.RELAY_DATABASE_URL) {
    process.stderr.write("Production migrations require a database URL distinct from RELAY_DATABASE_URL.\n");
    process.exit(1);
  }
}

const pool = new Pool({
  connectionString: databaseUrl,
  connectionTimeoutMillis: 2_000,
  idleTimeoutMillis: 5_000,
  allowExitOnIdle: true,
});

try {
  if (mode === "--migrate") {
    await applyMigrations(pool);
  } else {
    await applySeeds(pool, files);
  }
} finally {
  await pool.end();
}

async function applySeeds(pool, seedFiles) {
  for (const file of seedFiles) {
    const sql = await readFile(file, "utf8");
    await pool.query(sql);
    process.stdout.write(`seeded ${file}\n`);
  }
}

async function applyMigrations(pool) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", ["tuzuminami.relay.migrations"]);
    try {
      await client.query(`
        CREATE SCHEMA IF NOT EXISTS relay_meta;
        CREATE TABLE IF NOT EXISTS relay_meta.schema_migrations (
          migration_name text PRIMARY KEY,
          checksum_sha256 text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      const migrations = await loadMigrations();
      const applied = await client.query("SELECT migration_name, checksum_sha256 FROM relay_meta.schema_migrations");
      const appliedChecksums = new Map(applied.rows.map((row) => [row.migration_name, row.checksum_sha256]));
      const knownNames = new Set(migrations.map((migration) => migration.name));
      for (const name of appliedChecksums.keys()) {
        if (!knownNames.has(name)) {
          throw new Error(`Applied migration ${name} is absent from the migration manifest.`);
        }
      }

      for (const migration of migrations) {
        const appliedChecksum = appliedChecksums.get(migration.name);
        if (appliedChecksum !== undefined) {
          if (appliedChecksum !== migration.checksum) {
            throw new Error(`Migration checksum mismatch for ${migration.name}. Applied migrations must not be changed.`);
          }
          process.stdout.write(`skipped ${migration.name}\n`);
          continue;
        }

        await client.query("BEGIN");
        try {
          await client.query(migration.sql);
          await client.query(
            "INSERT INTO relay_meta.schema_migrations (migration_name, checksum_sha256) VALUES ($1, $2)",
            [migration.name, migration.checksum],
          );
          await client.query("COMMIT");
          process.stdout.write(`applied ${migration.name}\n`);
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", ["tuzuminami.relay.migrations"]);
    }
  } finally {
    client.release();
  }
}

async function loadMigrations() {
  const directory = resolve(process.env.RELAY_MIGRATIONS_DIRECTORY ?? "db/migrations");
  const entries = await readdir(directory);
  const sqlEntries = entries.filter((name) => name.endsWith(".sql"));
  const invalidNames = sqlEntries.filter((name) => !/^\d{4}_[a-z0-9_]+\.sql$/.test(name));
  if (invalidNames.length > 0) {
    throw new Error(`Invalid migration filenames: ${invalidNames.sort().join(", ")}.`);
  }
  const names = sqlEntries.sort();
  if (names.length === 0) {
    throw new Error(`No migrations found in ${directory}.`);
  }
  return Promise.all(names.map(async (name) => {
    const file = resolve(directory, name);
    const sql = await readFile(file, "utf8");
    return { name: basename(file), sql, checksum: createHash("sha256").update(sql).digest("hex") };
  }));
}
