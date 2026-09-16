import pg from "pg";

/**
 * Build a pg Pool from DATABASE_URL. Same URL shape works for local Postgres
 * (docker compose) and Supabase — Supabase URLs carry `sslmode=require`, which
 * toggles TLS here.
 */
export function createPool(databaseUrl: string): pg.Pool {
  const ssl = /(\?|&)sslmode=require/.test(databaseUrl)
    ? { rejectUnauthorized: false }
    : false;
  return new pg.Pool({ connectionString: databaseUrl, ssl });
}