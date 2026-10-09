import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb } from "@/lib/db";
import {
  disconnectAccount, getAccountAccessToken, getAccountById, getAccountsByUser,
  getConversationByPsid, getMessages, linkInstagramAccount, upsertConversation,
} from "@/lib/instagram";
import { requireAutomationAccount } from "@/lib/automations/access";
import { dispatchAutomations, hasQueuedAutomations } from "@/lib/automations/dispatch";
import { enqueueAutomation, getRuns, saveRule } from "@/lib/automations/store";
import { processWebhook, sendAgentReply, webhookEventSchema } from "@/lib/webhook";
import type { AutomationChannel, AutomationInput } from "@/lib/automations/schema";
import { resetDatabase, seedAccount } from "./helpers";

const rule: AutomationInput = {
  name: "Price", accountId: "account-1", channel: "dm", mediaId: "", enabled: true,
  matchAll: false, keywords: ["price"], publicReply: "", dmReply: "The details",
};

async function testerAccount(userId: string, accountId: string, subject: string, appId: string | null = "123456789") {
  await seedAccount(userId, accountId);
  await getDb().prepare("UPDATE instagram_accounts SET instagram_account_id = ?, access_token = ? WHERE id = ?")
    .run(subject, `token-${subject}`, accountId);
  if (appId) await getDb().prepare("INSERT INTO instagram_identities(app_id,subject,user_id) VALUES(?,?,?)")
    .run(appId, subject, userId);
}

function event(channel: AutomationChannel, subjects = ["200", "222"]) {
  const now = Date.now();
  return webhookEventSchema.parse({ object: "instagram", entry: subjects.map((subject) => ({
    id: subject, time: now,
    ...(channel === "post" ? {
      changes: [{ field: "comments", value: { id: "shared-comment", text: "price please",
        from: { id: "shared-customer" }, media: { id: "shared-media" } } }],
    } : {
      messaging: [{ sender: { id: "shared-customer" }, recipient: { id: subject }, timestamp: now,
        message: { mid: "shared-mid", text: "price please",
          ...(channel === "story" ? { reply_to: { story: { id: "shared-media" } } } : {}) } }],
    }),
  })) });
}

