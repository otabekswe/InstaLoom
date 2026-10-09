import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { after, NextRequest, NextResponse } from "next/server";
import { POST as logout } from "@/app/api/auth/logout/route";
import { GET as session } from "@/app/api/auth/session/route";
import { GET as accounts } from "@/app/api/accounts/route";
import { GET as conversations } from "@/app/api/conversations/route";
import { GET as conversation, PATCH as updateConversation } from "@/app/api/conversations/[id]/route";
import { POST as send } from "@/app/api/conversations/[id]/messages/route";
import { GET as startOAuth } from "@/app/api/auth/instagram/route";
import { GET as callback } from "@/app/api/auth/instagram/callback/route";
import { closeDb, getDb } from "@/lib/db";
import { createSession, OAUTH_COOKIE, SESSION_COOKIE } from "@/lib/auth";
import { getAllowedOrigins, getAppUrl } from "@/lib/config";
import { upsertConversation } from "@/lib/instagram";
import { request, resetDatabase, seedAccount } from "./helpers";

vi.mock("next/server", async (importOriginal) => ({
  ...await importOriginal<typeof import("next/server")>(),
  after: vi.fn(),
}));

function cookie(response: NextResponse, name = SESSION_COOKIE) {
  return `${name}=${response.cookies.get(name)!.value}`;
}

// API authorization tests get an isolated server-issued session; the OAuth
// tests below exercise the actual anonymous start, exchange, and callback.
async function signIn() {
  await seedAccount();
  const response = NextResponse.json({});
  await createSession({ id: "default", name: "Meta test user" }, request("/"), response);
  return cookie(response);
}

async function begin(existingCookie?: string) {
  const response = await startOAuth(request("/api/auth/instagram", { cookie: existingCookie }));
  expect(response.status).toBe(200);
  const url = new URL((await response.json()).url);
  return { response, url, state: url.searchParams.get("state")!, cookie: [cookie(response, OAUTH_COOKIE), existingCookie].filter(Boolean).join("; ") };
}

function mockMeta(subject = "200", envelope = false) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    const wrap = (value: unknown) => Response.json(envelope ? { data: [value] } : value);
    if (url.href === "https://api.instagram.com/oauth/access_token") return wrap({ access_token: "fake-short-token", user_id: "app-scoped-999", permissions: "instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments" });
    if (url.href.startsWith("https://graph.instagram.com/access_token?")) return Response.json({ access_token: "fake-instagram-token", expires_in: 5184000 });
    if (url.href.startsWith("https://graph.instagram.com/v25.0/me?")) return wrap({ id: "app-scoped-999", user_id: subject, username: "studio", name: "Alex Studio", profile_picture_url: "https://example.test/avatar.jpg" });
    if (url.href === `https://graph.instagram.com/v25.0/${subject}/subscribed_apps`) return Response.json({ success: true });
    throw new Error("Unexpected Instagram request in test");
  });
}

async function finish(flow: Awaited<ReturnType<typeof begin>>) {
  return callback(request(`/api/auth/instagram/callback?code=test-code&state=${flow.state}`, { cookie: flow.cookie }));
}

