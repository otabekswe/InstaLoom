import { getDb } from "@/lib/db";
import { getAccountById, getAccountAccessToken, getConversationById, getCustomerProfile } from "@/lib/instagram";
import type { Conversation } from "@/types";

const RETRY_INTERVAL_MS = 60 * 60 * 1000;

export function needsCustomerProfile(conversation: Pick<Conversation, "customerName">): boolean {
  const name = conversation.customerName?.trim().toLowerCase();
  return !name || name === "instagram user";
}

async function claimProfileAttempt(conversationId: string): Promise<boolean> {
  const db = getDb();
  const now = Date.now();
  return (await db.prepare(`INSERT INTO customer_profile_attempts (conversation_id, attempted_at) VALUES (?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET attempted_at = excluded.attempted_at
    WHERE customer_profile_attempts.attempted_at <= ?`
  ).run(conversationId, now, now - RETRY_INTERVAL_MS)).changes === 1;
}

function profileImageUrl(value?: string): string | null {
  if (!value || value.length > 4096) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** Optional enrichment, run by after() so Meta availability never delays the inbox response. */
export async function enrichCustomerProfile(conversationId: string, userId: string): Promise<void> {
  try {
    const conversation = await getConversationById(conversationId);
    if (!conversation || !needsCustomerProfile(conversation)) return;
    const account = await getAccountById(conversation.instagramAccountId);
    if (!account?.isActive || account.userId !== userId || !(await claimProfileAttempt(conversationId))) return;

    // The existing Graph helper has an eight-second timeout and sanitizes upstream failures.
    const profile = await getCustomerProfile(await getAccountAccessToken(account.id), conversation.customerPsid);
    if (!profile) return;
    const trimmedName = profile.name?.trim();
    const name = trimmedName && trimmedName.toLowerCase() !== "instagram user" ? trimmedName.slice(0, 200) : null;
    const image = profileImageUrl(profile.profilePic);
    if (!name && !image) return;

    // Preserve a name learned from a newer event while this request was in flight.
    await getDb().prepare(`UPDATE conversations SET
      customer_name = CASE WHEN customer_name IS NULL OR trim(customer_name) = '' OR lower(trim(customer_name)) = 'instagram user'
        THEN COALESCE(?, customer_name) ELSE customer_name END,
      customer_profile_pic = COALESCE(NULLIF(customer_profile_pic, ''), ?),
      updated_at = datetime('now')
      WHERE id = ? AND instagram_account_id = ?
        AND EXISTS (SELECT 1 FROM instagram_accounts WHERE id = ? AND user_id = ? AND is_active = 1)`
    ).run(name, image, conversationId, account.id, account.id, userId);
  } catch {
    // Profiles are optional. Keep tokens and upstream response data out of logs.
  }
}
