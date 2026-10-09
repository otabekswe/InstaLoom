import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/cron/maintenance/route";
import { closeDb, getDb } from "@/lib/db";
import { getAccountById, upsertConversation } from "@/lib/instagram";
import { getRuns, saveRule } from "@/lib/automations/store";
import { processWebhook } from "@/lib/webhook";
import { instagramMessage, resetDatabase, seedAccount } from "./helpers";
import type { AutomationInput } from "@/lib/automations/schema";

const rule: AutomationInput = {
  name: "Price details", accountId: "account-1", channel: "dm", mediaId: "", enabled: true,
  matchAll: false, keywords: ["price"], publicReply: "", dmReply: "Here are the details.",
};

function cron(authorization: string | null = "Bearer local-cron-test-secret") {
  return GET(new NextRequest("http://localhost:3000/api/cron/maintenance", {
    headers: authorization === null ? {} : { authorization },
  }));
}

beforeEach(async () => {
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
    expect((await cron(authorization)).status).toBe(401);
    expect((await getRuns("account-1", "dm"))[0].status).toBe("queued");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed when no cron secret is configured", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await cron()).status).toBe(401);
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

  it("reports configuration failures without exposing credentials or queued content", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("OWNER_INSTAGRAM_ID", "");
    const response = await cron();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false });
    expect(fetch).not.toHaveBeenCalled();
  });
});
