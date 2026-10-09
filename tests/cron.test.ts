import { after, NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/cron/maintenance/route";
import { closeDb, getDb } from "@/lib/db";
import { getAccountById, upsertConversation } from "@/lib/instagram";
import { getRuns, saveRule } from "@/lib/automations/store";
import { processWebhook } from "@/lib/webhook";
import { instagramMessage, resetDatabase, seedAccount } from "./helpers";
import type { AutomationInput } from "@/lib/automations/schema";

vi.mock("next/server", async (original) => ({ ...await original<typeof import("next/server")>(), after: vi.fn() }));

const rule: AutomationInput = {
  name: "Price details", accountId: "account-1", channel: "dm", mediaId: "", enabled: true,
  matchAll: false, keywords: ["price"], publicReply: "", dmReply: "Here are the details.",
};

function cron(authorization: string | null = "Bearer local-cron-test-secret", background = false) {
  return GET(new NextRequest(`http://localhost:3000/api/cron/maintenance${background ? "?background=1" : ""}`, {
    headers: authorization === null ? {} : { authorization },
  }));
}

beforeEach(async () => {
  vi.mocked(after).mockClear();
  await resetDatabase();
  await seedAccount();
  vi.stubEnv("CRON_SECRET", "local-cron-test-secret");
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected external request"));
});
afterEach(async () => { await closeDb(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("scheduled maintenance", () => {
  it.each([null, "Bearer wrong", "Basic local-cron-test-secret"])("requires the cron bearer secret (%s)", async (authorization) => {
    await saveRule(rule);
    await processWebhook(instagramMessage("queued", Date.now(), "price"));
    for (const background of [false, true]) {
      expect((await cron(authorization, background)).status).toBe(401);
    }
    expect(after).not.toHaveBeenCalled();
    expect((await getRuns("account-1", "dm"))[0].status).toBe("queued");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed when no cron secret is configured", async () => {
    vi.stubEnv("CRON_SECRET", "");
    for (const background of [false, true]) {
      expect((await cron(undefined, background)).status).toBe(401);
    }
    expect(after).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("recovers a queued reply without any workspace visit", async () => {
    await saveRule(rule);
    await processWebhook(instagramMessage("recover", Date.now(), "price"));
    vi.mocked(fetch).mockResolvedValue(Response.json({ message_id: "cron-sent" }));
    const response = await cron();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true });
    expect((await getRuns("account-1", "dm"))[0].status).toBe("sent");
    expect((await cron()).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("accepts external scheduler requests before delivery, then recovers queued replies in the background", async () => {
    await saveRule(rule);
    await processWebhook(instagramMessage("background-recover", Date.now(), "price"));
    vi.mocked(fetch).mockResolvedValue(Response.json({ message_id: "background-sent" }));
    const response = await cron(undefined, true);
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ accepted: true });
    expect(after).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect((await getRuns("account-1", "dm"))[0].status).toBe("queued");

    const work = vi.mocked(after).mock.calls[0][0];
    if (typeof work !== "function") throw new Error("Expected a background callback");
    await work();
    expect((await getRuns("account-1", "dm"))[0].status).toBe("sent");
    // A daily Vercel invocation cannot resend the completed reply.
    expect((await cron()).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("logs background failures without exposing private data or an unhandled rejection", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await cron(undefined, true)).status).toBe(202);
    vi.spyOn(getDb(), "transaction").mockRejectedValue(new Error("private-worker-failure"));
    const work = vi.mocked(after).mock.calls[0][0];
    if (typeof work !== "function") throw new Error("Expected a background callback");
    await expect(work()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledExactlyOnceWith("Scheduled maintenance did not complete.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("marks interrupted sends unknown and never resends them", async () => {
    await saveRule(rule);
    await processWebhook(instagramMessage("interrupted", Date.now(), "price"));
    await getDb().prepare("UPDATE automation_runs SET status='sending',updated_at=?").run(Date.now() - 180_000);
    expect((await cron()).status).toBe(200);
    expect((await getRuns("account-1", "dm"))[0].status).toBe("unknown");
    expect((await cron()).status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not claim, clean up, recover, or refresh another account's legacy records", async () => {
    await seedAccount("other", "legacy-account");
    const legacyRule = await saveRule({ ...rule, accountId: "legacy-account" });
    const conversation = await upsertConversation({ instagramAccountId: "legacy-account", customerPsid: "legacy-customer" });
    for (const status of ["queued", "sending"]) {
      await getDb().prepare(`INSERT INTO automation_runs(id,rule_id,revision,event_key,customer_id,conversation_id,action,reply_text,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(`legacy-${status}`, legacyRule.id, legacyRule.revision, status,
        "legacy-customer", conversation.id, "dm", "Legacy reply", status, Date.now() - 7200_000, Date.now() - 180_000);
    }
    await getDb().prepare("UPDATE instagram_accounts SET token_expires_at=?,token_refreshed_at=? WHERE id=?")
      .run(Date.now() + 86400_000, Date.now() - 30 * 86400_000, "legacy-account");
    expect((await cron()).status).toBe(200);
    expect((await getRuns("legacy-account", "dm")).map((run) => run.status).sort()).toEqual(["queued", "sending"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes the active owner's expiring token", async () => {
    await getDb().prepare("UPDATE instagram_accounts SET token_expires_at=?,token_refreshed_at=? WHERE id=?")
      .run(Date.now() + 86400_000, Date.now() - 30 * 86400_000, "account-1");
    vi.mocked(fetch).mockResolvedValue(Response.json({ access_token: "refreshed-private-token", token_type: "bearer", expires_in: 60 * 86400 }));
    expect((await cron()).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new URL(String(vi.mocked(fetch).mock.calls[0][0])).pathname).toBe("/refresh_access_token");
    expect((await getAccountById("account-1"))?.accessToken).toBe("refreshed-private-token");
  });

  it("refreshes every verified workspace while skipping expired and foreign-app connections", async () => {
    vi.stubEnv("OWNER_INSTAGRAM_ID", "");
    for (const [userId, accountId, subject, appId] of [
      ["tester", "tester-account", "222", "123456789"],
      ["foreign", "foreign-account", "333", "other-app"],
    ]) {
      await seedAccount(userId, accountId);
      await getDb().prepare("UPDATE instagram_accounts SET instagram_account_id = ?, access_token = ? WHERE id = ?")
        .run(subject, `token-${subject}`, accountId);
      await getDb().prepare("INSERT INTO instagram_identities(app_id,subject,user_id) VALUES(?,?,?)")
        .run(appId, subject, userId);
    }
    await getDb().prepare("UPDATE instagram_accounts SET token_expires_at=?,token_refreshed_at=?")
      .run(Date.now() + 86400_000, Date.now() - 30 * 86400_000);
    vi.mocked(fetch).mockImplementation(async (url) => Response.json({
      access_token: `${new URL(String(url)).searchParams.get("access_token")}-renewed`, expires_in: 60 * 86400,
    }));
    expect((await cron()).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await getAccountById("account-1"))?.accessToken).toBe("private-test-token-renewed");
    expect((await getAccountById("tester-account"))?.accessToken).toBe("token-222-renewed");
    expect(await getDb().prepare("SELECT access_token FROM instagram_accounts WHERE id = ?").get("foreign-account"))
      .toEqual({ access_token: "token-333" });

    vi.mocked(fetch).mockClear();
    await getDb().prepare("UPDATE instagram_accounts SET token_expires_at = ? WHERE id = ?").run(Date.now() - 1, "account-1");
    await getDb().prepare("UPDATE instagram_accounts SET token_expires_at=?,token_refreshed_at=?,token_refresh_attempted_at=0 WHERE id=?")
      .run(Date.now() + 86400_000, Date.now() - 30 * 86400_000, "tester-account");
    expect((await cron()).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await getAccountById("tester-account"))?.accessToken).toBe("token-222-renewed-renewed");
  });

  it("reports configuration failures without exposing credentials or queued content", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("OWNER_INSTAGRAM_ID", "invalid-id");
    for (const background of [false, true]) {
      const response = await cron(undefined, background);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ ok: false });
    }
    expect(after).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
