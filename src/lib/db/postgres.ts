import { Pool, types } from "pg";
import { attachDatabasePool } from "@vercel/functions";
import { schemaSql, auxiliarySchemaSql } from "./schema";

types.setTypeParser(20, (value) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("Database integer exceeds the supported range.");
  return number;
});

/** Translate the small, fixed SQLite dialect used by the shared query layer. */
export function postgresSql(sql: string): string {
  let result = sql.replace(/\bdatetime\('now'\)/gi, "to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')")
    .replace(/\bjulianday\(/gi, "instaloom_timestamp(");
  if (/\bINSERT OR IGNORE\b/i.test(result)) result = result.replace(/\bINSERT OR IGNORE\b/i, "INSERT").replace(/;\s*$/, "") + " ON CONFLICT DO NOTHING";
  let quote = "";
  let parameter = 0;
  let output = "";
  for (let index = 0; index < result.length; index++) {
    const char = result[index];
    if (quote) {
      output += char;
      if (char === quote) {
        if (result[index + 1] === quote) output += result[++index];
        else quote = "";
      }
    } else if (char === "'" || char === '"') { quote = char; output += char; }
    else output += char === "?" ? `$${++parameter}` : char;
  }
  return output;
}

export const TRANSACTION_LOCK = 184923701;

export function createPool(url: string) {
  const pool = new Pool({ connectionString: url, max: 3, idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000, allowExitOnIdle: true });
  // Idle connections can close when a serverless database sleeps. pg replaces
  // them; handle the event without logging connection details or credentials.
  pool.on("error", () => console.error("An idle database connection closed unexpectedly."));
  if (process.env.VERCEL) attachDatabasePool(pool);
  return pool;
}

export async function migratePostgres(pool: Pool) {
  const client = await pool.connect();
  try {
    const exists = await client.query("SELECT to_regclass('public.instaloom_migrations') AS name");
    if (exists.rows[0].name && (await client.query("SELECT version FROM instaloom_migrations WHERE version = 1")).rowCount) return;
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '20s'");
    await client.query("SELECT pg_advisory_xact_lock($1)", [TRANSACTION_LOCK]);
    await client.query("CREATE TABLE IF NOT EXISTS instaloom_migrations (version INTEGER PRIMARY KEY)");
    if (!(await client.query("SELECT version FROM instaloom_migrations WHERE version = 1")).rowCount) {
      const schema = postgresSql(schemaSql + auxiliarySchemaSql)
        .replace(/\bINTEGER\b/g, "BIGINT")
        .replace("CREATE TABLE IF NOT EXISTS messages (", "CREATE TABLE IF NOT EXISTS messages (rowid BIGSERIAL UNIQUE,")
        .replace("CREATE TABLE IF NOT EXISTS automation_runs (", "CREATE TABLE IF NOT EXISTS automation_runs (rowid BIGSERIAL UNIQUE,");
      await client.query(schema);
      await client.query(`CREATE OR REPLACE FUNCTION instaloom_timestamp(value TEXT) RETURNS DOUBLE PRECISION
        LANGUAGE SQL STABLE SET timezone = 'UTC'
        AS $$ SELECT EXTRACT(EPOCH FROM value::timestamptz)::double precision $$`);
      await client.query("CREATE INDEX IF NOT EXISTS idx_automation_order ON automation_rules(account_id, channel, media_id, position)");
      await client.query("INSERT INTO instaloom_migrations(version) VALUES(1)");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}
