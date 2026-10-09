import { NextRequest, NextResponse } from "next/server";
import { ApiError, apiResponse, clearOAuthCookie, consumeOAuthState, createSession, getSession, resolveOAuthUser } from "@/lib/auth";
import { ConfigurationError, OwnerConfigurationError, getAppUrl, getInstagramConfig, getOwnerInstagramId } from "@/lib/config";
import { linkInstagramAccount, subscribeAccountWebhooks } from "@/lib/instagram";
import { exchangeInstagramCode, getInstagramIdentity, MissingInstagramPermissions } from "@/lib/instagram/oauth";

export async function GET(request: NextRequest) {
  return apiResponse(async () => {
    const appUrl = getAppUrl();
    const session = await getSession(request);
    const settingsError = (code: string) => {
      const url = new URL(session ? "/settings" : "/login", appUrl);
      url.searchParams.set("error", code);
      const response = NextResponse.redirect(url);
      clearOAuthCookie(response);
      return response;
    };
    const flow = await consumeOAuthState(request);
    if (!flow) return settingsError("invalid_state");
    const code = request.nextUrl.searchParams.get("code");
    if (!code) return settingsError(request.nextUrl.searchParams.has("error") ? "auth_cancelled" : "missing_code");

    try {
      const ownerId = getOwnerInstagramId();
      const config = getInstagramConfig();
      const token = await exchangeInstagramCode(code);
      const profile = await getInstagramIdentity(token.access_token);
      if (profile.user_id !== ownerId) return settingsError("not_owner");
      const user = await resolveOAuthUser({ appId: config.appId, subject: profile.user_id, name: profile.name || profile.username }, flow.userId);
      await subscribeAccountWebhooks({ instagramAccountId: profile.user_id, accessToken: token.access_token });
      await linkInstagramAccount({
        userId: user.id, instagramAccountId: profile.user_id, accessToken: token.access_token,
        displayName: profile.name || profile.username, username: profile.username, profilePic: profile.profile_picture_url ?? undefined,
        expiresIn: token.expires_in, claimLegacyAccount: true,
      });
      // Use the configured origin, never a proxy-supplied Host header.
      const response = NextResponse.redirect(new URL("/inbox?connected=1", appUrl));
      await createSession(user, request, response);
      clearOAuthCookie(response);
      return response;
    } catch (error) {
      if (error instanceof OwnerConfigurationError) return settingsError("owner_not_configured");
      if (error instanceof ConfigurationError) return settingsError("configuration_required");
      if (error instanceof ApiError && error.status === 403) return settingsError("not_owner");
      if (error instanceof MissingInstagramPermissions) return settingsError("missing_permissions");
      if (error instanceof ApiError && error.status === 409) return settingsError("account_mismatch");
      console.error("Instagram OAuth could not complete.");
      return settingsError("auth_failed");
    }
  });
}
