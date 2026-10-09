import { timingSafeEqual } from "node:crypto";
import { after, NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { getOwnerInstagramId } from "@/lib/config";
import { getAccountAccessToken } from "@/lib/instagram";
import { dispatchAutomations } from "@/lib/automations/dispatch";

export const maxDuration = 120;

async function runMaintenance(ownerId: string) {
  await dispatchAutomations();
  const accounts = await getDb().prepare("SELECT id FROM instagram_accounts WHERE instagram_account_id = ? AND is_active = 1")
    .all(ownerId) as { id: string }[];
  for (const account of accounts) await getAccountAccessToken(account.id);
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
    const ownerId = getOwnerInstagramId();
    if (request.nextUrl.searchParams.get("background") === "1") {
      // External schedulers can have shorter HTTP timeouts than the worker.
      // Next keeps this work alive after the response, within maxDuration.
      after(async () => {
        try { await runMaintenance(ownerId); }
        catch { console.error("Scheduled maintenance did not complete."); }
      });
      return Response.json({ accepted: true }, { status: 202, headers: { "Cache-Control": "no-store" } });
    }
    await runMaintenance(ownerId);
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error("Scheduled maintenance did not complete.");
    return Response.json({ ok: false }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
