import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb } from "@/lib/db";
import { disconnectAccount, getAccountsByUser, getAccountById, getMessages, insertMessage, upsertConversation, sendMessage, sendPrivateReply, getInstagramProfile, getConversations } from "@/lib/instagram";
import { processWebhook, sendAgentReply } from "@/lib/webhook";
import { instagramMessage, resetDatabase, seedAccount } from "./helpers";

beforeEach(async () => { await resetDatabase(); await seedAccount(); });
afterEach(async () => { await closeDb(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("mapped database records", () => {
  it("hides a previously linked non-owner account in the same workspace", async () => {
    await seedAccount("default", "old-account");
    expect((await getAccountsByUser("default")).map((account) => account.id)).toEqual(["account-1"]);
    expect(await getAccountById("old-account")).toBeUndefined();
    expect(await disconnectAccount("old-account", "default")).toBe(false);
    expect(await getDb().prepare("SELECT is_active FROM instagram_accounts WHERE id = ?").get("old-account")).toEqual({ is_active: 1 });
  });

  it("maps active flags, account IDs and tokens for server use", async () => {
    expect(await getAccountById("account-1")).toMatchObject({ isActive: true, instagramAccountId: "200", accessToken: "private-test-token" });
  });

  it("paginates messages with identical timestamps without skipping or duplicating", async () => {
    const conversation = await upsertConversation({ instagramAccountId: "account-1", customerPsid: "customer" });
    for (let i = 0; i < 55; i++) await insertMessage({ conversationId: conversation.id, direction: "inbound", messageType: "text", textContent: `Message ${i}`, sentAt: "2026-10-09T10:00:00.000Z" });
    const first = await getMessages(conversation.id, { limit: 50 });
    const next = await getMessages(conversation.id, { limit: 50, before: first.at(-1)!.id });
    expect(first).toHaveLength(50);
    expect(next).toHaveLength(5);
    expect(new Set([...first, ...next].map((m) => m.id)).size).toBe(55);
  });

  it("searches all conversations and treats SQL wildcard characters literally", async () => {
    await upsertConversation({ instagramAccountId: "account-1", customerPsid: "one", customerName: "One Hundred %" });
    await upsertConversation({ instagramAccountId: "account-1", customerPsid: "two", customerName: "Second Person" });
    expect(await getConversations("account-1", { search: "%" })).toHaveLength(1);
    expect((await getConversations("account-1", { search: "second" }))[0].customerName).toBe("Second Person");
  });
});

describe("Meta request contracts", () => {
  it("rejects provider sends for an account other than the configured owner", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(sendMessage({ instagramAccountId: "other", accessToken: "token", recipientPsid: "customer", text: "Reply" })).rejects.toThrow(/not authorized/);
    await expect(sendPrivateReply({ instagramAccountId: "other", accessToken: "token", commentId: "comment", text: "Reply" })).rejects.toThrow(/not authorized/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps provider message IDs and keeps access tokens out of request URLs", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ recipient_id: "customer", message_id: "provider-mid" }));
    expect(await sendMessage({ instagramAccountId: "200", accessToken: "private-test-token", recipientPsid: "customer", text: "Reply" })).toEqual({ recipientId: "customer", messageId: "provider-mid" });
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("private-test-token");
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer private-test-token");
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://graph.instagram.com/v25.0/200/messages");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ recipient: { id: "customer" }, message: { text: "Reply" } });
  });

  it("requests the correct Instagram profile field names", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ username: "studio", profile_picture_url: "https://example.test/photo.jpg" }));
    expect(await getInstagramProfile("token", "ig-id")).toEqual({ username: "studio", profilePic: "https://example.test/photo.jpg" });
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("fields")).toBe("username,profile_picture_url");
  });

  it("persists outbound provider IDs so webhook echoes do not duplicate them", async () => {
    await processWebhook(instagramMessage());
    const conversation = (await getConversations("account-1"))[0];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ recipient_id: "customer-1", message_id: "outbound-mid" }));
    await sendAgentReply({ accountId: "account-1", conversationId: conversation.id, text: "Thanks!" });
    await processWebhook({ object: "instagram", entry: [{ id: "200", time: Date.now(), messaging: [{ sender: { id: "200" }, recipient: { id: "customer-1" }, timestamp: Date.now(), message: { mid: "outbound-mid", text: "Thanks!", is_echo: true } }] }] });
    const messages = await getMessages(conversation.id);
    expect(messages).toHaveLength(2);
    expect(messages.find((m) => m.direction === "outbound")?.mid).toBe("outbound-mid");
  });

  it("uses the comment recipient for the first private reply and blocks a second", async () => {
    await processWebhook({ object: "instagram", entry: [{ id: "200", time: Date.now(), changes: [{ field: "comments", value: { id: "comment-id", from: { id: "commenter" }, text: "Price?" } }] }] });
    const conversation = (await getConversations("account-1"))[0];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ recipient_id: "commenter", message_id: "private-reply-mid" }));
    await sendAgentReply({ accountId: "account-1", conversationId: conversation.id, text: "Here are the details" });
    const sentBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(sentBody.recipient).toEqual({ comment_id: "comment-id" });
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://graph.instagram.com/v25.0/200/messages");
    await expect(sendAgentReply({ accountId: "account-1", conversationId: conversation.id, text: "Again" })).rejects.toThrow(/already.*reply/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reconciles an echo received before the private reply response", async () => {
    await processWebhook({ object: "instagram", entry: [{ id: "200", time: Date.now(), changes: [{ field: "comments", value: { id: "comment-id", from: { id: "commenter" }, text: "Price?" } }] }] });
    const conversation = (await getConversations("account-1"))[0];
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await processWebhook({ object: "instagram", entry: [{ id: "200", time: Date.now(), messaging: [{ sender: { id: "200" }, recipient: { id: "commenter" }, timestamp: Date.now(), message: { mid: "private-reply-mid", text: "Details", is_echo: true } }] }] });
      return Response.json({ recipient_id: "commenter", message_id: "private-reply-mid" });
    });
    await sendAgentReply({ accountId: "account-1", conversationId: conversation.id, text: "Details" });
    const messages = await getMessages(conversation.id);
    expect(messages).toHaveLength(2);
    expect(messages.find((message) => message.direction === "outbound")).toMatchObject({ mid: "private-reply-mid", commentId: "comment-id" });
  });

  it("honors another instance's reply lease and recovers an expired claim", async () => {
    await processWebhook(instagramMessage());
    const conversation = (await getConversations("account-1"))[0];
    await getDb().prepare("INSERT INTO outbound_send_claims(conversation_id, claimed_at) VALUES (?, ?)").run(conversation.id, Date.now());
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ recipient_id: "customer-1", message_id: "leased-mid" }));
    await expect(sendAgentReply({ accountId: "account-1", conversationId: conversation.id, text: "Reply" })).rejects.toMatchObject({ status: 409 });
    expect(fetchMock).not.toHaveBeenCalled();

    await getDb().prepare("UPDATE outbound_send_claims SET claimed_at = ? WHERE conversation_id = ?").run(Date.now() - 120_001, conversation.id);
    await sendAgentReply({ accountId: "account-1", conversationId: conversation.id, text: "Reply" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await getDb().prepare("SELECT count(*) AS n FROM outbound_send_claims").get()).toEqual({ n: 0 });
  });

  it("claims a private reply before sending so concurrent requests send only once", async () => {
    await processWebhook({ object: "instagram", entry: [{ id: "200", time: Date.now(), changes: [{ field: "comments", value: { id: "comment-id", from: { id: "commenter" }, text: "Price?" } }] }] });
    const conversation = (await getConversations("account-1"))[0];
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    let finishSend!: (response: Response) => void;
    const upstream = new Promise<Response>((resolve) => { finishSend = resolve; });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => { notifyStarted(); return upstream; });
    const sending = sendAgentReply({ accountId: "account-1", conversationId: conversation.id, text: "Details" });
    await started;
    try {
      await expect(sendAgentReply({ accountId: "account-1", conversationId: conversation.id, text: "Details" })).rejects.toMatchObject({ status: 409 });
    } finally {
      finishSend(Response.json({ recipient_id: "commenter", message_id: "private-reply-mid" }));
      await sending;
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await getMessages(conversation.id)).filter((message) => message.direction === "outbound")).toHaveLength(1);
  });

  it("does not release a claim replaced by a later invocation", async () => {
    await processWebhook(instagramMessage());
    const conversation = (await getConversations("account-1"))[0];
    const replacement = Date.now() + 120_000;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await getDb().prepare("UPDATE outbound_send_claims SET claimed_at = ? WHERE conversation_id = ?").run(replacement, conversation.id);
      return Response.json({ recipient_id: "customer-1", message_id: "leased-mid" });
    });
    await sendAgentReply({ accountId: "account-1", conversationId: conversation.id, text: "Reply" });
    expect(await getDb().prepare("SELECT claimed_at FROM outbound_send_claims WHERE conversation_id = ?").get(conversation.id)).toEqual({ claimed_at: replacement });
  });
});