beforeEach(async () => { await resetDatabase(); vi.stubEnv("INSTAGRAM_APP_ID", "123456789"); });
afterEach(async () => { await closeDb(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("workspace sessions", () => {
  it("rejects anonymous API requests without requiring owner configuration", async () => {
    vi.stubEnv("OWNER_INSTAGRAM_ID", "");
    expect((await accounts(request("/api/accounts?user_id=default"))).status).toBe(401);
    expect((await conversations(request("/api/conversations?account_id=anything"))).status).toBe(401);
  });

  it("stores only a hashed session and revokes on sign out", async () => {
    const token = await signIn();
    expect((await (await session(request("/api/auth/session", { cookie: token }))).json()).user).toEqual({ id: "default", name: "Test owner" });
    const stored = await getDb().prepare("SELECT token_hash FROM auth_sessions").get() as { token_hash: string };
    expect(stored.token_hash).not.toBe(token.split("=")[1]);
    expect((await logout(request("/api/auth/logout", { method: "POST", cookie: token, origin: "https://attacker.example" }))).status).toBe(403);
    expect((await logout(request("/api/auth/logout", { method: "POST", cookie: token }))).status).toBe(200);
    expect((await session(request("/api/auth/session", { cookie: token }))).status).toBe(401);
  });

  it("rejects expired and pre-owner sessions", async () => {
    const token = await signIn();
    for (const version of ["legacy-credential-hash", "instagram-login:123456789", "owner-instagram:v1:123456789:200"]) {
      const response = NextResponse.json({});
      await createSession({ id: "default", name: "Test owner" }, request("/"), response);
      await getDb().prepare("UPDATE auth_sessions SET auth_version = ?").run(version);
      expect((await session(request("/api/auth/session", { cookie: cookie(response) }))).status).toBe(401);
    }
    expect((await session(request("/api/auth/session", { cookie: token }))).status).toBe(401);
    const response = NextResponse.json({});
    await createSession({ id: "default", name: "Test owner" }, request("/"), response);
    await getDb().prepare("UPDATE auth_sessions SET expires_at = 0").run();
    expect((await session(request("/api/auth/session", { cookie: cookie(response) }))).status).toBe(401);
  });

  it.each([
    ["OWNER_INSTAGRAM_ID", "222"],
    ["OWNER_INSTAGRAM_ID", ""],
    ["OWNER_INSTAGRAM_ID", "not-an-id"],
    ["INSTAGRAM_APP_ID", "987654321"],
  ])("rejects an existing session after %s changes to %s", async (key, value) => {
    const token = await signIn();
    vi.stubEnv(key, value);
    expect((await session(request("/api/auth/session", { cookie: token }))).status).toBe(401);
    expect((await accounts(request("/api/accounts", { cookie: token }))).status).toBe(401);
  });

  it("rejects a session after its owner identity is removed", async () => {
    const token = await signIn();
    await getDb().prepare("DELETE FROM instagram_identities").run();
    expect((await session(request("/api/auth/session", { cookie: token }))).status).toBe(401);
    expect(await getDb().prepare("SELECT count(*) AS n FROM auth_sessions").get()).toEqual({ n: 0 });
  });

  it("cannot issue a session for a user without the configured owner identity", async () => {
    await seedAccount("another-user", "other-account");
    const response = NextResponse.json({});
    await expect(createSession({ id: "another-user", name: "Other" }, request("/"), response)).rejects.toMatchObject({ status: 403 });
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
    expect(await getDb().prepare("SELECT count(*) AS n FROM auth_sessions").get()).toEqual({ n: 0 });
  });

  it("requires a current-app identity when multiple accounts are allowed", async () => {
    vi.stubEnv("OWNER_INSTAGRAM_ID", "");
    const token = await signIn();
    await getDb().prepare("UPDATE instagram_identities SET app_id = 'another-app'").run();
    expect((await session(request("/api/auth/session", { cookie: token }))).status).toBe(401);
    const response = NextResponse.json({});
    await expect(createSession({ id: "default", name: "Other app user" }, request("/"), response)).rejects.toMatchObject({ status: 403 });
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });

  it("invalidates multi-account sessions when the owner restriction is enabled", async () => {
    vi.stubEnv("OWNER_INSTAGRAM_ID", "");
    const token = await signIn();
    vi.stubEnv("OWNER_INSTAGRAM_ID", "200");
    expect((await session(request("/api/auth/session", { cookie: token }))).status).toBe(401);
  });
});

describe("account and conversation authorization", () => {
  it("reads messages without marking them read and schedules optional profile work", async () => {
    const token = await signIn();
    const own = await upsertConversation({ instagramAccountId: "account-1", customerPsid: "customer" });
    await getDb().prepare("UPDATE conversations SET is_unread = 1 WHERE id = ?").run(own.id);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await conversation(request(`/api/conversations/${own.id}`, { cookie: token }), { params: Promise.resolve({ id: own.id }) });
    expect(response.status).toBe(200);
    expect((await response.json()).conversation.isUnread).toBe(true);
    expect(after).toHaveBeenCalledWith(expect.any(Function));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns public accounts without access tokens and ignores supplied user IDs", async () => {
    const token = await signIn();
    await seedAccount("another-user", "other-account");
    const result = await (await accounts(request("/api/accounts?user_id=another-user", { cookie: token }))).json();
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]).toMatchObject({ id: "account-1", isActive: true, instagramUsername: "studio" });
    expect(JSON.stringify(result)).not.toMatch(/private-test-token|access_token|accessToken/);
    expect((await conversations(request("/api/conversations?account_id=other-account", { cookie: token }))).status).toBe(404);
  });

  it("hides previously linked non-owner accounts within the owner's workspace", async () => {
    const token = await signIn();
    await seedAccount("default", "legacy-account");
    const legacy = await upsertConversation({ instagramAccountId: "legacy-account", customerPsid: "legacy-customer" });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const linked = await (await accounts(request("/api/accounts", { cookie: token }))).json();
    expect(linked.accounts.map((account: { id: string }) => account.id)).toEqual(["account-1"]);
    expect((await conversations(request("/api/conversations?account_id=legacy-account", { cookie: token }))).status).toBe(404);
    expect((await conversation(request(`/api/conversations/${legacy.id}`, { cookie: token }), { params: Promise.resolve({ id: legacy.id }) })).status).toBe(404);
    expect((await updateConversation(request(`/api/conversations/${legacy.id}`, {
      method: "PATCH", cookie: token, body: { status: "closed" },
    }), { params: Promise.resolve({ id: legacy.id }) })).status).toBe(404);
    expect((await send(request(`/api/conversations/${legacy.id}/messages`, {
      method: "POST", cookie: token, body: { accountId: "legacy-account", text: "Must not send" },
    }), { params: Promise.resolve({ id: legacy.id }) })).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects cross-account access, invalid status, and mismatched reply account", async () => {
    const token = await signIn();
    await seedAccount("another-user", "other-account");
    const other = await upsertConversation({ instagramAccountId: "other-account", customerPsid: "other-customer" });
    const own = await upsertConversation({ instagramAccountId: "account-1", customerPsid: "own-customer" });
    expect((await conversation(request(`/api/conversations/${other.id}`, { cookie: token }), { params: Promise.resolve({ id: other.id }) })).status).toBe(404);
    expect((await updateConversation(request(`/api/conversations/${own.id}`, { method: "PATCH", cookie: token, body: { status: "invented-status" } }), { params: Promise.resolve({ id: own.id }) })).status).toBe(400);
    const response = await send(request(`/api/conversations/${own.id}/messages`, { method: "POST", cookie: token, body: { accountId: "other-account", text: "Do not send" } }), { params: Promise.resolve({ id: own.id }) });
    expect([400, 404]).toContain(response.status);
  });

  it("enforces Instagram's UTF-8 byte limit before sending a message", async () => {
    const token = await signIn();
    const own = await upsertConversation({ instagramAccountId: "account-1", customerPsid: "own-customer" });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await send(request(`/api/conversations/${own.id}/messages`, {
      method: "POST", cookie: token, body: { accountId: "account-1", text: "🌊".repeat(251) },
    }), { params: Promise.resolve({ id: own.id }) });
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Instagram OAuth sign-in", () => {
  it("starts anonymously with a short-lived browser cookie and no workspace access", async () => {
    const flow = await begin();
    expect(flow.url.origin).toBe("https://www.instagram.com");
    expect(flow.url.pathname).toBe("/oauth/authorize");
    expect(flow.url.searchParams.get("enable_fb_login")).toBe("false");
    expect(flow.url.searchParams.get("scope")?.split(",")).toEqual([
      "instagram_business_basic", "instagram_business_manage_messages", "instagram_business_manage_comments",
    ]);
    expect(flow.url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/auth/instagram/callback");
    expect(flow.response.cookies.get(OAUTH_COOKIE)).toMatchObject({ httpOnly: true, sameSite: "lax", maxAge: 600, path: "/api/auth/instagram" });
    expect(flow.response.cookies.get(SESSION_COOKIE)).toBeUndefined();
    expect((await accounts(request("/api/accounts", { cookie: flow.cookie }))).status).toBe(401);
  });

  it("rejects another browser, expired state, and forged state without contacting Meta", async () => {
    const first = await begin();
    const second = await begin();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    expect((await finish({ ...first, cookie: second.cookie })).headers.get("location")).toContain("error=invalid_state");
    expect((await finish({ ...first, state: "forged" })).headers.get("location")).toContain("error=invalid_state");
    await getDb().prepare("UPDATE oauth_flows SET expires_at = 0").run();
    expect((await finish(first)).headers.get("location")).toContain("error=invalid_state");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("connects, creates a session from Meta identity, and rejects callback replay", async () => {
    const flow = await begin();
    const fetchMock = mockMeta();
    const result = await finish(flow);
    expect(result.headers.get("location")).toBe("http://localhost:3000/inbox?connected=1");
    const token = cookie(result);
    expect(result.cookies.get(SESSION_COOKIE)).toMatchObject({ httpOnly: true, sameSite: "lax", maxAge: 604800 });
    expect(result.cookies.get(OAUTH_COOKIE)?.maxAge).toBe(0);
    const current = await (await session(request("/api/auth/session", { cookie: token }))).json();
    expect(current.user.name).toBe("Alex Studio");
    expect(current.user).not.toHaveProperty("email");
    const linked = await (await accounts(request("/api/accounts", { cookie: token }))).json();
    expect(linked.accounts[0]).toMatchObject({ instagramAccountId: "200", isActive: true, instagramUsername: "studio" });
    expect(JSON.stringify(linked)).not.toContain("fake-instagram-token");
    const calls = fetchMock.mock.calls.length;
    expect((await finish(flow)).headers.get("location")).toContain("error=invalid_state");
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  });

  it("consumes an OAuth state only once across simultaneous callbacks", async () => {
    const flow = await begin();
    const fetchMock = mockMeta();
    const results = await Promise.all([finish(flow), finish(flow)]);
    expect(results.map((response) => response.headers.get("location")).sort()).toEqual([
      "http://localhost:3000/inbox?connected=1",
      "http://localhost:3000/login?error=invalid_state",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(await getDb().prepare("SELECT count(*) AS n FROM auth_sessions").get()).toEqual({ n: 1 });
  });

  it("uses the Instagram exchange, long-lived token, canonical user ID, and subscriptions", async () => {
    const fetchMock = mockMeta("200", true);
    const result = await finish(await begin());
    expect(result.headers.get("location")).toContain("/inbox?connected=1");
    const calls = fetchMock.mock.calls;
    expect(calls).toHaveLength(4);
    expect(String(calls[0][0])).toBe("https://api.instagram.com/oauth/access_token");
    expect(calls[0][1]?.method).toBe("POST");
    const form = new URLSearchParams(String(calls[0][1]?.body));
    expect(Object.fromEntries(form)).toMatchObject({ client_id: "123456789", client_secret: "test-instagram-secret", grant_type: "authorization_code", code: "test-code" });
    expect(new URL(String(calls[1][0])).searchParams.get("grant_type")).toBe("ig_exchange_token");
    expect(String(calls[3][0])).toBe("https://graph.instagram.com/v25.0/200/subscribed_apps");
    expect(JSON.parse(String(calls[3][1]?.body))).toEqual({ subscribed_fields: "messages,messaging_postbacks,messaging_seen,comments" });
    const account = await getDb().prepare("SELECT instagram_account_id, token_expires_at, access_token FROM instagram_accounts").get() as Record<string, unknown>;
    expect(account.instagram_account_id).toBe("200");
    expect(account.access_token).toBe("fake-instagram-token");
    expect(Number(account.token_expires_at)).toBeGreaterThan(Date.now() + 59 * 86400_000);
    expect(calls.every(([url]) => !String(url).includes("facebook.com"))).toBe(true);
  });

  it("does not use the old Meta credentials as Instagram login credentials", async () => {
    vi.stubEnv("INSTAGRAM_APP_ID", "");
    vi.stubEnv("META_APP_ID", "old-facebook-app");
    const result = await startOAuth(request("/api/auth/instagram"));
    expect(result.status).toBe(503);
    expect((await result.json()).error).toContain("INSTAGRAM_APP_ID");
  });

  it("does not create a session if required permissions are declined", async () => {
    const flow = await begin();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ access_token: "short", permissions: "instagram_business_basic" }));
    const response = await finish(flow);
    expect(response.headers.get("location")).toContain("error=missing_permissions");
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
    expect(await getDb().prepare("SELECT count(*) AS n FROM instagram_accounts").get()).toEqual({ n: 0 });
  });

  it("keeps a subscription failure retryable without reporting a connected account", async () => {
    const fetchMock = mockMeta();
    const implementation = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((...args) => String(args[0]).endsWith("/subscribed_apps")
      ? Promise.resolve(Response.json({ error: "no permission" }, { status: 403 })) : implementation(...args));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await finish(await begin());
    expect(response.headers.get("location")).toContain("error=auth_failed");
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
    expect(await getDb().prepare("SELECT count(*) AS n FROM instagram_accounts").get()).toEqual({ n: 0 });
  });

  it("rejects a non-owner without creating a user, identity, account, or session", async () => {
    const fetchMock = mockMeta("222");
    const response = await finish(await begin());
    expect(response.headers.get("location")).toBe("http://localhost:3000/login?error=not_owner");
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
    expect(response.cookies.get(OAUTH_COOKIE)?.maxAge).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const table of ["users", "instagram_identities", "instagram_accounts", "auth_sessions"]) {
      expect(await getDb().prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
  });

  it.each(["test", "production"])("rejects a malformed owner restriction in %s before starting authorization", async (environment) => {
    vi.stubEnv("NODE_ENV", environment);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    for (const owner of ["studio", "200,222"]) {
      vi.stubEnv("OWNER_INSTAGRAM_ID", owner);
      const response = await startOAuth(request("/api/auth/instagram"));
      expect(response.status).toBe(503);
      expect((await response.json()).error).toContain("OWNER_INSTAGRAM_ID");
      expect(response.cookies.get(OAUTH_COOKIE)).toBeUndefined();
    }
    expect(await getDb().prepare("SELECT count(*) AS n FROM oauth_flows").get()).toEqual({ n: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["OWNER_INSTAGRAM_ID", ""],
    ["OWNER_INSTAGRAM_ID", "222"],
    ["OWNER_INSTAGRAM_ID", "invalid"],
    ["INSTAGRAM_APP_ID", "987654321"],
  ])("rejects an in-flight callback after %s changes to %s", async (key, value) => {
    const flow = await begin();
    vi.stubEnv(key, value);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await finish(flow);
    expect(response.headers.get("location")).toContain("error=invalid_state");
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await getDb().prepare("SELECT count(*) AS n FROM users").get()).toEqual({ n: 0 });
  });

  it("gives separate Meta-authorized accounts isolated sessions and account lists", async () => {
    vi.stubEnv("OWNER_INSTAGRAM_ID", "");
    const firstFetch = mockMeta("200");
    const first = await finish(await begin());
    expect(first.headers.get("location")).toContain("/inbox?connected=1");
    firstFetch.mockRestore();
    mockMeta("222");
    const second = await finish(await begin());
    expect(second.headers.get("location")).toContain("/inbox?connected=1");
    const firstCookie = cookie(first);
    const secondCookie = cookie(second);
    const firstUser = (await (await session(request("/api/auth/session", { cookie: firstCookie }))).json()).user;
    const secondUser = (await (await session(request("/api/auth/session", { cookie: secondCookie }))).json()).user;
    expect(firstUser.id).not.toBe(secondUser.id);
    const firstAccounts = (await (await accounts(request(`/api/accounts?user_id=${secondUser.id}`, { cookie: firstCookie }))).json()).accounts;
    const secondAccounts = (await (await accounts(request(`/api/accounts?user_id=${firstUser.id}`, { cookie: secondCookie }))).json()).accounts;
    expect(firstAccounts).toHaveLength(1);
    expect(secondAccounts).toHaveLength(1);
    expect(firstAccounts[0].instagramAccountId).toBe("200");
    expect(secondAccounts[0].instagramAccountId).toBe("222");
    expect(JSON.stringify([firstAccounts, secondAccounts])).not.toContain("fake-instagram-token");
    expect(await getDb().prepare("SELECT count(*) AS n FROM instagram_identities").get()).toEqual({ n: 2 });
    expect(await getDb().prepare("SELECT count(*) AS n FROM auth_sessions").get()).toEqual({ n: 2 });
    const repeat = await finish(await begin());
    expect((await (await session(request("/api/auth/session", { cookie: cookie(repeat) }))).json()).user.id).toBe(secondUser.id);
  });

  it.each([false, true])("does not attach a different account during reconnect (existing account: %s)", async (existingAccount) => {
    vi.stubEnv("OWNER_INSTAGRAM_ID", "");
    const firstFetch = mockMeta("200");
    const first = await finish(await begin());
    const firstToken = cookie(first);
    firstFetch.mockRestore();
    const otherFetch = mockMeta("222");
    if (existingAccount) await finish(await begin());
    otherFetch.mockClear();
    const reconnect = await finish(await begin(firstToken));
    expect(reconnect.headers.get("location")).toBe("http://localhost:3000/settings?error=account_mismatch");
    expect(reconnect.cookies.get(SESSION_COOKIE)).toBeUndefined();
    expect(otherFetch).toHaveBeenCalledTimes(3);
    expect((await session(request("/api/auth/session", { cookie: firstToken }))).status).toBe(200);
    for (const table of ["users", "instagram_identities", "instagram_accounts", "auth_sessions"]) {
      expect(await getDb().prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: existingAccount ? 2 : 1 });
    }
    const ownAccounts = (await (await accounts(request("/api/accounts", { cookie: firstToken }))).json()).accounts;
    expect(ownAccounts.map((account: { instagramAccountId: string }) => account.instagramAccountId)).toEqual(["200"]);
  });

  it("rotates a session for a same-account reconnect without an owner restriction", async () => {
    vi.stubEnv("OWNER_INSTAGRAM_ID", "");
    mockMeta("222");
    const first = await finish(await begin());
    const second = await finish(await begin(cookie(first)));
    expect(second.headers.get("location")).toContain("/inbox?connected=1");
    expect((await session(request("/api/auth/session", { cookie: cookie(first) }))).status).toBe(401);
    expect((await session(request("/api/auth/session", { cookie: cookie(second) }))).status).toBe(200);
    expect(await getDb().prepare("SELECT count(*) AS n FROM users").get()).toEqual({ n: 1 });
    expect(await getDb().prepare("SELECT count(*) AS n FROM instagram_accounts").get()).toEqual({ n: 1 });
  });

  it("reuses the same workspace and preserves only verified legacy Instagram data", async () => {
    await seedAccount(); await seedAccount("default", "unrelated-account");
    await getDb().prepare("DELETE FROM instagram_identities").run();
    await getDb().prepare("UPDATE instagram_accounts SET instagram_account_id = '200', token_expires_at = NULL, access_token = '' WHERE id = 'account-1'").run();
    const existing = await upsertConversation({ instagramAccountId: "account-1", customerPsid: "customer" });
    mockMeta();
    const first = await finish(await begin());
    const firstSession = await (await session(request("/api/auth/session", { cookie: cookie(first) }))).json();
    const linked = await (await accounts(request("/api/accounts", { cookie: cookie(first) }))).json();
    expect(linked.accounts).toHaveLength(1);
    expect(linked.accounts[0].id).toBe("account-1");
    expect((await conversation(request(`/api/conversations/${existing.id}`, { cookie: cookie(first) }), { params: Promise.resolve({ id: existing.id }) })).status).toBe(200);
    const second = await finish(await begin());
    const nextSession = await (await session(request("/api/auth/session", { cookie: cookie(second) }))).json();
    expect(nextSession.user.id).toBe(firstSession.user.id);
    expect((await getDb().prepare("SELECT user_id FROM instagram_accounts WHERE id = 'unrelated-account'").get() as { user_id: string }).user_id).toBe("default");
  });

  it("refuses a different identity during reconnect and preserves the owner session", async () => {
    const fetchMock = mockMeta();
    const first = await finish(await begin());
    const firstToken = cookie(first);
    fetchMock.mockRestore();
    const otherFetch = mockMeta("222");
    const reconnect = await finish(await begin(firstToken));
    expect(reconnect.headers.get("location")).toBe("http://localhost:3000/settings?error=not_owner");
    expect(reconnect.cookies.get(SESSION_COOKIE)).toBeUndefined();
    expect(otherFetch).toHaveBeenCalledTimes(3);
    expect((await session(request("/api/auth/session", { cookie: firstToken }))).status).toBe(200);
    expect(await getDb().prepare("SELECT count(*) AS n FROM instagram_accounts").get()).toEqual({ n: 1 });
  });

  it("rotates the session when the owner reconnects", async () => {
    mockMeta();
    const first = await finish(await begin());
    const second = await finish(await begin(cookie(first)));
    expect(second.headers.get("location")).toContain("/inbox?connected=1");
    expect(cookie(second)).not.toBe(cookie(first));
    expect((await session(request("/api/auth/session", { cookie: cookie(first) }))).status).toBe(401);
    expect((await session(request("/api/auth/session", { cookie: cookie(second) }))).status).toBe(200);
    expect(await getDb().prepare("SELECT count(*) AS n FROM instagram_accounts").get()).toEqual({ n: 1 });
  });

  it("revokes pending reconnects on logout", async () => {
    const token = await signIn();
    const flow = await begin(token);
    await logout(request("/api/auth/logout", { method: "POST", cookie: token }));
    const fetchMock = vi.spyOn(globalThis, "fetch");
    expect((await finish(flow)).headers.get("location")).toContain("error=invalid_state");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns cancellation and provider failures to the login screen without a session", async () => {
    const flow = await begin();
    const cancelled = await callback(request(`/api/auth/instagram/callback?error=access_denied&state=${flow.state}`, { cookie: flow.cookie }));
    expect(cancelled.headers.get("location")).toBe("http://localhost:3000/login?error=auth_cancelled");
    const failedFlow = await begin();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: "failed" }, { status: 400 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = await finish(failedFlow);
    expect(failure.headers.get("location")).toContain("/login?error=auth_failed");
    expect(failure.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });

  it("requires the configured public origin and sets secure OAuth cookies there", async () => {
    vi.stubEnv("APP_URL", "https://workspace.example.test");
    expect((await startOAuth(request("/api/auth/instagram"))).status).toBe(409);
    expect((await startOAuth(request("/api/auth/instagram", { origin: "https://attacker.example" }))).status).toBe(409);
    const response = await startOAuth(new NextRequest("https://workspace.example.test/api/auth/instagram"));
    expect(response.status).toBe(200);
    expect(response.cookies.get(OAUTH_COOKIE)?.secure).toBe(true);
  });
});

describe("deployment origin configuration", () => {
  it("requires an explicit HTTPS application origin on Vercel", () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(() => getAppUrl()).toThrow("APP_URL");
    vi.stubEnv("APP_URL", "http://localhost:3000");
    expect(() => getAppUrl()).toThrow("HTTPS");
    vi.stubEnv("APP_URL", "https://workspace.example.test");
    expect(getAppUrl().origin).toBe("https://workspace.example.test");
  });

  it("accepts only the configured origin for hosted workspace mutations", () => {
    vi.stubEnv("APP_URL", "https://workspace.example.test");
    expect([...getAllowedOrigins()]).toEqual(["https://workspace.example.test"]);
  });
});
