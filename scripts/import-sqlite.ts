import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { closeDb, getDb } from "../src/lib/db";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const filename = process.argv[2];
const tables = ["users", "instagram_accounts", "instagram_identities", "conversations", "messages", "webhook_receipts", "instagram_media", "automation_rules", "automation_runs", "customer_profile_attempts"];

async function main() {
  if (!filename || !existsSync(filename) || !process.env.DATABASE_URL) throw new Error("Usage");
  const source = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    // This tool never modifies the source or replaces a populated destination.
    const snapshot = source.transaction(() => tables.map((name) => ({ name,
      rows: source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)
        ? source.prepare(`SELECT ${["messages", "automation_runs"].includes(name) ? "rowid," : ""} * FROM "${name}"`).all() as Record<string, unknown>[] : [],
    })))();
    const target = getDb();
    if (target.kind !== "postgres") throw new Error("Postgres required");
    await target.transaction(async () => {
      for (const name of tables) {
        if (await target.prepare(`SELECT 1 FROM "${name}" LIMIT 1`).get()) throw new Error("Destination must be empty");
      }
      for (const { name, rows } of snapshot) {
        for (const row of rows) {
          // Importing never activates jobs or reuses old sessions. Reconnect
          // Instagram and review paused rules before enabling in production.
          if (name === "instagram_accounts") { row.access_token = ""; row.is_active = 0; }
          if (name === "automation_rules") row.enabled = 0;
          if (name === "automation_runs" && ["queued", "sending"].includes(String(row.status))) {
            row.status = "skipped"; row.error = "Skipped during deployment migration.";
          }
          const columns = Object.keys(row);
          // Source column names must also be safe SQL identifiers.
          if (columns.some((column) => !/^[a-z_]+$/.test(column))) throw new Error("Invalid source schema");
          await target.prepare(`INSERT INTO "${name}" (${columns.map((key) => `"${key}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...Object.values(row));
        }
      }
      for (const name of ["messages", "automation_runs"]) {
        await target.prepare(`SELECT setval(pg_get_serial_sequence('${name}', 'rowid'), COALESCE(MAX(rowid),1), MAX(rowid) IS NOT NULL) FROM ${name}`).get();
      }
    })();
    console.log("History and paused automations imported. Reconnect Instagram, then review and enable your rules.");
  } finally { source.close(); await closeDb(); }
}
main().catch(() => {
  console.error("Import stopped without replacing destination data. Use yarn db:import PATH_TO_SQLITE with DATABASE_URL set and an empty Postgres database. Upgrade the local app first and back up your SQLite file.");
  process.exitCode = 1;
});
