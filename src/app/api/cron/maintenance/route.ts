import { timingSafeEqual } from "node:crypto";
import { after, NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { getOwnerInstagramId } from "@/lib/config";
import { getAccountAccessToken } from "@/lib/instagram";
import { instagramAccountScope } from "@/lib/instagram/account-scope";
import { dispatchAutomations } from "@/lib/automations/dispatch";

export const maxDuration = 120;

async function runMaintenance() {
  await dispatchAutomations();
  const scope = instagramAccountScope("i");
  // Expired connections need a fresh sign-in; they must not prevent other
  // workspaces from renewing tokens that are still eligible for refresh.
  const accounts = await getDb().prepare(`SELECT i.id FROM instagram_accounts i
    WHERE i.is_active = 1 AND i.access_token != '' AND i.token_expires_at > ? AND ${scope.sql}`)
    .all(Date.now(), ...scope.params) as { id: string }[];
  let failed = false;
  for (const account of accounts) {
    try { await getAccountAccessToken(account.id); }
    catch { failed = true; }
  }
  if (failed) throw new Error("Account maintenance did not complete.");
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const supplied = request.headers.get("authorization") ?? "";
  const expected = secret ? `Bearer ${secret}` : "";
  if (!secret || Buffer.byteLength(supplied) !== Buffer.byteLength(expected)
    || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  try {
    getOwnerInstagramId();
    if (request.nextUrl.searchParams.get("background") === "1") {
      // External schedulers can have shorter HTTP timeouts than the worker.
      // Next keeps this work alive after the response, within maxDuration.
      after(async () => {
        try { await runMaintenance(); }
        catch { console.error("Scheduled maintenance did not complete."); }
      });
      return Response.json({ accepted: true }, { status: 202, headers: { "Cache-Control": "no-store" } });
    }
    await runMaintenance();
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error("Scheduled maintenance did not complete.");
    return Response.json({ ok: false }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
