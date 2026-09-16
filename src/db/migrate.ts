import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { createPool } from "./pool.ts";
import { loadEnvFile, parseEnv } from "../config/env.ts";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

/** Apply forward-only migrations; returns the names of newly applied files. */
export async function runMigrations(pool: pg.Pool): Promise<string[]> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const { rows } = await pool.query<{ name: string }>(`SELECT name FROM schema_migrations`);
  const applied = new Set(rows.map((r) => r.name));

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [file]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    ran.push(file);
  }
  return ran;
}

const isMain = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;
if (isMain) {
  loadEnvFile();
  const env = parseEnv();
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required to run migrations");
  }
  const pool = createPool(env.DATABASE_URL);
  try {
    const ran = await runMigrations(pool);
    process.stdout.write(ran.length ? `Applied: ${ran.join(", ")}\n` : "No pending migrations\n");
  } finally {
    await pool.end();
  }
}