import { after, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, SESSION_COOKIE } from "@/lib/auth";
import { closeDb, getDb } from "@/lib/db";
import { GET, POST, PUT, PATCH, DELETE } from "@/app/api/automations/route";
import { GET as media } from "@/app/api/media/route";
import { dispatchAutomations } from "@/lib/automations/dispatch";
import { getRules, getRuns, saveRule, updateRule, moveRule } from "@/lib/automations/store";
import { processWebhook, webhookEventSchema } from "@/lib/webhook";
import { getMessages, getConversationByPsid } from "@/lib/instagram";
import { instagramMessage, request, resetDatabase, seedAccount } from "./helpers";
import type { AutomationInput } from "@/lib/automations/schema";
vi.mock("next/server", async (original) => ({ ...await original<typeof import("next/server")>(), after: vi.fn() }));
const defaultRule: AutomationInput = { name: "Price details", accountId: "account-1", channel: "dm", mediaId: "", enabled: true, matchAll: false, keywords: ["price"], publicReply: "", dmReply: "Here are the details." };
let cookie: string;
beforeEach(async () => {
    (await resetDatabase());
    (await seedAccount());
    const response = NextResponse.json({});
    (await createSession({ id: "default", name: "Owner" }, request("/"), response));
    cookie = `${SESSION_COOKIE}=${response.cookies.get(SESSION_COOKIE)!.value}`;
});
afterEach(async () => { (await closeDb()); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function save(body: unknown, options = {}) { return POST(request("/api/automations", { method: "POST", cookie, body, ...options })); }
function comment(mediaId = "post-1", id = "comment-1", extra = {}) {
    return webhookEventSchema.parse({ object: "instagram", entry: [{ id: "200", time: Math.floor(Date.now() / 1000), changes: [{ field: "comments", value: { id, media: { id: mediaId }, from: { id: "customer-1" }, text: "PRICE please", ...extra } }] }] });
}
function mockSends() {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
        if (String(url).endsWith("/replies"))
            return Response.json({ id: "public-comment-result" });
        if (String(url).endsWith("/messages"))
            return Response.json({ message_id: "sent-message-result" });
        throw new Error("Unexpected request");
    });
}
describe("automation setup", () => {
    it("requires a session, same origin, and ownership for rules and media", async () => {
        (await seedAccount("other", "other-account"));
        expect((await GET(request("/api/automations?account_id=account-1&channel=dm"))).status).toBe(401);
        expect((await save(defaultRule, { origin: "https://attacker.example" })).status).toBe(403);
        expect((await save({ ...defaultRule, accountId: "other-account" })).status).toBe(404);
        expect((await GET(request("/api/automations?account_id=other-account&channel=dm", { cookie }))).status).toBe(404);
        const fetch = vi.spyOn(globalThis, "fetch");
        expect((await media(request("/api/media?account_id=other-account&channel=post", { cookie }))).status).toBe(404);
        expect(fetch).not.toHaveBeenCalled();
    });
    it("defaults to paused, validates replies, and creates separate rules in the same context", async () => {
        const input: Partial<AutomationInput> = { ...defaultRule };
        delete input.enabled;
        expect((await save(input)).status).toBe(201);
        expect((await getRules("account-1", "dm"))[0].enabled).toBe(false);
        expect((await save({ ...defaultRule, keywords: [] })).status).toBe(400);
        expect((await save({ ...defaultRule, publicReply: "Public DM?" })).status).toBe(400);
        expect((await save({ ...defaultRule, dmReply: "🌊".repeat(251) })).status).toBe(400);
        await save(defaultRule);
        expect((await getRules("account-1", "dm"))).toHaveLength(2);
        expect((await getRules("account-1", "dm")).map((rule) => rule.enabled)).toEqual([false, true]);
    });
    it("lists account media using Bearer auth, follows only cursors, and validates selections", async () => {
        expect((await save({ ...defaultRule, channel: "post", mediaId: "post-1" })).status).toBe(400);
        const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: [{ id: "post-1", media_type: "VIDEO", timestamp: new Date().toISOString(), media_url: "https://cdn.example/movie.mp4", thumbnail_url: "https://cdn.example/thumb.jpg" }], paging: { next: "https://untrusted.example/path", cursors: { after: "next-page" } } }));
        const response = await media(request("/api/media?account_id=account-1&channel=post", { cookie }));
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ media: [{ id: "post-1", imageUrl: "https://cdn.example/thumb.jpg" }], nextCursor: "next-page" });
        expect(String(fetch.mock.calls[0][0])).toContain("/200/media?");
        expect(fetch.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer private-test-token" });
        expect((await save({ ...defaultRule, channel: "post", mediaId: "post-1", publicReply: "Check your DMs" })).status).toBe(201);
        expect((await save({ ...defaultRule, channel: "story", mediaId: "post-1" })).status).toBe(400);
    });
    it("keeps expired stories editable but prevents enabling them", async () => {
        (await getDb().prepare("INSERT INTO instagram_media VALUES(?,?,?,?,?)").run("account-1", "story-1", "story", JSON.stringify({ id: "story-1", channel: "story", timestamp: new Date(Date.now() - 2 * 86400000).toISOString() }), Date.now()));
        expect((await save({ ...defaultRule, channel: "story", mediaId: "story-1" })).status).toBe(409);
        expect((await save({ ...defaultRule, channel: "story", mediaId: "story-1", enabled: false })).status).toBe(201);
        const rule = (await getRules("account-1", "story"))[0];
        expect((await PATCH(request("/api/automations", { method: "PATCH", cookie, body: { accountId: rule.accountId, id: rule.id, action: "enable" } }))).status).toBe(409);
        expect((await PATCH(request("/api/automations", { method: "PATCH", cookie, body: { accountId: rule.accountId, id: rule.id, action: "pause" } }))).status).toBe(200);
    });
    it("edits by identity and rejects edits, toggles, and moves across accounts or contexts", async () => {
        const first = (await saveRule(defaultRule));
        const sibling = (await saveRule({ ...defaultRule, name: "Opening hours", keywords: ["hours"] }));
        (await seedAccount("other", "other-account"));
        const foreign = (await saveRule({ ...defaultRule, accountId: "other-account" }));
        const edit = (body: unknown) => PUT(request("/api/automations", { method: "PUT", cookie, body }));
        expect((await edit({ ...defaultRule, id: first.id, name: "Updated price", dmReply: "New details" })).status).toBe(200);
        expect((await getRules("account-1", "dm"))).toMatchObject([{ id: first.id, name: "Updated price", dmReply: "New details" }, sibling]);
        expect((await edit(defaultRule)).status).toBe(400);
        expect((await edit({ ...defaultRule, id: first.id, name: " " })).status).toBe(400);
        expect((await edit({ ...defaultRule, id: foreign.id })).status).toBe(404);
        expect((await edit({ ...defaultRule, id: first.id, channel: "post", mediaId: "post-1" })).status).toBe(404);
        for (const action of ["enable", "pause", "move-up", "move-down"]) {
            const body = { accountId: "account-1", id: foreign.id, action };
            expect((await PATCH(request("/api/automations", { method: "PATCH", cookie, body }))).status).toBe(404);
            expect((await PATCH(request("/api/automations", { method: "PATCH", body }))).status).toBe(401);
            expect((await PATCH(request("/api/automations", { method: "PATCH", cookie, body, origin: "https://attacker.example" }))).status).toBe(403);
        }
        expect((await getRules("other-account", "dm"))).toEqual([foreign]);
    });
    it("reorders only sibling rules, keeps saved order, and pauses one rule independently", async () => {
        const first = (await saveRule(defaultRule));
        const second = (await saveRule({ ...defaultRule, name: "Fallback", matchAll: true, keywords: [] }));
        const post = (await saveRule({ ...defaultRule, channel: "post", mediaId: "post-1" }));
        const response = await PATCH(request("/api/automations", { method: "PATCH", cookie, body: { accountId: "account-1", id: second.id, action: "move-up" } }));
        expect(response.status).toBe(200);
        expect((await response.json()).rules.map((rule: {
            id: string;
        }) => rule.id)).toEqual([second.id, first.id]);
        await PATCH(request("/api/automations", { method: "PATCH", cookie, body: { accountId: "account-1", id: second.id, action: "pause" } }));
        expect((await getRules("account-1", "dm")).map((rule) => [rule.id, rule.enabled])).toEqual([[second.id, false], [first.id, true]]);
        expect((await getRules("account-1", "post"))).toEqual([post]);
        (await moveRule("account-1", first.id, 1)); // Already last: no change.
        expect((await getRules("account-1", "dm")).map((rule) => rule.id)).toEqual([second.id, first.id]);
    });
    it("returns each saved post once even when it has several rules", async () => {
        (await getDb().prepare("INSERT INTO instagram_media VALUES(?,?,?,?,?)").run("account-1", "post-1", "post", JSON.stringify({ id: "post-1", channel: "post", timestamp: new Date().toISOString() }), Date.now()));
        (await saveRule({ ...defaultRule, channel: "post", mediaId: "post-1" }));
        (await saveRule({ ...defaultRule, channel: "post", mediaId: "post-1", name: "Second" }));
        const response = await GET(request("/api/automations?account_id=account-1&channel=post", { cookie }));
        const data = await response.json();
        expect(data.rules).toHaveLength(2);
        expect(data.media).toHaveLength(1);
    });
    it("requires authentication, same origin, and rule ownership before deleting", async () => {
        const rule = (await saveRule(defaultRule));
        (await seedAccount("other", "other-account"));
        const foreign = (await saveRule({ ...defaultRule, accountId: "other-account" }));
        const body = { accountId: "account-1", id: rule.id };
        expect((await DELETE(request("/api/automations", { method: "DELETE", body }))).status).toBe(401);
        expect((await DELETE(request("/api/automations", { method: "DELETE", cookie, body, origin: "https://attacker.example" }))).status).toBe(403);
        expect((await DELETE(request("/api/automations", { method: "DELETE", cookie, body: { ...body, id: foreign.id } }))).status).toBe(404);
        expect((await DELETE(request("/api/automations", { method: "DELETE", cookie, body: { accountId: foreign.accountId, id: foreign.id } }))).status).toBe(404);
        expect((await DELETE(request("/api/automations", { method: "DELETE", cookie, body: { ...body, id: "invalid" } }))).status).toBe(400);
        expect((await getRules("account-1", "dm"))).toEqual([rule]);
        expect((await getRules("other-account", "dm"))).toEqual([foreign]);
    });
});
describe("automation delivery", () => {
    it.each(["dm", "post", "story"] as const)("deletes only the selected %s rule and cancels its queued replies without erasing conversations", async (channel) => {
        const context = { ...defaultRule, channel, mediaId: channel === "dm" ? "" : `${channel}-1` };
        const selected = (await saveRule(context));
        const sibling = (await saveRule({ ...context, name: "Other automation", keywords: ["guide"] }));
        const send = async (id: string, text: string) => {
            if (channel === "post")
                return processWebhook(comment("post-1", id, { text }));
            const event = instagramMessage(id, Date.now(), text);
            if (channel === "story")
                Object.assign(event.entry[0].messaging[0].message, { reply_to: { story: { id: "story-1" } } });
            return processWebhook(webhookEventSchema.parse(event));
        };
        await send("delete-me", "price");
        await send("keep-me", "guide");
        const conversation = (await getConversationByPsid("account-1", "customer-1"))!;
        const messages = (await getMessages(conversation.id));
        const response = await DELETE(request("/api/automations", { method: "DELETE", cookie, body: { accountId: "account-1", id: selected.id } }));
        expect(response.status).toBe(200);
        expect((await response.json()).rules).toEqual([sibling]);
        expect((await getRuns("account-1", channel))).toMatchObject([{ ruleId: sibling.id, status: "queued" }]);
        expect((await getMessages(conversation.id))).toEqual(messages);
        const fetch = mockSends();
        await dispatchAutomations();
        expect(fetch).toHaveBeenCalledTimes(1);
        await send("deleted-keyword", "price");
        await dispatchAutomations();
        expect(fetch).toHaveBeenCalledTimes(1);
    });
    it("blocks deletion during a send and permits it after the send finishes", async () => {
        const rule = (await saveRule(defaultRule));
        await processWebhook(instagramMessage("sending", Date.now(), "price"));
        (await getDb().prepare("UPDATE automation_runs SET status = 'sending'").run());
        const remove = () => DELETE(request("/api/automations", { method: "DELETE", cookie, body: { accountId: "account-1", id: rule.id } }));
        expect((await remove()).status).toBe(409);
        expect((await getRules("account-1", "dm"))).toHaveLength(1);
        (await getDb().prepare("UPDATE automation_runs SET status = 'sent'").run());
        expect((await remove()).status).toBe(200);
        expect((await getRules("account-1", "dm"))).toHaveLength(0);
        expect((await getRuns("account-1", "dm"))).toHaveLength(0);
    });
    it("saves several rules on one post and sends each rule's own comment, DM, or both", async () => {
        for (const id of ["post-1", "post-2"]) {
            (await getDb().prepare("INSERT INTO instagram_media VALUES(?,?,?,?,?)").run("account-1", id, "post", JSON.stringify({ id, channel: "post", timestamp: new Date().toISOString() }), Date.now()));
        }
        const inputs = [
            { ...defaultRule, channel: "post", mediaId: "post-1", name: "Public pricing", keywords: ["price"], publicReply: "Prices start at $25.", dmReply: "" },
            { ...defaultRule, channel: "post", mediaId: "post-1", name: "Private guide", keywords: ["guide"], publicReply: "", dmReply: "Here is your guide." },
            { ...defaultRule, channel: "post", mediaId: "post-1", name: "Stock details", keywords: ["stock"], publicReply: "Check your inbox!", dmReply: "Here is what is in stock." },
        ];
        for (const input of inputs)
            expect((await save(input)).status).toBe(201);
        const otherPost = (await saveRule({ ...defaultRule, channel: "post", mediaId: "post-2", name: "Another post", matchAll: true }));
        const rules = (await getRules("account-1", "post")).filter((rule) => rule.mediaId === "post-1");
        expect(rules).toMatchObject(inputs);
        expect(new Set(rules.map((rule) => rule.id)).size).toBe(3);
        (await moveRule("account-1", rules[2].id, -1));
        (await moveRule("account-1", rules[2].id, -1));
        expect((await getRules("account-1", "post")).find((rule) => rule.id === otherPost.id)).toEqual(otherPost);
        let result = 0;
        const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
            if (String(url).endsWith("/replies"))
                return Response.json({ id: `public-${++result}` });
            if (String(url).endsWith("/messages"))
                return Response.json({ message_id: `dm-${++result}` });
            throw new Error("Unexpected request");
        });
        await processWebhook(comment("post-1", "unmatched", { text: "hello" }));
        expect((await getRuns("account-1", "post"))).toHaveLength(0);
        // Overlapping keywords use the first matching rule, without sending both rules.
        await processWebhook(comment("post-1", "pricing-comment", { text: "price and guide please" }));
        await processWebhook(comment("post-1", "guide-comment", { text: "GUIDE please" }));
        const stock = comment("post-1", "stock-comment", { text: "stock and price" });
        await processWebhook(stock);
        await processWebhook(stock);
        await dispatchAutomations();
        await processWebhook(comment("post-1", "stock-again", { text: "stock" }));
        await dispatchAutomations();
        expect(fetch).toHaveBeenCalledTimes(4);
        const sent = fetch.mock.calls.map(([url, init]) => ({ path: new URL(String(url)).pathname, body: JSON.parse(init?.body as string) }));
        expect(sent).toEqual(expect.arrayContaining([
            { path: expect.stringMatching(/\/pricing-comment\/replies$/), body: { message: inputs[0].publicReply } },
            { path: expect.stringMatching(/\/messages$/), body: expect.objectContaining({ recipient: { comment_id: "guide-comment" }, message: { text: inputs[1].dmReply } }) },
            { path: expect.stringMatching(/\/stock-comment\/replies$/), body: { message: inputs[2].publicReply } },
            { path: expect.stringMatching(/\/messages$/), body: expect.objectContaining({ recipient: { comment_id: "stock-comment" }, message: { text: inputs[2].dmReply } }) },
        ]));
        const activity = (await getRuns("account-1", "post"));
        expect(activity.every((run) => run.status === "sent")).toBe(true);
        expect(rules.map((rule) => activity.filter((run) => run.ruleId === rule.id).length)).toEqual([1, 1, 2]);
        expect(activity.some((run) => run.ruleId === otherPost.id)).toBe(false);
    });
    it("keeps recent activity for each rule even when a sibling has many more runs", async () => {
        const first = (await saveRule(defaultRule));
        const busy = (await saveRule({ ...defaultRule, name: "Busy rule" }));
        await processWebhook(instagramMessage("original", Date.now(), "price"));
        const db = getDb();
        const time = Date.now();
        for (let i = 0; i < 35; i++) {
            (await db.prepare(`INSERT INTO automation_runs(id,rule_id,revision,event_key,customer_id,conversation_id,action,reply_text,created_at,updated_at)
        SELECT ?,?,?,?,customer_id,conversation_id,action,'Newer reply',?,? FROM automation_runs WHERE rule_id = ? LIMIT 1`)
                .run(`busy-${i}`, busy.id, busy.revision, `busy-event-${i}`, time + i, time + i, first.id));
        }
        const activity = (await getRuns("account-1", "dm"));
        expect(activity.filter((run) => run.ruleId === first.id)).toHaveLength(1);
        expect(activity.filter((run) => run.ruleId === busy.id)).toHaveLength(8);
        expect(activity[0].id).toBe("busy-34");
    });
    it("finds later keyword matches, uses the first matching rule, and never falls through a cooldown", async () => {
        const price = (await saveRule(defaultRule));
        const hours = (await saveRule({ ...defaultRule, name: "Hours", keywords: ["hours"], dmReply: "Open at nine" }));
        const fallback = (await saveRule({ ...defaultRule, name: "Fallback", matchAll: true, keywords: [], dmReply: "Thanks!" }));
        await processWebhook(instagramMessage("hours", Date.now(), "What are your hours?"));
        await processWebhook(instagramMessage("overlap", Date.now(), "price and hours"));
        await processWebhook(instagramMessage("cooldown", Date.now(), "price"));
        expect((await getRuns("account-1", "dm")).map((run) => run.ruleId).sort()).toEqual([price.id, hours.id].sort());
        expect((await getRuns("account-1", "dm")).some((run) => run.ruleId === fallback.id)).toBe(false);
        const other = instagramMessage("fallback", Date.now(), "hello");
        other.entry[0].messaging[0].sender.id = "other-customer";
        await processWebhook(other);
        expect((await getRuns("account-1", "dm"))[0]).toMatchObject({ ruleId: fallback.id, replyText: "Thanks!" });
    });
    it.each(["dm", "post", "story"] as const)("applies ordering and disabled-rule filtering to %s", async (channel) => {
        const context = { ...defaultRule, channel, mediaId: channel === "dm" ? "" : `${channel}-1` };
        const first = (await saveRule(context));
        const second = (await saveRule({ ...context, name: "Second match", dmReply: "Second response" }));
        (await moveRule("account-1", second.id, -1));
        const send = async (id: string, customer: string) => {
            if (channel === "post")
                return processWebhook(comment("post-1", id, { from: { id: customer } }));
            const event = instagramMessage(id, Date.now(), "price");
            event.entry[0].messaging[0].sender.id = customer;
            if (channel === "story")
                Object.assign(event.entry[0].messaging[0].message, { reply_to: { story: { id: "story-1" } } });
            return processWebhook(webhookEventSchema.parse(event));
        };
        await send("ordered", "customer-a");
        expect((await getRuns("account-1", channel))).toMatchObject([{ ruleId: second.id }]);
        (await updateRule(second.id, { ...context, enabled: false }));
        await send("paused", "customer-b");
        expect((await getRuns("account-1", channel))[0].ruleId).toBe(first.id);
    });
    it("matches keywords, persists a DM once, and limits repeated replies to the same person", async () => {
        (await saveRule(defaultRule));
        const fetch = mockSends();
        await processWebhook(instagramMessage("miss", Date.now(), "Hello"));
        expect((await getRuns("account-1", "dm"))).toHaveLength(0);
        const event = instagramMessage("match", Date.now(), "What is the PRICE?");
        await processWebhook(event);
        await processWebhook(event);
        await Promise.all([dispatchAutomations(), dispatchAutomations()]);
        await processWebhook(instagramMessage("another", Date.now(), "price"));
        await dispatchAutomations();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(JSON.parse(fetch.mock.calls[0][1]?.body as string)).toMatchObject({ recipient: { id: "customer-1" }, message: { text: defaultRule.dmReply } });
        expect((await getRuns("account-1", "dm"))).toMatchObject([{ status: "sent" }]);
        const conversation = (await getConversationByPsid("account-1", "customer-1"))!;
        expect((await getMessages(conversation.id)).filter((message) => message.direction === "outbound")).toHaveLength(1);
    });
    it("routes story replies only to their selected story, including id-only context", async () => {
        (await saveRule(defaultRule));
        (await saveRule({ ...defaultRule, channel: "story", mediaId: "story-1" }));
        for (const [mid, id] of [["wrong", "story-2"], ["right", "story-1"], ["missing", undefined]]) {
            const event = instagramMessage(mid, Date.now(), "price");
            Object.assign(event.entry[0].messaging[0].message, { reply_to: { story: { ...(id ? { id } : {}), url: "https://example.test/story.jpg" } } });
            await processWebhook(webhookEventSchema.parse(event));
        }
        expect((await getRuns("account-1", "dm"))).toHaveLength(0);
        expect((await getRuns("account-1", "story"))).toHaveLength(1);
        mockSends();
        await dispatchAutomations();
        expect((await getRuns("account-1", "story"))[0].status).toBe("sent");
    });
    it.each(["public", "dm", "both"])("sends %s for top-level comments on only the selected post", async (mode) => {
        (await saveRule({ ...defaultRule, channel: "post", mediaId: "post-1", dmReply: mode === "public" ? "" : "Details in private", publicReply: mode === "dm" ? "" : "Thanks for commenting" }));
        const fetch = mockSends();
        await processWebhook(comment("post-2", "wrong-post"));
        await processWebhook(comment("post-1", "thread-reply", { parent_id: "parent" }));
        await processWebhook(comment("post-1", "own-comment", { from: { id: "200" } }));
        expect((await getRuns("account-1", "post"))).toHaveLength(0);
        await processWebhook(comment());
        await processWebhook(comment());
        await dispatchAutomations();
        expect(fetch).toHaveBeenCalledTimes(mode === "both" ? 2 : 1);
        if (mode !== "dm")
            expect(fetch.mock.calls.some(([url, init]) => String(url).endsWith("/comment-1/replies") && JSON.parse(init?.body as string).message === "Thanks for commenting")).toBe(true);
        if (mode !== "public")
            expect(fetch.mock.calls.some(([url, init]) => String(url).endsWith("/messages") && JSON.parse(init?.body as string).recipient.comment_id === "comment-1")).toBe(true);
        expect((await getRuns("account-1", "post")).every((run) => run.status === "sent")).toBe(true);
    });
    it("ignores echoes, unsupported messages, paused rules, and events before activation", async () => {
        const rule = (await saveRule(defaultRule));
        const echo = instagramMessage("echo", Date.now(), "price");
        Object.assign(echo.entry[0].messaging[0].message, { is_echo: true });
        const unsupported = instagramMessage("unsupported", Date.now(), "price");
        Object.assign(unsupported.entry[0].messaging[0].message, { is_unsupported: true });
        for (const event of [echo, unsupported, instagramMessage("old", Date.now() - 5000, "price")])
            await processWebhook(event);
        (await updateRule(rule.id, { ...defaultRule, enabled: false }));
        await processWebhook(instagramMessage("paused", Date.now(), "price"));
        expect((await getRuns("account-1", "dm"))).toHaveLength(0);
    });
    it("cancels queued work when a rule changes and does not retry uncertain sends", async () => {
        const rule = (await saveRule(defaultRule));
        await processWebhook(instagramMessage("first", Date.now(), "price"));
        (await updateRule(rule.id, { ...defaultRule, enabled: false }));
        const fetch = mockSends();
        await dispatchAutomations();
        expect(fetch).not.toHaveBeenCalled();
        expect((await getRuns("account-1", "dm"))[0].status).toBe("skipped");
        (await updateRule(rule.id, defaultRule));
        const event = instagramMessage("second", Date.now(), "price");
        event.entry[0].messaging[0].sender.id = "other-customer";
        await processWebhook(event);
        fetch.mockRejectedValue(new Error("Response lost"));
        await dispatchAutomations();
        await processWebhook(event);
        await dispatchAutomations();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect((await getRuns("account-1", "dm")).some((run) => run.status === "failed")).toBe(true);
    });
    it("queues atomically with webhook receipts and recovers pending work on workspace use", async () => {
        (await saveRule(defaultRule));
        const db = getDb();
        const prepare = db.prepare.bind(db);
        const failedWrite = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
            const statement = prepare(sql);
            return sql.startsWith("INSERT OR IGNORE INTO automation_runs")
                ? { ...statement, run: async () => { throw new Error("test queue write failure"); } }
                : statement;
        });
        const event = instagramMessage("atomic", Date.now(), "price");
        await expect(processWebhook(event)).rejects.toThrow();
        expect((await getDb().prepare("SELECT count(*) n FROM webhook_receipts").get())).toEqual({ n: 0 });
        failedWrite.mockRestore();
        await processWebhook(event);
        expect((await getRuns("account-1", "dm"))[0].status).toBe("queued");
        await GET(request("/api/automations?account_id=account-1&channel=dm", { cookie }));
        expect(after).toHaveBeenCalledWith(dispatchAutomations);
        mockSends();
        await dispatchAutomations();
        expect((await getRuns("account-1", "dm"))[0].status).toBe("sent");
    });
});

