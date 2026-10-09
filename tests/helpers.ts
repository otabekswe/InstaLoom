import { NextRequest } from "next/server";
import { vi } from "vitest";
import { closeDb, getDb } from "@/lib/db";

export const origin = "http://localhost:3000";

export async function resetDatabase() {
  await closeDb();
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (testDatabaseUrl) {
    const url = new URL(testDatabaseUrl);
    if (!["postgres:", "postgresql:"].includes(url.protocol)
      || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      || !/^\/instaloom_test[a-zA-Z0-9_]*$/.test(url.pathname)
      || url.search) {
      throw new Error("TEST_DATABASE_URL must target a local instaloom_test database.");
    }
    vi.stubEnv("DATABASE_URL", testDatabaseUrl);
    await getDb().exec("TRUNCATE users, oauth_flows CASCADE");
  } else {
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("DATABASE_PATH", ":memory:");
  }
  vi.stubEnv("APP_URL", origin);
  vi.stubEnv("INSTAGRAM_APP_ID", "123456789");
  vi.stubEnv("OWNER_INSTAGRAM_ID", "200");
  vi.stubEnv("INSTAGRAM_APP_SECRET", "test-instagram-secret");
  vi.stubEnv("INSTAGRAM_API_VERSION", "v25.0");
  vi.stubEnv("META_APP_SECRET", "test-app-secret");
  vi.stubEnv("WEBHOOK_VERIFY_TOKEN", "test-verify-token");
}

export function request(path: string, options: { method?: string; body?: unknown; cookie?: string; origin?: string } = {}) {
  return new NextRequest(`${origin}${path}`, {
    method: options.method ?? "GET",
    headers: {
      origin: options.origin ?? origin,
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}

export async function seedAccount(userId = "default", id = "account-1") {
  const db = getDb();
  await db.prepare("INSERT OR IGNORE INTO users(id,email,name) VALUES(?,?,?)").run(userId, `${userId}@example.test`, "Test owner");
  await db.prepare(`INSERT INTO instagram_accounts(id,user_id,instagram_account_id,display_name,access_token,instagram_username,token_expires_at,token_refreshed_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(id, userId, userId === "default" && id === "account-1" ? "200" : `ig-${id}`, "Studio account", "private-test-token", "studio", Date.now() + 60 * 86400_000, Date.now());
  if (userId === "default") {
    await db.prepare("INSERT OR IGNORE INTO instagram_identities(app_id,subject,user_id) VALUES(?,?,?)")
      .run("123456789", "200", userId);
  }
  return id;
}

export function instagramMessage(mid = "mid-1", timestamp = Date.now(), text = "Hello from Instagram") {
  return {
    object: "instagram" as const,
    entry: [{
      id: "200", time: timestamp,
      messaging: [{ sender: { id: "customer-1" }, recipient: { id: "200" }, timestamp, message: { mid, text } }],
    }],
  };
}
