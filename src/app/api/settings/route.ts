import { NextRequest, NextResponse } from "next/server";
import { apiResponse, requireSession } from "@/lib/auth";
import { getPrivacyContact } from "@/lib/privacy";
import { getAppUrl, getInstagramConfig } from "@/lib/config";

export async function GET(request: NextRequest) {
  return apiResponse(async () => {
    await requireSession(request);
    const appUrl = getAppUrl();
    let instagramConfigured = false;
    try { getInstagramConfig(); instagramConfigured = true; } catch { /* Setup is incomplete. */ }
    const verifyToken = process.env.WEBHOOK_VERIFY_TOKEN || "";
    const signingSecret = process.env.INSTAGRAM_APP_SECRET || "";
    return NextResponse.json({
      appUrl: appUrl.origin,
      privacyUrl: new URL("/privacy", appUrl).href,
      dataDeletionUrl: new URL("/data-deletion", appUrl).href,
      privacyContactConfigured: getPrivacyContact().configured,
      webhookUrl: new URL("/api/webhook", appUrl).href,
      redirectUri: new URL("/api/auth/instagram/callback", appUrl).href,
      instagramConfigured,
      webhookConfigured: Boolean(signingSecret && !signingSecret.startsWith("your_") && verifyToken && !verifyToken.startsWith("your_")),
    });
  });
}
