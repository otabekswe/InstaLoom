import { createHash, randomBytes, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { ConfigurationError, getAllowedOrigins, getAppUrl, getOwnerInstagramId } from "@/lib/config";

export const SESSION_COOKIE = "instaloom_session";
export const OAUTH_COOKIE = "instaloom_oauth";
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const OAUTH_SECONDS = 10 * 60;

export class ApiError extends Error {
  constructor(public status: number, message: string, public retryAfter?: number) {
    super(message);
  }
}

export interface AuthUser { id: string; name: string }
export interface AuthSession { user: AuthUser; tokenHash: string }

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function authVersion(): string {
  return `instagram-login:v2:${process.env.INSTAGRAM_APP_ID || ""}:${getOwnerInstagramId() ?? "all"}`;
}

export async function getSession(request: NextRequest): Promise<AuthSession | null> {
  return getSessionFromToken(request.cookies.get(SESSION_COOKIE)?.value);
}

export async function getSessionFromToken(token: string | undefined): Promise<AuthSession | null> {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  let ownerId: string | null;
  let version: string;
  try { ownerId = getOwnerInstagramId(); version = authVersion(); }
  catch (error) {
    if (error instanceof ConfigurationError) return null;
    throw error;
  }
  const db = getDb();
  const tokenHash = digest(token);
  const session = await db.prepare(`SELECT s.user_id, s.auth_version, s.expires_at, u.name,
    EXISTS (SELECT 1 FROM instagram_identities i WHERE i.user_id = s.user_id AND i.app_id = ? ${ownerId ? "AND i.subject = ?" : ""}) AS has_identity
    FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE token_hash = ?`
  ).get(process.env.INSTAGRAM_APP_ID || "", ...(ownerId ? [ownerId] : []), tokenHash) as {
    user_id: string; auth_version: string; expires_at: number; name: string | null; has_identity: number | boolean;
  } | undefined;
  if (!session) return null;
  if (session.expires_at <= Date.now() || session.auth_version !== version || !session.has_identity) {
    await db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(tokenHash);
    return null;
  }
  return { user: { id: session.user_id, name: session.name || "Instagram account" }, tokenHash };
}

export async function requireSession(request: NextRequest): Promise<AuthSession> {
  const session = await getSession(request);
  if (!session) throw new ApiError(401, "Connect with Instagram to continue.");
  return session;
}

export function requireSameOrigin(request: NextRequest): void {
  const origin = request.headers.get("origin");
  if (!origin || !getAllowedOrigins().has(origin)) {
    throw new ApiError(403, "This request must come from your InstaLoom workspace.");
  }
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    throw new ApiError(403, "Cross-site requests are not allowed.");
  }
}

export function sessionCookieOptions() {
  return { httpOnly: true, sameSite: "lax" as const, secure: getAppUrl().protocol === "https:", path: "/" };
}

/** Only call after retrieving the identity from Meta with the exchanged user token. */
export async function resolveOAuthUser(identity: { appId: string; subject: string; name: string }, workspaceUserId?: string | null): Promise<AuthUser> {
  const ownerId = getOwnerInstagramId();
  if ((ownerId && identity.subject !== ownerId) || identity.appId !== process.env.INSTAGRAM_APP_ID) {
    throw new ApiError(403, "This workspace is private. Sign in with its configured Instagram owner account.");
  }
  const db = getDb();
  return db.transaction(async () => {
    const existing = await db.prepare("SELECT user_id FROM instagram_identities WHERE app_id = ? AND subject = ?")
      .get(identity.appId, identity.subject) as { user_id: string } | undefined;
    if (workspaceUserId && existing?.user_id !== workspaceUserId) {
      throw new ApiError(409, "Sign out before connecting a different Instagram account.");
    }
    const id = existing?.user_id ?? randomUUID();
    const name = identity.name.trim().slice(0, 200) || "Instagram account";
    if (existing && !workspaceUserId) {
      await db.prepare("UPDATE users SET name = ?, updated_at = datetime('now') WHERE id = ?").run(name, id);
    } else if (!existing && !workspaceUserId) {
      // The legacy users schema requires this unique column. It is an internal
      // placeholder, never requested from Meta, used for login, or sent to clients.
      await db.prepare("INSERT INTO users (id, email, name) VALUES (?, ?, ?)").run(id, `${id}@oauth.invalid`, name);
    }
    if (!existing) await db.prepare("INSERT INTO instagram_identities (app_id, subject, user_id) VALUES (?, ?, ?)").run(identity.appId, identity.subject, id);
    const user = await db.prepare("SELECT name FROM users WHERE id = ?").get(id) as { name: string | null };
    return { id, name: user.name || name };
  })();
}

