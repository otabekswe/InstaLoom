import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb } from "@/lib/db";
import { disconnectAccount, getAccountAccessToken, getAccountById, toPublicAccount } from "@/lib/instagram";
import { resetDatabase, seedAccount } from "./helpers";

const DAY = 86400_000;
beforeEach(async () => { await resetDatabase(); await seedAccount(); });
afterEach(async () => { await closeDb(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function expiring() {
  await getDb().prepare("UPDATE instagram_accounts SET token_expires_at = ?, token_refreshed_at = ?")
    .run(Date.now() + 3 * DAY, Date.now() - 57 * DAY);
}

describe("Instagram user token lifecycle", () => {
  it("never uses a stored token for an account other than the configured owner", async () => {
    await seedAccount("other", "other-account");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(getAccountAccessToken("other-account")).rejects.toThrow(/Reconnect/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses a fresh token without a network request and never exposes it to the browser", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    expect(await getAccountAccessToken("account-1")).toBe("private-test-token");
    expect(fetchMock).not.toHaveBeenCalled();
    const account = toPublicAccount((await getAccountById("account-1"))!);
    expect(account.needsReconnect).toBe(false);
    expect(account).not.toHaveProperty("accessToken");
    expect(JSON.stringify(account)).not.toContain("private-test-token");
  });

  it("refreshes once for concurrent requests and stores the returned expiry", async () => {
    await expiring();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ access_token: "renewed-token", expires_in: 5184000 }));
    expect(await Promise.all([getAccountAccessToken("account-1"), getAccountAccessToken("account-1")])).toEqual(["renewed-token", "renewed-token"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe("https://graph.instagram.com/refresh_access_token");
    expect(url.searchParams.get("grant_type")).toBe("ig_refresh_token");
    expect(url.searchParams.get("access_token")).toBe("private-test-token");
    expect((await getAccountById("account-1"))!.tokenExpiresAt).toBeGreaterThan(Date.now() + 59 * DAY);
    expect(await getAccountAccessToken("account-1")).toBe("renewed-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("backs off after a refresh failure while retaining an unexpired token", async () => {
    await expiring();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("temporary failure"));
    expect(await getAccountAccessToken("account-1")).toBe("private-test-token");
    expect(await getAccountAccessToken("account-1")).toBe("private-test-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not attempt to refresh a token less than 24 hours old", async () => {
    await expiring();
    await getDb().prepare("UPDATE instagram_accounts SET token_refreshed_at = ?").run(Date.now() - DAY / 2);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    expect(await getAccountAccessToken("account-1")).toBe("private-test-token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires reconnect for an expired token and never refreshes it", async () => {
    await getDb().prepare("UPDATE instagram_accounts SET token_expires_at = ?").run(Date.now() - 1);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(getAccountAccessToken("account-1")).rejects.toThrow(/Reconnect/);
    expect(toPublicAccount((await getAccountById("account-1"))!).needsReconnect).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cannot restore a token when the account disconnects during a refresh", async () => {
    await expiring();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      expect(await disconnectAccount("account-1", "default")).toBe(true);
      return Response.json({ access_token: "renewed-token", expires_in: 5184000 });
    });
    await expect(getAccountAccessToken("account-1")).rejects.toThrow(/Reconnect/);
    expect(await getAccountById("account-1")).toMatchObject({ isActive: false, accessToken: "" });
  });
});
