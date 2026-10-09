import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, resolveOAuthUser, SESSION_COOKIE } from "@/lib/auth";
import { closeDb } from "@/lib/db";
import { getAccountById, linkInstagramAccount, upsertConversation } from "@/lib/instagram";
import { getRules, saveRule } from "@/lib/automations/store";
import { GET as accounts } from "@/app/api/accounts/route";
import { DELETE as disconnect } from "@/app/api/accounts/[id]/route";
import { GET as conversations } from "@/app/api/conversations/route";
import { GET as conversation, PATCH as updateConversation } from "@/app/api/conversations/[id]/route";
import { POST as sendReply } from "@/app/api/conversations/[id]/messages/route";
import { GET as rules, POST as createRule, PUT as editRule, PATCH as actOnRule, DELETE as deleteRule } from "@/app/api/automations/route";
import { GET as media } from "@/app/api/media/route";
import { request, resetDatabase } from "./helpers";
import type { AutomationInput } from "@/lib/automations/schema";

vi.mock("next/server", async (original) => ({ ...await original<typeof import("next/server")>(), after: vi.fn() }));

async function tester(subject: string) {
  const user = await resolveOAuthUser({ appId: "123456789", subject, name: `Tester ${subject}` });
  const account = await linkInstagramAccount({ userId: user.id, instagramAccountId: subject,
    accessToken: `secret-token-${subject}`, expiresIn: 5184000, username: `tester_${subject}`, displayName: user.name });
  const response = NextResponse.json({});
  await createSession(user, request("/"), response);
  const cookie = `${SESSION_COOKIE}=${response.cookies.get(SESSION_COOKIE)!.value}`;
  const thread = await upsertConversation({ instagramAccountId: account.id, customerPsid: "shared-customer" });
  const input: AutomationInput = { accountId: account.id, channel: "dm", mediaId: "", name: `Private rule ${subject}`,
    enabled: false, matchAll: false, keywords: ["price"], dmReply: `Reply ${subject}`, publicReply: "" };
  const rule = await saveRule(input);
  return { user, account, cookie, thread, input, rule };
}

let testers: Awaited<ReturnType<typeof tester>>[];
beforeEach(async () => {
  await resetDatabase();
  vi.stubEnv("OWNER_INSTAGRAM_ID", "");
  testers = [await tester("200"), await tester("222")];
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected provider request"));
});
afterEach(async () => { await closeDb(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("separate tester workspaces", () => {
  it.each([0, 1])("shows tester %i only their own account, conversations and automations", async (index) => {
    const own = testers[index];
    const other = testers[1 - index];
    const options = { cookie: own.cookie };
    const accountList = await (await accounts(request(`/api/accounts?user_id=${other.user.id}`, options))).json();
    expect(accountList.accounts.map((item: { id: string }) => item.id)).toEqual([own.account.id]);
    expect(JSON.stringify(accountList)).not.toContain("secret-token");
    const threadList = await (await conversations(request(`/api/conversations?account_id=${own.account.id}`, options))).json();
    expect(threadList.conversations.map((item: { id: string }) => item.id)).toEqual([own.thread.id]);
    const ruleList = await (await rules(request(`/api/automations?account_id=${own.account.id}&channel=dm`, options))).json();
    expect(ruleList.rules.map((item: { id: string }) => item.id)).toEqual([own.rule.id]);
    const created = await createRule(request("/api/automations", { ...options, method: "POST", body: { ...own.input, name: "New own rule" } }));
    expect(created.status).toBe(201);
    expect(await getRules(other.account.id, "dm")).toEqual([other.rule]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([0, 1])("blocks tester %i from reading or changing another tester's data", async (index) => {
    const own = testers[index];
    const other = testers[1 - index];
    const options = { cookie: own.cookie };
    const context = { params: Promise.resolve({ id: other.thread.id }) };
    expect((await conversations(request(`/api/conversations?account_id=${other.account.id}`, options))).status).toBe(404);
    expect((await conversation(request(`/api/conversations/${other.thread.id}`, options), context)).status).toBe(404);
    expect((await updateConversation(request(`/api/conversations/${other.thread.id}`, { ...options, method: "PATCH", body: { status: "closed" } }), context)).status).toBe(404);
    for (const accountId of [own.account.id, other.account.id]) {
      expect((await sendReply(request(`/api/conversations/${other.thread.id}/messages`, {
        ...options, method: "POST", body: { accountId, text: "Must not send" },
      }), context)).status).toBe(404);
    }
    for (const channel of ["dm", "post", "story"]) {
      expect((await rules(request(`/api/automations?account_id=${other.account.id}&channel=${channel}`, options))).status).toBe(404);
    }
    for (const channel of ["post", "story"]) {
      expect((await media(request(`/api/media?account_id=${other.account.id}&channel=${channel}`, options))).status).toBe(404);
    }
    expect((await createRule(request("/api/automations", { ...options, method: "POST", body: other.input }))).status).toBe(404);
    for (const accountId of [own.account.id, other.account.id]) {
      expect((await editRule(request("/api/automations", { ...options, method: "PUT", body: { ...other.input, accountId, id: other.rule.id } }))).status).toBe(404);
      for (const action of ["enable", "pause", "move-up", "move-down"]) {
        expect((await actOnRule(request("/api/automations", { ...options, method: "PATCH", body: { accountId, id: other.rule.id, action } }))).status).toBe(404);
      }
      expect((await deleteRule(request("/api/automations", { ...options, method: "DELETE", body: { accountId, id: other.rule.id } }))).status).toBe(404);
    }
    expect((await disconnect(request(`/api/accounts/${other.account.id}`, { ...options, method: "DELETE" }), { params: Promise.resolve({ id: other.account.id }) })).status).toBe(404);
    expect(await getRules(other.account.id, "dm")).toEqual([other.rule]);
    expect(await getAccountById(other.account.id)).toMatchObject({ isActive: true });
    expect(fetch).not.toHaveBeenCalled();
  });
});