export async function createSession(user: AuthUser, request: NextRequest, response: NextResponse): Promise<void> {
  const version = authVersion();
  const ownerId = getOwnerInstagramId();
  const token = randomBytes(32).toString("base64url");
  const db = getDb();
  await db.transaction(async () => {
    const identity = await db.prepare(`SELECT user_id FROM instagram_identities WHERE app_id = ? AND user_id = ? ${ownerId ? "AND subject = ?" : ""}`)
      .get(process.env.INSTAGRAM_APP_ID || "", user.id, ...(ownerId ? [ownerId] : []));
    if (!identity) throw new ApiError(403, "Connect an authorized Instagram account to access this workspace.");
    await db.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(Date.now());
    const previous = request.cookies.get(SESSION_COOKIE)?.value;
    if (previous) await db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(digest(previous));
    await db.prepare("INSERT INTO auth_sessions (token_hash, user_id, auth_version, expires_at) VALUES (?, ?, ?, ?)")
      .run(digest(token), user.id, version, Date.now() + SESSION_SECONDS * 1000);
  })();
  response.cookies.set(SESSION_COOKIE, token, { ...sessionCookieOptions(), maxAge: SESSION_SECONDS });
}

export function clearOAuthCookie(response: NextResponse): void {
  response.cookies.set(OAUTH_COOKIE, "", { ...sessionCookieOptions(), path: "/api/auth/instagram", maxAge: 0 });
}

export async function revokeSession(request: NextRequest): Promise<NextResponse> {
  const db = getDb();
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (token) await db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(digest(token));
  const response = NextResponse.json({ success: true });
  response.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(), maxAge: 0 });
  clearOAuthCookie(response);
  return response;
}

export async function createOAuthState(request: NextRequest, response: NextResponse): Promise<string> {
  const version = authVersion();
  const db = getDb();
  const state = randomBytes(32).toString("base64url");
  const browser = randomBytes(32).toString("base64url");
  const previous = request.cookies.get(OAUTH_COOKIE)?.value;
  const session = await getSession(request);
  await db.transaction(async () => {
    await db.prepare("DELETE FROM oauth_flows WHERE expires_at <= ?").run(Date.now());
    if (previous) await db.prepare("DELETE FROM oauth_flows WHERE browser_hash = ?").run(digest(previous));
    await db.prepare("INSERT INTO oauth_flows (state_hash, browser_hash, session_hash, expires_at) VALUES (?, ?, ?, ?)")
      .run(digest(`${version}:${state}`), digest(browser), session?.tokenHash ?? null, Date.now() + OAUTH_SECONDS * 1000);
  })();
  response.cookies.set(OAUTH_COOKIE, browser, { ...sessionCookieOptions(), path: "/api/auth/instagram", maxAge: OAUTH_SECONDS });
  return state;
}

export async function consumeOAuthState(request: NextRequest): Promise<{ userId: string | null } | null> {
  const state = request.nextUrl.searchParams.get("state");
  const browser = request.cookies.get(OAUTH_COOKIE)?.value;
  if (!state || !browser || !/^[A-Za-z0-9_-]{43}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(browser)) return null;
  let version: string;
  try { version = authVersion(); }
  catch (error) {
    if (error instanceof ConfigurationError) return null;
    throw error;
  }
  const db = getDb();
  return db.transaction(async () => {
    const flow = await db.prepare(`DELETE FROM oauth_flows WHERE state_hash = ? AND browser_hash = ? AND expires_at > ?
      RETURNING session_hash`).get(digest(`${version}:${state}`), digest(browser), Date.now()) as { session_hash: string | null } | undefined;
    if (!flow) return null;
    const session = await getSession(request);
    if (flow.session_hash !== (session?.tokenHash ?? null)) return null;
    return { userId: session?.user.id ?? null };
  })();
}

export async function readJson<T>(request: NextRequest, schema: z.ZodType<T>): Promise<T> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    throw new ApiError(415, "Send a JSON request body.");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "A request body is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, 5_000);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut) throw new ApiError(408, "Request body timed out. Please try again.");
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) {
        await reader.cancel();
        throw new ApiError(413, "Request body is too large.");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "Could not read the request body.");
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ApiError(400, "Invalid JSON request body."); }
  const result = schema.safeParse(body);
  if (!result.success) throw new ApiError(400, "Check the request fields and try again.");
  return result.data;
}

export async function apiResponse(handler: () => Promise<NextResponse> | NextResponse): Promise<NextResponse> {
  let response: NextResponse;
  try {
    response = await handler();
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ConfigurationError) {
      response = NextResponse.json({ error: error.message }, { status: 503 });
    } else if (error instanceof ApiError) {
      response = NextResponse.json({ error: error.message }, { status: error.status });
      if (error.retryAfter) response.headers.set("Retry-After", String(error.retryAfter));
    } else {
      // Upstream errors may contain access tokens; never serialize or log them.
      console.error("The workspace API could not complete a request.");
      response = NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
    }
  }
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
