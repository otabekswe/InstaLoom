import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/webhook/route";
import { closeDb, getDb } from "@/lib/db";
import { getConversationByPsid, getMessages, markConversationRead } from "@/lib/instagram";
import { verifySignature } from "@/lib/webhook";
import { instagramMessage, request, resetDatabase, seedAccount } from "./helpers";

function delivery(payload: unknown, signature?: string | null) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const signed = `sha256=${createHmac("sha256", "test-instagram-secret").update(body).digest("hex")}`;
  return new NextRequest("http://localhost:3000/api/webhook", {
    method: "POST", body,
    headers: { "Content-Type": "application/json", ...(signature === null ? {} : { "x-hub-signature-256": signature ?? signed }) },
  });
}

beforeEach(resetDatabase);
afterEach(async () => { await closeDb(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("webhook boundary", () => {
  it("returns the exact verification challenge and rejects wrong or unconfigured tokens", async () => {
    const valid = await GET(request("/api/webhook?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=12345"));
    expect(valid.status).toBe(200);
    expect(await valid.text()).toBe("12345");
    expect((await GET(request("/api/webhook?hub.mode=subscribe&hub.verify_token=wrong"))).status).toBe(403);
    vi.stubEnv("WEBHOOK_VERIFY_TOKEN", "");
    expect((await GET(request("/api/webhook?hub.mode=subscribe"))).status).not.toBe(200);
  });

  it.each([null, "sha256=bad", `sha256=${"0".repeat(64)}`, "sha1=abc"])("rejects missing or malformed signatures (%s)", async (signature) => {
    expect((await POST(delivery(instagramMessage(), signature))).status).toBe(403);
  });

  it("fails closed when the app secret is missing", async () => {
    vi.stubEnv("INSTAGRAM_APP_SECRET", "");
    expect((await POST(delivery(instagramMessage()))).status).toBe(503);
  });

  it("verifies with the Instagram secret and rejects the legacy Meta secret", async () => {
    const event = instagramMessage();
    const wrong = `sha256=${createHmac("sha256", "test-app-secret").update(JSON.stringify(event)).digest("hex")}`;
    expect((await POST(delivery(event, wrong))).status).toBe(403);
    expect((await POST(delivery(event))).status).toBe(200);
  });

  it("rejects Facebook Page payloads", async () => {
    expect((await POST(delivery({ object: "page", entry: [] }))).status).toBe(400);
  });

  it("rejects malformed JSON and malformed signed event structures", async () => {
    expect((await POST(delivery("{"))).status).toBe(400);
    expect((await POST(delivery({ object: "instagram", entry: "wrong" }))).status).toBe(400);
  });

  it("compares signatures safely and preserves the raw body", () => {
    const body = '{"text":"hello 🌊"}';
    const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
    expect(verifySignature(body, signature, "secret")).toBe(true);
    expect(verifySignature(body + " ", signature, "secret")).toBe(false);
    expect(verifySignature(body, "sha256=bad", "secret")).toBe(false);
  });
});

describe("Instagram event persistence", () => {
  beforeEach(async () => await seedAccount());

  it("commits concurrent deliveries once", async () => {
    const event = instagramMessage();
    const responses = await Promise.all([POST(delivery(event)), POST(delivery(event))]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const conversation = (await getConversationByPsid("account-1", "customer-1"))!;
    expect(await getMessages(conversation.id)).toHaveLength(1);
    expect(await getDb().prepare("SELECT count(*) AS n FROM webhook_receipts").get()).toEqual({ n: 1 });
  });

  it("ignores deliveries for an account other than the configured owner", async () => {
    await seedAccount("other", "other-account");
    const event = instagramMessage();
    event.entry[0].id = "ig-other-account";
    event.entry[0].messaging[0].recipient.id = "ig-other-account";
    expect((await POST(delivery(event))).status).toBe(200);
    expect(await getConversationByPsid("other-account", "customer-1")).toBeUndefined();
    expect(await getDb().prepare("SELECT count(*) AS n FROM webhook_receipts").get()).toEqual({ n: 0 });
  });

  it("routes Instagram IDs, persists before acknowledging, and replays without changing read state", async () => {
    const event = instagramMessage();
    expect((await POST(delivery(event))).status).toBe(200);
    const conversation = (await getConversationByPsid("account-1", "customer-1"))!;
    expect(conversation.isUnread).toBe(true);
    expect((await getMessages(conversation.id))[0]).toMatchObject({ textContent: "Hello from Instagram", messageType: "text", mid: "mid-1" });
    await markConversationRead(conversation.id);
    expect((await POST(delivery(event))).status).toBe(200);
    expect(await getMessages(conversation.id)).toHaveLength(1);
    expect((await getConversationByPsid("account-1", "customer-1"))!.isUnread).toBe(false);
  });

  it("does not replace the latest preview with an older delayed message", async () => {
    const now = Date.now();
    await POST(delivery(instagramMessage("new", now, "Newest message")));
    await POST(delivery(instagramMessage("old", now - 60_000, "Older message")));
    const conversation = (await getConversationByPsid("account-1", "customer-1"))!;
    expect(conversation.lastMessageText).toBe("Newest message");
    expect(await getMessages(conversation.id)).toHaveLength(2);
  });

  it("stores Instagram comments only once", async () => {
    const event = { object: "instagram", entry: [{ id: "200", time: Math.floor(Date.now() / 1000), changes: [{ field: "comments", value: { id: "comment-1", from: { id: "commenter", username: "river" }, text: "Is this available?", media: { id: "media-1" } } }] }] };
    expect((await POST(delivery(event))).status).toBe(200);
    expect((await POST(delivery(event))).status).toBe(200);
    const conversation = (await getConversationByPsid("account-1", "commenter"))!;
    expect(await getMessages(conversation.id)).toHaveLength(1);
    expect((await getMessages(conversation.id))[0]).toMatchObject({ commentId: "comment-1", textContent: "Is this available?" });
  });

  it("preserves story context and receives unfamiliar attachment types without retry loops", async () => {
    const story = instagramMessage("story-mid");
    const message = story.entry[0].messaging[0].message;
    Object.assign(message, { reply_to: { story: { url: "https://example.test/story.jpg" } } });
    expect((await POST(delivery(story))).status).toBe(200);
    const conversation = (await getConversationByPsid("account-1", "customer-1"))!;
    expect((await getMessages(conversation.id))[0]).toMatchObject({ messageType: "story_reply", storyReplyTo: "https://example.test/story.jpg" });
    const attachment = instagramMessage("attachment-mid");
    Object.assign(attachment.entry[0].messaging[0].message, { attachments: [{ type: "future-attachment", payload: {} }] });
    expect((await POST(delivery(attachment))).status).toBe(200);
    expect((await getMessages(conversation.id)).find((item) => item.mid === "attachment-mid")?.messageType).toBe("unsupported");
  });

  it("handles Instagram messaging_seen receipts without marking incoming messages read", async () => {
    await POST(delivery(instagramMessage()));
    const conversation = (await getConversationByPsid("account-1", "customer-1"))!;
    const outbound = { object: "instagram", entry: [{ id: "200", time: Date.now(), messaging: [{ sender: { id: "200" }, recipient: { id: "customer-1" }, timestamp: Date.now(), message: { mid: "sent-mid", text: "Reply", is_echo: true } }] }] };
    await POST(delivery(outbound));
    const receipt = { object: "instagram", entry: [{ id: "200", time: Date.now(), messaging: [{ sender: { id: "customer-1" }, recipient: { id: "200" }, timestamp: Date.now(), read: { mid: "sent-mid" } }] }] };
    expect((await POST(delivery(receipt))).status).toBe(200);
    expect((await getMessages(conversation.id)).find((item) => item.mid === "sent-mid")?.isRead).toBe(true);
    expect((await getConversationByPsid("account-1", "customer-1"))?.isUnread).toBe(true);
  });

  it("returns a retriable failure when persistence fails and succeeds on retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = getDb();
    const prepare = db.prepare.bind(db);
    const failedWrite = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      const statement = prepare(sql);
      return sql.startsWith("INSERT INTO messages")
        ? { ...statement, run: async () => { throw new Error("test disk failure"); } }
        : statement;
    });
    const event = instagramMessage();
    expect((await POST(delivery(event))).status).toBeGreaterThanOrEqual(500);
    failedWrite.mockRestore();
    expect(await getDb().prepare("SELECT count(*) AS n FROM webhook_receipts").get()).toEqual({ n: 0 });
    expect(await getDb().prepare("SELECT count(*) AS n FROM conversations").get()).toEqual({ n: 0 });
    expect((await POST(delivery(event))).status).toBe(200);
    expect(await getDb().prepare("SELECT count(*) AS n FROM messages").get()).toEqual({ n: 1 });
  });
});
