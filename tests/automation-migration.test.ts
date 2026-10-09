import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { migrate } from "@/lib/db/schema";

it("removes the single-rule limit without losing IDs, settings, queued work, or cooldown history", () => {
  const db = new Database(":memory:");
  try {
    migrate(db);
    db.exec(`
      DROP TABLE automation_rules;
      CREATE TABLE automation_rules (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES instagram_accounts(id) ON DELETE CASCADE,
        channel TEXT NOT NULL CHECK(channel IN ('dm', 'post', 'story')),
        media_id TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 0,
        keywords TEXT NOT NULL DEFAULT '[]',
        match_all INTEGER NOT NULL DEFAULT 0,
        public_reply TEXT NOT NULL DEFAULT '',
        dm_reply TEXT NOT NULL DEFAULT '',
        revision TEXT NOT NULL,
        enabled_at INTEGER NOT NULL,
        UNIQUE(account_id, channel, media_id)
      );
      INSERT INTO users(id,email) VALUES ('owner','owner@example.test');
      INSERT INTO instagram_accounts(id,user_id,instagram_account_id,display_name,access_token)
        VALUES ('account','owner','ig-id','Studio','fake-token');
      INSERT INTO conversations(id,instagram_account_id,customer_psid) VALUES ('conversation','account','customer');
      INSERT INTO automation_rules VALUES ('original','account','post','post-id',1,'["price"]',0,'Thanks!','Details','revision-1',1234);
      INSERT INTO automation_runs(id,rule_id,revision,event_key,customer_id,conversation_id,action,reply_text,status,created_at,updated_at)
        VALUES ('queued','original','revision-1','event-1','customer','conversation','public','Thanks!','queued',2345,2345),
               ('sent','original','revision-1','event-2','customer','conversation','dm','Details','sent',2340,2341);
    `);
    const original = db.prepare("SELECT * FROM automation_rules").get();
    const runs = db.prepare("SELECT * FROM automation_runs ORDER BY id").all();
    migrate(db);
    migrate(db);
    expect(db.prepare("SELECT * FROM automation_rules").get()).toEqual({ ...original as object, name: "Comment reply", position: 0 });
    expect(db.prepare("SELECT * FROM automation_runs ORDER BY id").all()).toEqual(runs);
    db.exec(`INSERT INTO automation_rules(id,account_id,channel,media_id,name,position,revision,enabled_at)
      VALUES ('second','account','post','post-id','Another reply',1,'revision-2',5678)`);
    expect(db.prepare("SELECT count(*) n FROM automation_rules").get()).toEqual({ n: 2 });
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.prepare("DELETE FROM instagram_accounts WHERE id = ?").run("account");
    expect(db.prepare("SELECT count(*) n FROM automation_runs").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) n FROM automation_rules").get()).toEqual({ n: 0 });
  } finally { db.close(); }
});
