export class ConfigurationError extends Error {}
export class OwnerConfigurationError extends ConfigurationError {}

export function getAppUrl(): URL {
  const configured = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (process.env.VERCEL && !configured) {
    throw new ConfigurationError("Set APP_URL to this deployment’s HTTPS origin before connecting Instagram.");
  }
  const value = configured || "http://localhost:3000";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError("APP_URL must be a valid application origin.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(local && !process.env.VERCEL && url.protocol === "http:")) ||
    url.username || url.password || url.search || url.hash || url.pathname !== "/"
  ) {
    throw new ConfigurationError("APP_URL must be an HTTPS origin, or HTTP localhost for development.");
  }
  return url;
}

export function getAllowedOrigins(): Set<string> {
  const app = getAppUrl();
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(app.hostname);
  const port = app.port || (app.protocol === "https:" ? "443" : "80");
  const origins = new Set([app.origin]);
  if (local && /^\d{1,5}$/.test(port) && Number(port) <= 65535) {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      origins.add(new URL(`http://${host}:${port}`).origin);
    }
  }
  return origins;
}

export function getInstagramConfig() {
  const appId = process.env.INSTAGRAM_APP_ID || "";
  const appSecret = process.env.INSTAGRAM_APP_SECRET || "";
  if (!/^\d+$/.test(appId) || !appSecret || appSecret.startsWith("your_")) {
    throw new ConfigurationError("Add INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET from Instagram business login settings, then restart InstaLoom.");
  }
  return {
    appId,
    appSecret,
    redirectUri: new URL("/api/auth/instagram/callback", getAppUrl()).href,
  };
}

/** Optional single-account restriction, using Graph's canonical Instagram user_id. */
export function getOwnerInstagramId(): string | null {
  const value = (process.env.OWNER_INSTAGRAM_ID || "").trim();
  if (!value) return null;
  if (!/^\d+$/.test(value)) {
    throw new OwnerConfigurationError("Set OWNER_INSTAGRAM_ID to a numeric Instagram user_id, or leave it empty to allow Meta-authorized accounts.");
  }
  return value;
}

export function isInstagramAccountAllowed(instagramAccountId: string): boolean {
  const ownerId = getOwnerInstagramId();
  return ownerId === null || instagramAccountId === ownerId;
}
