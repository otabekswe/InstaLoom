import type Database from "better-sqlite3";

export function migrate(db: Database.Database) {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(schemaSql + auxiliarySchemaSql);

  migrateAutomationRules(db);

  // Page tokens cannot be used with Instagram Login. Keep the account and its
  // conversations so a verified Instagram reconnect can reclaim that inbox.
  db.transaction(() => {
    const columns = db.prepare("PRAGMA table_info(instagram_accounts)").all() as { name: string }[];
    if (columns.some((column) => column.name === "page_access_token")) {
      db.exec(`
        ALTER TABLE instagram_accounts RENAME COLUMN page_access_token TO access_token;
        ALTER TABLE instagram_accounts RENAME COLUMN page_name TO display_name;
        ALTER TABLE instagram_accounts DROP COLUMN page_id;
        ALTER TABLE instagram_accounts ADD COLUMN token_expires_at INTEGER;
        ALTER TABLE instagram_accounts ADD COLUMN token_refreshed_at INTEGER;
        ALTER TABLE instagram_accounts ADD COLUMN token_refresh_attempted_at INTEGER NOT NULL DEFAULT 0;
        UPDATE instagram_accounts SET access_token = '', is_active = 0;
      `);
    }
  })();
}

function migrateAutomationRules(db: Database.Database) {
  const columns = db.prepare("PRAGMA table_info(automation_rules)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "position")) {
    // SQLite cannot drop an inline UNIQUE constraint. Rebuild the parent table
    // without renaming it first, so run history keeps its original foreign keys.
    db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        // Another server worker may have migrated while this connection waited.
        const current = db.prepare("PRAGMA table_info(automation_rules)").all() as { name: string }[];
        if (current.some((column) => column.name === "position")) return;
        db.exec(`
          CREATE TABLE automation_rules_new (
            id TEXT PRIMARY KEY,
            account_id TEXT NOT NULL REFERENCES instagram_accounts(id) ON DELETE CASCADE,
            channel TEXT NOT NULL CHECK(channel IN ('dm', 'post', 'story')),
            media_id TEXT NOT NULL DEFAULT '',
            name TEXT NOT NULL,
            position INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 0,
            keywords TEXT NOT NULL DEFAULT '[]',
            match_all INTEGER NOT NULL DEFAULT 0,
            public_reply TEXT NOT NULL DEFAULT '',
            dm_reply TEXT NOT NULL DEFAULT '',
            revision TEXT NOT NULL,
            enabled_at INTEGER NOT NULL
          );
          INSERT INTO automation_rules_new
            SELECT id, account_id, channel, media_id,
              CASE channel WHEN 'dm' THEN 'Direct message reply' WHEN 'post' THEN 'Comment reply' ELSE 'Story reply' END,
              0, enabled, keywords, match_all, public_reply, dm_reply, revision, enabled_at
            FROM automation_rules;
          DROP TABLE automation_rules;
          ALTER TABLE automation_rules_new RENAME TO automation_rules;
        `);
        if (db.prepare("PRAGMA foreign_key_check(automation_rules)").all().length || db.prepare("PRAGMA foreign_key_check(automation_runs)").all().length) {
          throw new Error("Automation migration failed its relationship check.");
        }
      }).immediate();
    } finally {
      db.pragma("foreign_keys = ON");
    }
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_automation_order ON automation_rules(account_id, channel, media_id, position)");
}

export const schemaSql = `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      avatar_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS instagram_accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      instagram_account_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      access_token TEXT NOT NULL,
      token_expires_at INTEGER,
      token_refreshed_at INTEGER,
      token_refresh_attempted_at INTEGER NOT NULL DEFAULT 0,
      instagram_username TEXT,
      instagram_profile_pic TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      connected_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      instagram_account_id TEXT NOT NULL REFERENCES instagram_accounts(id) ON DELETE CASCADE,
      customer_psid TEXT NOT NULL,
      customer_name TEXT,
      customer_profile_pic TEXT,
      folder TEXT NOT NULL DEFAULT 'general',
      last_message_text TEXT,
      last_message_at TEXT,
      is_unread INTEGER NOT NULL DEFAULT 0,
      assigned_to TEXT REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(instagram_account_id, customer_psid)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      mid TEXT,
      direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
      message_type TEXT NOT NULL DEFAULT 'text',
      text_content TEXT,
      attachment_url TEXT,
      attachment_type TEXT,
      story_reply_to TEXT,
      comment_id TEXT,
      is_read INTEGER NOT NULL DEFAULT 0,
      sent_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS webhook_receipts (
      account_id TEXT NOT NULL REFERENCES instagram_accounts(id) ON DELETE CASCADE,
      event_key TEXT NOT NULL,
      processed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(account_id, event_key)
    );

    CREATE TABLE IF NOT EXISTS instagram_media (
      account_id TEXT NOT NULL REFERENCES instagram_accounts(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      channel TEXT NOT NULL CHECK(channel IN ('post', 'story')),
      data TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      PRIMARY KEY(account_id, id)
    );

    CREATE TABLE IF NOT EXISTS automation_rules (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES instagram_accounts(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK(channel IN ('dm', 'post', 'story')),
      media_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 0,
      keywords TEXT NOT NULL DEFAULT '[]',
      match_all INTEGER NOT NULL DEFAULT 0,
      public_reply TEXT NOT NULL DEFAULT '',
      dm_reply TEXT NOT NULL DEFAULT '',
      revision TEXT NOT NULL,
      enabled_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS automation_runs (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
      revision TEXT NOT NULL,
      event_key TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      comment_id TEXT,
      action TEXT NOT NULL CHECK(action IN ('public', 'dm')),
      reply_text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      result_id TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(rule_id, event_key, action)
    );
    CREATE INDEX IF NOT EXISTS idx_automation_queue ON automation_runs(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_automation_customer ON automation_runs(rule_id, customer_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_messages_comment ON messages(conversation_id, comment_id, direction);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_mid ON messages(mid);
    CREATE INDEX IF NOT EXISTS idx_conversations_account ON conversations(instagram_account_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
    CREATE INDEX IF NOT EXISTS idx_conversations_unread ON conversations(instagram_account_id, is_unread);
    CREATE INDEX IF NOT EXISTS idx_instagram_accounts_user ON instagram_accounts(user_id);
`;

export const auxiliarySchemaSql = `
  CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    auth_version TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);
  CREATE TABLE IF NOT EXISTS instagram_identities (
    app_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY(app_id, subject)
  );
  CREATE TABLE IF NOT EXISTS oauth_flows (
    state_hash TEXT PRIMARY KEY,
    browser_hash TEXT NOT NULL,
    session_hash TEXT REFERENCES auth_sessions(token_hash) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS customer_profile_attempts (
    conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    attempted_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS outbound_send_claims (
    conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    claimed_at INTEGER NOT NULL
  );
`;
