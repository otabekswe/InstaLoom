import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb } from "@/lib/db";
import { migrate } from "@/lib/db/schema";
import { resetDatabase } from "./helpers";

const root = resolve(".");
let directory: string;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "instaloom-deploy-test-"));
  await resetDatabase();
});
afterEach(async () => {
  await closeDb();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

function runScript(name: string, ...args: string[]) {
  return spawnSync(process.execPath, ["--import", join(root, "node_modules/tsx/dist/loader.mjs"), join(root, "scripts", name), ...args], {
    cwd: directory, encoding: "utf8", timeout: 20_000,
    env: { ...process.env, TSX_TSCONFIG_PATH: join(root, "tsconfig.json"),
      DATABASE_PATH: join(directory, "source.db"), DATABASE_URL: process.env.TEST_DATABASE_URL || "" },
  });
}

function sourceDatabase() {
  const filename = join(directory, "source.db");
  const db = new Database(filename);
  migrate(db);
  db.exec(`
    INSERT INTO users(id,email) VALUES('owner','owner@oauth.invalid');
    INSERT INTO instagram_accounts(id,user_id,instagram_account_id,display_name,access_token)
      VALUES('account','owner','200','Studio','source-private-token');
    INSERT INTO instagram_identities(app_id,subject,user_id) VALUES('123456789','200','owner');
    INSERT INTO auth_sessions VALUES('old-session','owner','old-version',9999999999999);
    INSERT INTO conversations(id,instagram_account_id,customer_psid) VALUES('conversation','account','customer');
    INSERT INTO messages(rowid,id,conversation_id,direction,text_content) VALUES(42,'message','conversation','inbound','Price?');
    INSERT INTO automation_rules(id,account_id,channel,name,enabled,revision,enabled_at)
      VALUES('rule','account','dm','Pricing',1,'revision',1);
    INSERT INTO automation_runs(rowid,id,rule_id,revision,event_key,customer_id,conversation_id,action,reply_text,status,created_at,updated_at)
      VALUES(37,'run','rule','revision','event','customer','conversation','dm','Reply','sending',1,1);
  `);
  db.close();
  return filename;
}

describe("deployment setup", () => {
  it("sets the canonical owner from a verified local connection without copying credentials", () => {
    sourceDatabase();
    writeFileSync(join(directory, ".env.local"), "INSTAGRAM_APP_SECRET=keep-me\nOWNER_INSTAGRAM_ID=\n");
    const result = runScript("setup-owner.ts");
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(directory, ".env.local"), "utf8")).toBe("INSTAGRAM_APP_SECRET=keep-me\nOWNER_INSTAGRAM_ID=200\n");
    expect(result.stdout).not.toContain("source-private-token");
    expect(result.stdout).not.toContain("keep-me");
  });

  it("initializes the configured database from the documented command", () => {
    const result = runScript("db-setup.ts");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Database ready (${process.env.TEST_DATABASE_URL ? "postgres" : "sqlite"})`);
  });

  it.skipIf(!process.env.TEST_DATABASE_URL)("imports history safely, skips sessions and pending sends, and refuses a populated destination", async () => {
    const filename = sourceDatabase();
    const before = readFileSync(filename);
    const result = runScript("import-sqlite.ts", filename);
    expect(result.status, result.stderr).toBe(0);
    const db = getDb();
    expect(await db.prepare("SELECT access_token,is_active FROM instagram_accounts").get()).toEqual({ access_token: "", is_active: 0 });
    expect(await db.prepare("SELECT enabled FROM automation_rules").get()).toEqual({ enabled: 0 });
    expect(await db.prepare("SELECT status,rowid FROM automation_runs").get()).toEqual({ status: "skipped", rowid: 37 });
    expect(await db.prepare("SELECT * FROM auth_sessions").all()).toEqual([]);
    expect(await db.prepare("SELECT rowid,text_content FROM messages").get()).toEqual({ rowid: 42, text_content: "Price?" });
    expect(readFileSync(filename)).toEqual(before);
    await db.prepare("INSERT INTO messages(id,conversation_id,direction) VALUES('new','conversation','outbound')").run();
    expect(await db.prepare("SELECT rowid FROM messages WHERE id='new'").get()).toEqual({ rowid: 43 });
    expect(runScript("import-sqlite.ts", filename).status).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 2 });
  });
});

describe("database guarantees", () => {
  it("rolls back awaited helper queries together", async () => {
    const db = getDb();
    await expect(db.transaction(async () => {
      await db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run("rollback", "rollback@example.test");
      await Promise.resolve();
      await db.transaction(async () => {
        await db.prepare("UPDATE users SET name=? WHERE id=?").run("Changed", "rollback");
      })();
      throw new Error("abort");
    })()).rejects.toThrow("abort");
    expect(await db.prepare("SELECT * FROM users WHERE id=?").get("rollback")).toBeUndefined();
  });

  it("binds values without interpreting question marks or quotes as SQL", async () => {
    expect(await getDb().prepare("SELECT '?' AS literal, ? AS value").get("someone's ? message")).toEqual({ literal: "?", value: "someone's ? message" });
  });

  it("requires persistent Postgres storage on Vercel", async () => {
    await closeDb();
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("DATABASE_URL", "");
    expect(() => getDb()).toThrow("Set DATABASE_URL");
  });
});
