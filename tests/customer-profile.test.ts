import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb } from "@/lib/db";
import { enrichCustomerProfile } from "@/lib/customer-profile";
import { getConversationById, upsertConversation } from "@/lib/instagram";
import { resetDatabase, seedAccount } from "./helpers";

beforeEach(async () => { await resetDatabase(); await seedAccount(); });
afterEach(async () => { await closeDb(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("optional customer profiles", () => {
  it("fills a missing profile and avoids fetching names already known", async () => {
    const conversation = await upsertConversation({ instagramAccountId: "account-1", customerPsid: "customer" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ name: "Ada", profile_pic: "https://example.test/ada.jpg" }));
    await enrichCustomerProfile(conversation.id, "default");
    expect(await getConversationById(conversation.id)).toMatchObject({ customerName: "Ada", customerProfilePic: "https://example.test/ada.jpg" });
    await enrichCustomerProfile(conversation.id, "default");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throttles failed lookups but permits a retry after an hour", async () => {
    const conversation = await upsertConversation({ instagramAccountId: "account-1", customerPsid: "customer" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unavailable"));
    await Promise.all([enrichCustomerProfile(conversation.id, "default"), enrichCustomerProfile(conversation.id, "default")]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await getDb().prepare("UPDATE customer_profile_attempts SET attempted_at = 0").run();
    await enrichCustomerProfile(conversation.id, "default");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("checks ownership and preserves a newer name while rejecting unsafe images", async () => {
    const conversation = await upsertConversation({ instagramAccountId: "account-1", customerPsid: "customer" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await getDb().prepare("UPDATE conversations SET customer_name = 'Newer name' WHERE id = ?").run(conversation.id);
      return Response.json({ name: "Older name", profile_pic: "javascript:alert(1)" });
    });
    await enrichCustomerProfile(conversation.id, "another-user");
    expect(fetchMock).not.toHaveBeenCalled();
    await enrichCustomerProfile(conversation.id, "default");
    expect(await getConversationById(conversation.id)).toMatchObject({ customerName: "Newer name", customerProfilePic: null });
  });
});