beforeEach(async () => {
  await resetDatabase();
  vi.stubEnv("OWNER_INSTAGRAM_ID", "");
  await seedAccount();
  await testerAccount("tester", "tester-account", "222");
});
afterEach(async () => { await closeDb(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("Meta-authorized account data", () => {
  it("lists only each workspace's verified accounts and enforces account ownership", async () => {
    await testerAccount("default", "legacy-account", "333", null);
    expect((await getAccountsByUser("default")).map((account) => account.id)).toEqual(["account-1"]);
    expect((await getAccountsByUser("tester")).map((account) => account.id)).toEqual(["tester-account"]);
    expect(await requireAutomationAccount("tester-account", "tester")).toMatchObject({ instagramAccountId: "222" });
    await expect(requireAutomationAccount("tester-account", "default")).rejects.toMatchObject({ status: 404 });
    expect(await disconnectAccount("tester-account", "default")).toBe(false);
    expect(await disconnectAccount("legacy-account", "default")).toBe(false);
    expect(await disconnectAccount("tester-account", "tester")).toBe(true);
    expect(await getAccountById("account-1")).toMatchObject({ isActive: true });
  });

  it.each(["dm", "post", "story"] as const)("receives and automates %s events separately, including identical customer/event IDs", async (channel) => {
    for (const accountId of ["account-1", "tester-account"]) {
      await saveRule({ ...rule, accountId, channel, mediaId: channel === "dm" ? "" : "shared-media",
        dmReply: `Private reply from ${accountId}`, publicReply: channel === "post" ? `Comment from ${accountId}` : "" });
    }
    const received = event(channel);
    await processWebhook(received);
    await processWebhook(received);
    const first = (await getConversationByPsid("account-1", "shared-customer"))!;
    const second = (await getConversationByPsid("tester-account", "shared-customer"))!;
    expect(first.id).not.toBe(second.id);
    expect(await getMessages(first.id)).toHaveLength(1);
    expect(await getMessages(second.id)).toHaveLength(1);
    expect(await hasQueuedAutomations()).toBe(true);

    const sends = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const id = crypto.randomUUID();
      return Response.json(String(url).endsWith("/replies") ? { id } : { message_id: id });
    });
    await dispatchAutomations();
    await dispatchAutomations();
    const expectedRuns = channel === "post" ? 2 : 1;
    expect(sends).toHaveBeenCalledTimes(expectedRuns * 2);
    expect((await getRuns("account-1", channel)).map((run) => run.status)).toEqual(Array(expectedRuns).fill("sent"));
    expect((await getRuns("tester-account", channel)).map((run) => run.status)).toEqual(Array(expectedRuns).fill("sent"));
    expect(await hasQueuedAutomations()).toBe(false);
    const requests = sends.mock.calls.map(([url, init]) => ({
      path: new URL(String(url)).pathname,
      authorization: new Headers(init?.headers).get("authorization"),
      text: JSON.parse(String(init?.body)).message,
    }));
    expect(requests).toEqual(expect.arrayContaining([
      { path: "/v25.0/200/messages", authorization: "Bearer private-test-token", text: { text: "Private reply from account-1" } },
      { path: "/v25.0/222/messages", authorization: "Bearer token-222", text: { text: "Private reply from tester-account" } },
    ]));
    expect((await getMessages(first.id)).find((message) => message.direction === "outbound")?.textContent).toBe("Private reply from account-1");
    expect((await getMessages(second.id)).find((message) => message.direction === "outbound")?.textContent).toBe("Private reply from tester-account");
  });

  it("permits manual replies for a second account without accepting another workspace's conversation", async () => {
    await processWebhook(event("dm"));
    const first = (await getConversationByPsid("account-1", "shared-customer"))!;
    const second = (await getConversationByPsid("tester-account", "shared-customer"))!;
    const sends = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ message_id: "manual-reply" }));
    await expect(sendAgentReply({ accountId: "tester-account", conversationId: first.id, text: "Wrong workspace" })).rejects.toThrow("Conversation not found");
    await sendAgentReply({ accountId: "tester-account", conversationId: second.id, text: "Test reply" });
    expect(sends).toHaveBeenCalledTimes(1);
    expect(String(sends.mock.calls[0][0])).toBe("https://graph.instagram.com/v25.0/222/messages");
    expect(new Headers(sends.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer token-222");
  });

  it("never processes legacy accounts, identities from a different app, or another user's matching subject", async () => {
    await testerAccount("legacy", "legacy-account", "333", null);
    await testerAccount("foreign", "foreign-account", "444", "other-app");
    await testerAccount("unverified", "mismatched-account", "200", null);
    const sends = vi.spyOn(globalThis, "fetch");
    await processWebhook(event("dm", ["333", "444"]));
    for (const accountId of ["legacy-account", "foreign-account", "mismatched-account"]) {
      expect(await getAccountById(accountId)).toBeUndefined();
      await expect(getAccountAccessToken(accountId)).rejects.toThrow(/Reconnect/);
      expect(await getConversationByPsid(accountId, "shared-customer")).toBeUndefined();
      const saved = await saveRule({ ...rule, accountId });
      const conversation = await upsertConversation({ instagramAccountId: accountId, customerPsid: "legacy-customer" });
      await enqueueAutomation({ accountId, channel: "dm", text: "price", eventKey: "new-event",
        customerId: "legacy-customer", conversationId: conversation.id, timestamp: Date.now() });
      expect(await getRuns(accountId, "dm")).toHaveLength(0);
      for (const status of ["queued", "sending"]) {
        await getDb().prepare(`INSERT INTO automation_runs(id,rule_id,revision,event_key,customer_id,conversation_id,action,reply_text,status,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(`${accountId}-${status}`, saved.id, saved.revision, status,
          "legacy-customer", conversation.id, "dm", "Legacy reply", status, Date.now() - 7200_000, Date.now() - 180_000);
      }
    }
    expect(await hasQueuedAutomations()).toBe(false);
    await dispatchAutomations();
    for (const accountId of ["legacy-account", "foreign-account", "mismatched-account"]) {
      expect((await getRuns(accountId, "dm")).map((run) => run.status).sort()).toEqual(["queued", "sending"]);
    }
    expect(sends).not.toHaveBeenCalled();
  });

  it("stops account reads, replies, and queued work when its verified identity is removed", async () => {
    await saveRule({ ...rule, accountId: "tester-account" });
    await processWebhook(event("dm", ["222"]));
    const conversation = (await getConversationByPsid("tester-account", "shared-customer"))!;
    await getDb().prepare("DELETE FROM instagram_identities WHERE subject = ?").run("222");
    const sends = vi.spyOn(globalThis, "fetch");
    expect(await getAccountsByUser("tester")).toEqual([]);
    await expect(sendAgentReply({ accountId: "tester-account", conversationId: conversation.id, text: "Reply" })).rejects.toThrow("Account not found or inactive");
    await dispatchAutomations();
    expect((await getRuns("tester-account", "dm"))[0].status).toBe("queued");
    expect(sends).not.toHaveBeenCalled();
  });

  it("requires a matching verified OAuth identity before linking an account", async () => {
    await expect(linkInstagramAccount({ userId: "default", instagramAccountId: "999", accessToken: "unused-token",
      expiresIn: 86400, displayName: "Unverified", username: "unverified" })).rejects.toThrow(/not authorized/);
    expect(await getDb().prepare("SELECT 1 FROM instagram_accounts WHERE instagram_account_id = ?").get("999")).toBeUndefined();
  });

  it("restores the original owner restriction when configured again", async () => {
    vi.stubEnv("OWNER_INSTAGRAM_ID", "200");
    expect(await getAccountById("tester-account")).toBeUndefined();
    expect(await getAccountsByUser("tester")).toEqual([]);
    await processWebhook(event("dm", ["222"]));
    expect(await getConversationByPsid("tester-account", "shared-customer")).toBeUndefined();
  });
});
