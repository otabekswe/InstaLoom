import { NextRequest, NextResponse } from "next/server";
import { ApiError, apiResponse, createOAuthState } from "@/lib/auth";
import { getAppUrl, getInstagramConfig, getOwnerInstagramId } from "@/lib/config";
import { INSTAGRAM_SCOPES } from "@/lib/instagram/oauth";

export async function GET(request: NextRequest) {
  return apiResponse(async () => {
    const config = getInstagramConfig();
    getOwnerInstagramId();
    const appOrigin = getAppUrl().origin;
    let sourceOrigin: string;
    try {
      sourceOrigin = new URL(request.headers.get("origin") || request.headers.get("referer") || request.url).origin;
    } catch {
      throw new ApiError(403, "Open your workspace to connect Instagram.");
    }
    if (sourceOrigin !== appOrigin || request.headers.get("sec-fetch-site") === "cross-site") {
      throw new ApiError(409, `Open ${appOrigin} to connect Instagram. Authorization must return to the same browser.`);
    }
    const authUrl = new URL("https://www.instagram.com/oauth/authorize");
    authUrl.searchParams.set("client_id", config.appId);
    authUrl.searchParams.set("redirect_uri", config.redirectUri);
    const cookies = new NextResponse();
    authUrl.searchParams.set("state", await createOAuthState(request, cookies));
    authUrl.searchParams.set("scope", INSTAGRAM_SCOPES.join(","));
    authUrl.searchParams.set("enable_fb_login", "false");
    authUrl.searchParams.set("force_reauth", "true");
    authUrl.searchParams.set("response_type", "code");
    return NextResponse.json({ url: authUrl.toString() }, { headers: cookies.headers });
  });
}
