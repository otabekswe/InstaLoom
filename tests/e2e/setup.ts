import { closeDb, getDb } from "../../src/lib/db";
import { NextRequest, NextResponse } from "next/server";
import { createSession, SESSION_COOKIE } from "../../src/lib/auth";

function configureTestDatabase() {
  if (!process.env.INSTALOOM_E2E_DB?.includes("instaloom-e2e-")) throw new Error("An isolated E2E database is required");
  if (process.env.INSTALOOM_E2E_DATABASE_URL) {
    const url = new URL(process.env.INSTALOOM_E2E_DATABASE_URL);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      || !/^\/instaloom_test[a-zA-Z0-9_]*$/.test(url.pathname) || url.search) throw new Error("E2E Postgres must use a local instaloom_test database.");
  }
  process.env.DATABASE_PATH = process.env.INSTALOOM_E2E_DB;
  process.env.INSTAGRAM_APP_ID = "123456789";
  process.env.OWNER_INSTAGRAM_ID = "200";
  process.env.DATABASE_URL = process.env.INSTALOOM_E2E_DATABASE_URL || "";
  process.env.APP_URL = "http://127.0.0.1:3101";
}

// Only the test process can seed a session. There is no bypass in the app.
export async function createTestSession() {
  configureTestDatabase();
  const response = new NextResponse();
  await createSession({ id: "default", name: "Form Studio" }, new NextRequest("http://127.0.0.1:3101"), response);
  const token = response.cookies.get(SESSION_COOKIE)!.value;
  await closeDb();
  return token;
}

export default async function setup() {
  configureTestDatabase();
  const db = getDb();
  if (db.kind === "postgres") await db.exec("TRUNCATE users, oauth_flows CASCADE");
  await db.prepare("INSERT INTO users(id,email,name) VALUES(?,?,?)").run("default", "e2e@oauth.invalid", "Form Studio");
  await db.prepare("INSERT INTO instagram_identities(app_id,subject,user_id) VALUES(?,?,?)").run("123456789", "200", "default");
  await db.prepare(`INSERT INTO instagram_accounts(id,user_id,instagram_account_id,display_name,access_token,instagram_username,token_expires_at,token_refreshed_at)
    VALUES(?,?,?,?,?,?,?,?)`).run("e2e-account", "default", "200", "Form Studio", "fake-e2e-token-never-sent", "form.studio", Date.now() + 60 * 86400_000, Date.now());
  for (const [channel, id, caption] of [
    ["post", "e2e-post", "The new collection is here."],
    ["story", "e2e-story", "A little behind the scenes."],
    ["post", "e2e-multi-post", "Autumn collection"],
    ["post", "e2e-other-post", "Another collection"],
  ]) {
    const item = { id, channel, caption, mediaType: "IMAGE", imageUrl: "https://media.example.test/preview.webp", permalink: null, timestamp: new Date().toISOString() };
    await db.prepare("INSERT INTO instagram_media(account_id,id,channel,data,fetched_at) VALUES(?,?,?,?,?)").run("e2e-account", item.id, channel, JSON.stringify(item), Date.now());
  }
  const conversation = db.prepare(`INSERT INTO conversations(id,instagram_account_id,customer_psid,customer_name,last_message_text,last_message_at,is_unread)
    VALUES(?,?,?,?,?,?,?)`);
  const now = Date.now();
  await conversation.run("e2e-ada", "e2e-account", "e2e-customer-ada", "Ada Morgan", "Do you have this in olive?", new Date(now).toISOString(), 1);
  await conversation.run("e2e-noah", "e2e-account", "e2e-customer-noah", "Noah Kim", "Thank you, that works perfectly.", new Date(now - 60_000).toISOString(), 0);
  const message = db.prepare(`INSERT INTO messages(id,conversation_id,mid,direction,message_type,text_content,sent_at)
    VALUES(?,?,?,?,?,?,?)`);
  await message.run("e2e-ada-first", "e2e-ada", "e2e-mid-1", "inbound", "text", "Hi! I love the new collection.", new Date(now - 300_000).toISOString());
  await message.run("e2e-ada-reply", "e2e-ada", "e2e-mid-2", "outbound", "text", "Hi Ada, happy to help. Which piece caught your eye?", new Date(now - 240_000).toISOString());
  await message.run("e2e-ada-last", "e2e-ada", "e2e-mid-3", "inbound", "text", "Do you have this in olive?", new Date(now).toISOString());
  await message.run("e2e-noah-last", "e2e-noah", "e2e-mid-4", "inbound", "text", "Thank you, that works perfectly.", new Date(now - 60_000).toISOString());
  await closeDb();
}
