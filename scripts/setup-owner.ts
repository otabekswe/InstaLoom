import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import Database from "better-sqlite3";
import { getInstagramIdentity } from "../src/lib/instagram/oauth";

const envFile = path.resolve(".env.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);

async function main() {
  let ownerId: string | undefined;
  // An existing, verified local connection makes upgrades a one-command setup.
  const filename = process.env.DATABASE_PATH || (existsSync("data/instaloom.db") ? "data/instaloom.db" : "data/chatplace.db");
  if (existsSync(filename)) {
    const db = new Database(filename, { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare(`SELECT DISTINCT i.subject FROM instagram_identities i
        JOIN instagram_accounts a ON a.instagram_account_id=i.subject AND a.user_id=i.user_id
        WHERE i.app_id=? AND a.is_active=1`).all(process.env.INSTAGRAM_APP_ID || "") as { subject: string }[];
      if (rows.length === 1 && /^\d+$/.test(rows[0].subject)) ownerId = rows[0].subject;
    } catch { /* A new or legacy install can look up its identity below. */ }
    finally { db.close(); }
  }
  if (!ownerId) {
    console.log("Meta → Instagram → API setup with Instagram business login → Generate access tokens.");
    console.log("Add your professional Instagram account, generate its token, then paste it below. The token is not saved.");
    let hidden = false;
    const output = new Writable({ write(chunk, _encoding, done) { if (!hidden) process.stdout.write(chunk); done(); } });
    const prompt = createInterface({ input: process.stdin, output, terminal: !!process.stdin.isTTY });
    const answer = prompt.question("Instagram access token (hidden): ");
    hidden = true;
    let token: string;
    try { token = (await answer).trim(); }
    finally { prompt.close(); process.stdout.write("\n"); }
    if (!token) throw new Error("An Instagram access token is required.");
    const profile = await getInstagramIdentity(token);
    ownerId = profile.user_id;
    console.log(`Verified @${profile.username}.`);
  }
  const existing = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  const line = `OWNER_INSTAGRAM_ID=${ownerId}`;
  const next = /^\s*(?:export\s+)?OWNER_INSTAGRAM_ID\s*=.*$/m.test(existing)
    ? existing.replace(/^\s*(?:export\s+)?OWNER_INSTAGRAM_ID\s*=.*$/m, line)
    : `${existing}${existing.endsWith("\n") || !existing ? "" : "\n"}${line}\n`;
  writeFileSync(envFile, next, { mode: 0o600 });
  console.log(`Saved ${line} in .env.local. Copy this value to Vercel too.`);
}

main().catch(() => {
  console.error("Could not configure the owner. Check the account token and Instagram app settings, then retry.");
  process.exitCode = 1;
});
