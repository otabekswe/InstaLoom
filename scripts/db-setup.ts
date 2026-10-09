import { existsSync } from "node:fs";
import { closeDb, getDb } from "../src/lib/db";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
async function main() {
  try {
    await getDb().prepare("SELECT 1").get();
    console.log(`Database ready (${getDb().kind}).`);
  } finally { await closeDb(); }
}
main().catch(() => { console.error("Database setup failed. Check DATABASE_URL and database permissions."); process.exitCode = 1; });