it("allocates distinct positions for simultaneous rule creation", async () => {
    const rules = await Promise.all([
        saveRule({ ...defaultRule, name: "First" }),
        saveRule({ ...defaultRule, name: "Second" }),
    ]);
    expect(new Set(rules.map((rule) => rule.id)).size).toBe(2);
    expect(rules.map((rule) => rule.position).sort()).toEqual([0, 1]);
});

it("keeps the cooldown atomic across simultaneous webhook deliveries", async () => {
    await saveRule(defaultRule);
    await Promise.all([
        processWebhook(instagramMessage("parallel-one", Date.now(), "price")),
        processWebhook(instagramMessage("parallel-two", Date.now(), "price")),
    ]);
    expect(await getRuns("account-1", "dm")).toHaveLength(1);
});

it("serializes queued replies for a conversation across independent dispatchers", async () => {
    await saveRule(defaultRule);
    await saveRule({ ...defaultRule, name: "Hours", keywords: ["hours"], dmReply: "Open at nine" });
    await processWebhook(instagramMessage("price-job", Date.now(), "price"));
    await processWebhook(instagramMessage("hours-job", Date.now(), "hours"));
    let release!: () => void;
    const firstRequest = new Promise<void>((resolve) => { release = resolve; });
    let count = 0;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        count++;
        const messageId = `parallel-send-${count}`;
        if (count === 1) await firstRequest;
        return Response.json({ message_id: messageId });
    });
    const dispatchers = [dispatchAutomations(), dispatchAutomations()];
    try {
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
        expect((await getRuns("account-1", "dm")).map((run) => run.status).sort()).toEqual(["queued", "sending"]);
    } finally {
        release();
        await Promise.all(dispatchers);
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await getRuns("account-1", "dm")).every((run) => run.status === "sent")).toBe(true);
});
