import { readFile } from "node:fs/promises";
import { Pool } from "pg";

const databaseUrl = process.env.RELAY_DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) {
  process.stderr.write("RELAY_DATABASE_URL is required\n");
  process.exit(1);
}

const files = process.argv.slice(2);
if (files.length === 0) {
  process.stderr.write("Usage: node scripts/apply-sql.mjs <sql-file> [...sql-file]\n");
  process.exit(1);
}

const pool = new Pool({
  connectionString: databaseUrl,
  connectionTimeoutMillis: 2_000,
  idleTimeoutMillis: 5_000,
  allowExitOnIdle: true,
});

try {
  for (const file of files) {
    const sql = await readFile(file, "utf8");
    await pool.query(sql);
    process.stdout.write(`applied ${file}\n`);
  }
} finally {
  await pool.end();
}
