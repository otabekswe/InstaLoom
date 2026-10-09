import { z } from "zod";
import { getInstagramConfig } from "@/lib/config";
import { graphRequest, instagramRequest } from "./client";

export const INSTAGRAM_SCOPES = [
  "instagram_business_basic", "instagram_business_manage_messages", "instagram_business_manage_comments",
] as const;

const nonempty = z.string().min(1);
const shortTokenSchema = z.object({
  access_token: nonempty,
  permissions: z.union([z.string(), z.array(z.string())]).optional(),
});
const longTokenSchema = z.object({ access_token: nonempty, expires_in: z.number().int().positive().max(366 * 86400) });
const profileSchema = z.object({
  // user_id is the webhook/Graph ID; id is app-scoped and must not route events.
  user_id: z.string().regex(/^\d+$/), username: nonempty,
  name: z.string().nullish(), profile_picture_url: z.string().nullish(),
});

// Meta documents both direct objects and single-element data envelopes.
function single<T>(schema: z.ZodType<T>) {
  return z.union([schema, z.object({ data: z.array(schema).length(1) }).transform((result) => result.data[0])]);
}

export class MissingInstagramPermissions extends Error {}

export async function exchangeInstagramCode(code: string) {
  const config = getInstagramConfig();
  const body = new URLSearchParams({
    client_id: config.appId, client_secret: config.appSecret, grant_type: "authorization_code",
    redirect_uri: config.redirectUri, code,
  });
  const initial = await instagramRequest(new URL("https://api.instagram.com/oauth/access_token"), single(shortTokenSchema), {
    method: "POST", body,
  });
  if (initial.permissions !== undefined) {
    const granted = Array.isArray(initial.permissions) ? initial.permissions : initial.permissions.split(",").map((value) => value.trim());
    if (INSTAGRAM_SCOPES.some((scope) => !granted.includes(scope))) throw new MissingInstagramPermissions();
  }
  const url = new URL("https://graph.instagram.com/access_token");
  url.search = new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: config.appSecret, access_token: initial.access_token }).toString();
  return instagramRequest(url, longTokenSchema);
}

export function getInstagramIdentity(accessToken: string) {
  return graphRequest("me", accessToken, single(profileSchema), {
    query: { fields: "user_id,username,name,profile_picture_url" },
  });
}

export function refreshInstagramToken(accessToken: string) {
  const url = new URL("https://graph.instagram.com/refresh_access_token");
  url.search = new URLSearchParams({ grant_type: "ig_refresh_token", access_token: accessToken }).toString();
  return instagramRequest(url, longTokenSchema);
}
