import { z } from "zod";
import { getDb } from "@/lib/db";
import { getAccountAccessToken, getAccountById } from "@/lib/instagram";
import { graphRequest } from "./client";
import type { InstagramMedia } from "@/lib/automations/schema";

const mediaSchema = z.object({
  id: z.string().min(1), caption: z.string().optional(), media_type: z.string(),
  media_url: z.string().optional(), thumbnail_url: z.string().optional(),
  permalink: z.string().optional(), timestamp: z.string(),
});
const pageSchema = z.object({ data: z.array(mediaSchema), paging: z.object({ cursors: z.object({ after: z.string().optional() }).optional(), next: z.string().optional() }).optional() });
function httpsUrl(value?: string): string | null {
  try { return value && new URL(value).protocol === "https:" ? value : null; } catch { return null; }
}

export async function listInstagramMedia(accountId: string, channel: "post" | "story", after?: string) {
  const account = await getAccountById(accountId);
  if (!account?.isActive) throw new Error("Account is not connected.");
  const data = await graphRequest(`${encodeURIComponent(account.instagramAccountId)}/${channel === "post" ? "media" : "stories"}`,
    await getAccountAccessToken(accountId), pageSchema, { query: {
      fields: "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp", limit: "24", ...(after ? { after } : {}),
    } });
  const media: InstagramMedia[] = data.data.map((item) => ({
    id: item.id, channel, caption: item.caption ?? "", mediaType: item.media_type,
    imageUrl: httpsUrl(item.media_type === "VIDEO" ? item.thumbnail_url : item.media_url),
    permalink: httpsUrl(item.permalink), timestamp: item.timestamp,
  }));
  // Ownership comes from the authenticated account's media edge, never a client URL.
  const db = getDb();
  await db.transaction(async () => {
    const insert = db.prepare(`INSERT INTO instagram_media(account_id,id,channel,data,fetched_at) VALUES(?,?,?,?,?)
      ON CONFLICT(account_id,id) DO UPDATE SET channel=excluded.channel,data=excluded.data,fetched_at=excluded.fetched_at`);
    for (const item of media) await insert.run(accountId, item.id, channel, JSON.stringify(item), Date.now());
  })();
  return { media, nextCursor: data.paging?.next ? data.paging.cursors?.after ?? null : null };
}

export async function getSavedMedia(accountId: string, id: string): Promise<InstagramMedia | undefined> {
  const row = await getDb().prepare("SELECT data FROM instagram_media WHERE account_id = ? AND id = ?").get(accountId, id) as { data: string } | undefined;
  return row ? JSON.parse(row.data) : undefined;
}
