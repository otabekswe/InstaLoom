import { NextRequest, NextResponse } from "next/server";
import { ApiError, apiResponse, requireSession } from "@/lib/auth";
import { requireAutomationAccount } from "@/lib/automations/access";
import { listInstagramMedia } from "@/lib/instagram/media";

export async function GET(request: NextRequest) {
  return apiResponse(async () => {
    const { user } = await requireSession(request);
    const accountId = request.nextUrl.searchParams.get("account_id") ?? "";
    await requireAutomationAccount(accountId, user.id);
    const channel = request.nextUrl.searchParams.get("channel");
    const cursor = request.nextUrl.searchParams.get("after") ?? undefined;
    if ((channel !== "post" && channel !== "story") || (cursor && cursor.length > 2048)) throw new ApiError(400, "Choose Post or Story.");
    try { return NextResponse.json(await listInstagramMedia(accountId, channel, cursor)); }
    catch { throw new ApiError(502, "Couldn’t load Instagram media. Try again or reconnect your account in Settings."); }
  });
}
