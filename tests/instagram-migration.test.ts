import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "@/lib/db/schema";

// Snapshot of the previous Facebook Login schema, with a conversation to keep.
const legacy = `
  CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT,
    avatar_url TEXT, created_at TEXT, updated_at TEXT);
  CREATE TABLE instagram_accounts (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
    instagram_account_id TEXT NOT NULL, page_id TEXT NOT NULL,
    page_name TEXT NOT NULL, page_access_token TEXT NOT NULL,
    instagram_username TEXT, instagram_profile_pic TEXT,
    is_active INTEGER NOT NULL DEFAULT 1, connected_at TEXT, updated_at TEXT
  );
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY, instagram_account_id TEXT NOT NULL REFERENCES instagram_accounts(id),
    customer_psid TEXT NOT NULL, customer_name TEXT, customer_profile_pic TEXT,
    folder TEXT DEFAULT 'general', last_message_text TEXT, last_message_at TEXT,
    is_unread INTEGER DEFAULT 0, assigned_to TEXT REFERENCES users(id), status TEXT DEFAULT 'open',
    created_at TEXT, updated_at TEXT, UNIQUE(instagram_account_id, customer_psid)
  );
  INSERT INTO users (id, email, name) VALUES ('previous-owner', 'legacy@oauth.invalid', 'Studio');
  INSERT INTO instagram_accounts (id, user_id, instagram_account_id, page_id, page_name, page_access_token)
    VALUES ('existing-account', 'previous-owner', '123', 'old-page', 'Studio', 'facebook-page-token');
  INSERT INTO conversations (id, instagram_account_id, customer_psid, last_message_text)
    VALUES ('saved-conversation', 'existing-account', 'customer', 'Keep this conversation');
`;

describe("Facebook-to-Instagram data migration", () => {
  it("retains inbox IDs and ownership, retires Page credentials, and is repeatable", () => {
    const db = new Database(":memory:");
    try {
      db.exec(legacy);
      migrate(db);
      migrate(db);
      expect(db.prepare("SELECT id, user_id, display_name, access_token, is_active, token_expires_at FROM instagram_accounts").get())
        .toEqual({ id: "existing-account", user_id: "previous-owner", display_name: "Studio", access_token: "", is_active: 0, token_expires_at: null });
      expect(db.prepare("SELECT id, instagram_account_id, last_message_text FROM conversations").get())
        .toEqual({ id: "saved-conversation", instagram_account_id: "existing-account", last_message_text: "Keep this conversation" });
      const columns = (db.prepare("PRAGMA table_info(instagram_accounts)").all() as { name: string }[]).map((column) => column.name);
      expect(columns).not.toContain("page_id");
      expect(columns).not.toContain("page_access_token");
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally { db.close(); }
  });

  it("creates an Instagram-only schema for a fresh install", () => {
    const db = new Database(":memory:");
    try {
      migrate(db);
      const columns = (db.prepare("PRAGMA table_info(instagram_accounts)").all() as { name: string }[]).map((column) => column.name);
      expect(columns).toEqual(expect.arrayContaining(["instagram_account_id", "access_token", "token_expires_at"]));
      expect(columns.some((column) => column.startsWith("page_"))).toBe(false);
    } finally { db.close(); }
  });
});
