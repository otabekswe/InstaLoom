import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";

const file = new URL("../.env.local", import.meta.url);
const original = existsSync(file) ? readFileSync(file, "utf8") : "";
const existing = original.replace(/^\s*(?:export\s+)?ADMIN_(?:EMAIL|PASSWORD|NAME)\s*=.*(?:\r?\n|$)/gm, "");
const defaults = {
  APP_URL: "http://localhost:3000",
  INSTAGRAM_APP_ID: "",
  INSTAGRAM_APP_SECRET: "",
  OWNER_INSTAGRAM_ID: "",
  INSTAGRAM_API_VERSION: "v25.0",
  WEBHOOK_VERIFY_TOKEN: randomBytes(24).toString("hex"),
  CRON_SECRET: randomBytes(32).toString("hex"),
  DATABASE_URL: "",
  PRIVACY_CONTACT_NAME: "",
  PRIVACY_CONTACT_EMAIL: "",
  PRIVACY_CONTACT_URL: "",
};

const additions = Object.entries(defaults)
  .filter(([key]) => !new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`, "m").test(existing))
  .map(([key, value]) => `${key}=${value}`);

if (additions.length || original !== existing) {
  writeFileSync(file, `${existing}${existing.endsWith("\n") || !existing ? "" : "\n"}${additions.join("\n")}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

console.log("Local configuration is ready in .env.local. Existing values were preserved.");
console.log("Add your Instagram credentials and app URL, then run yarn setup:owner to configure your private account.");
