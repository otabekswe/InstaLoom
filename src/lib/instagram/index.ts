import { z } from "zod";
import { getDb, all, first, run } from "@/lib/db";
import { getOwnerInstagramId } from "@/lib/config";
import { mapAccount, mapConversation, mapMessage, type AccountRow, type ConversationRow, type MessageRow } from "@/lib/db/mappers";
import type { InstagramAccount, PublicInstagramAccount, Conversation, Message, MessageDirection, MessageType } from "@/types";

import { graphRequest } from "./client";
import { refreshInstagramToken } from "./oauth";
export { getGraphApiVersion } from "./client";

export function toPublicAccount(account: InstagramAccount): PublicInstagramAccount {
  return {
    id: account.id, userId: account.userId, instagramAccountId: account.instagramAccountId,
    displayName: account.displayName, instagramUsername: account.instagramUsername,
    instagramProfilePic: account.instagramProfilePic, isActive: account.isActive,
    tokenExpiresAt: account.tokenExpiresAt,
    needsReconnect: !account.accessToken || !account.tokenExpiresAt || account.tokenExpiresAt <= Date.now(),
    connectedAt: account.connectedAt, updatedAt: account.updatedAt,
  };
}

export async function linkInstagramAccount(params: {
  userId: string; instagramAccountId: string; accessToken: string; expiresIn: number;
  displayName: string; username: string; profilePic?: string; claimLegacyAccount?: boolean;
}): Promise<InstagramAccount> {
  requireOwnerAccount(params.instagramAccountId);
  return getDb().transaction(async () => {
    let existing = await first<AccountRow>(
      "SELECT * FROM instagram_accounts WHERE user_id = ? AND instagram_account_id = ?",
      params.userId, params.instagramAccountId,
    );
    // Only a verified Instagram OAuth callback can reclaim the matching legacy
    // account. Unrelated accounts in the previous workspace keep their ownership.
    if (!existing && params.claimLegacyAccount) {
      existing = await first<AccountRow>(
        "SELECT * FROM instagram_accounts WHERE instagram_account_id = ? AND token_expires_at IS NULL AND access_token = '' ORDER BY connected_at LIMIT 1",
        params.instagramAccountId,
      );
      if (existing) {
        await run("UPDATE conversations SET assigned_to = NULL WHERE instagram_account_id = ?", existing.id);
      }
    }
    const id = existing?.id ?? crypto.randomUUID();
    const now = Date.now();
    if (existing) {
      await run(`UPDATE instagram_accounts SET user_id = ?, access_token = ?, instagram_username = ?,
        instagram_profile_pic = ?, display_name = ?, token_expires_at = ?, token_refreshed_at = ?,
        token_refresh_attempted_at = 0, is_active = 1, updated_at = datetime('now') WHERE id = ?`,
      params.userId, params.accessToken, params.username, params.profilePic ?? null, params.displayName,
      now + params.expiresIn * 1000, now, id);
    } else {
      await run(`INSERT INTO instagram_accounts (id, user_id, instagram_account_id, display_name,
        access_token, instagram_username, instagram_profile_pic, token_expires_at, token_refreshed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, params.userId, params.instagramAccountId, params.displayName, params.accessToken,
      params.username, params.profilePic ?? null, now + params.expiresIn * 1000, now);
    }
    return (await getAccountById(id))!;
  })();
}

export async function getAccountsByUser(userId: string): Promise<InstagramAccount[]> {
  return (await all<AccountRow>("SELECT * FROM instagram_accounts WHERE user_id = ? AND instagram_account_id = ? ORDER BY connected_at DESC, id DESC", userId, getOwnerInstagramId())).map(mapAccount);
}

export async function getAccountById(accountId: string): Promise<InstagramAccount | undefined> {
  const row = await first<AccountRow>("SELECT * FROM instagram_accounts WHERE id = ? AND instagram_account_id = ?", accountId, getOwnerInstagramId());
  return row ? mapAccount(row) : undefined;
}

export async function getAccountsForWebhook(entryId: string): Promise<InstagramAccount[]> {
  if (entryId !== getOwnerInstagramId()) return [];
  return (await all<AccountRow>("SELECT * FROM instagram_accounts WHERE instagram_account_id = ? AND is_active = 1 AND access_token != ''", entryId)).map(mapAccount);
}

export async function disconnectAccount(accountId: string, userId: string): Promise<boolean> {
  return (await run("UPDATE instagram_accounts SET is_active = 0, access_token = '', updated_at = datetime('now') WHERE id = ? AND user_id = ? AND instagram_account_id = ?", accountId, userId, getOwnerInstagramId())).changes > 0;
}

const refreshing = new Map<string, Promise<string>>();
const DAY_MS = 86400_000;

/** Refresh active accounts during use, before the 60-day token expires. */
export async function getAccountAccessToken(accountId: string): Promise<string> {
  const pending = refreshing.get(accountId);
  if (pending) return pending;
  const operation = refreshAccountToken(accountId);
  refreshing.set(accountId, operation);
  try { return await operation; }
  finally { refreshing.delete(accountId); }
}

async function refreshAccountToken(accountId: string): Promise<string> {
  const account = await getAccountById(accountId);
  const now = Date.now();
  if (!account?.isActive || account.instagramAccountId !== getOwnerInstagramId() || !account.accessToken || !account.tokenExpiresAt || account.tokenExpiresAt <= now) {
    throw new Error("Reconnect this Instagram account in Settings to continue.");
  }
  if (account.tokenExpiresAt - now <= 7 * DAY_MS && account.tokenRefreshedAt && now - account.tokenRefreshedAt >= DAY_MS) {
    // Coordinate concurrent requests/processes and back off for an hour on failure.
    const claimed = (await run(`UPDATE instagram_accounts SET token_refresh_attempted_at = ?
      WHERE id = ? AND access_token = ? AND is_active = 1 AND token_refresh_attempted_at <= ?`,
    now, accountId, account.accessToken, now - 3600_000)).changes;
    if (claimed) {
      try {
        const token = await refreshInstagramToken(account.accessToken);
        await run(`UPDATE instagram_accounts SET access_token = ?, token_expires_at = ?, token_refreshed_at = ?, updated_at = datetime('now')
          WHERE id = ? AND access_token = ? AND is_active = 1`,
        token.access_token, Date.now() + token.expires_in * 1000, Date.now(), accountId, account.accessToken);
      } catch { /* A transient refresh failure must not discard a still-valid token. */ }
    }
  }
  const latest = await getAccountById(accountId);
  if (!latest?.isActive || latest.instagramAccountId !== getOwnerInstagramId() || !latest.accessToken || !latest.tokenExpiresAt || latest.tokenExpiresAt <= Date.now()) {
    throw new Error("Reconnect this Instagram account in Settings to continue.");
  }
  return latest.accessToken;
}

export async function getConversations(instagramAccountId: string, options?: {
  folder?: string; status?: string; search?: string; limit?: number; offset?: number;
}): Promise<Conversation[]> {
  let sql = "SELECT * FROM conversations WHERE instagram_account_id = ?";
  const params: unknown[] = [instagramAccountId];
  if (options?.folder) { sql += " AND folder = ?"; params.push(options.folder); }
  if (options?.status) { sql += " AND status = ?"; params.push(options.status); }
  if (options?.search) {
    const search = `%${options.search.slice(0, 200).replace(/[\\%_]/g, "\\$&")}%`;
    sql += " AND (lower(customer_name) LIKE lower(?) ESCAPE '\\' OR lower(customer_psid) LIKE lower(?) ESCAPE '\\' OR lower(last_message_text) LIKE lower(?) ESCAPE '\\')";
    params.push(search, search, search);
  }
  sql += " ORDER BY julianday(last_message_at) DESC NULLS LAST, id DESC LIMIT ? OFFSET ?";
  params.push(Math.max(1, Math.min(options?.limit ?? 50, 101)), Math.max(0, options?.offset ?? 0));
  return (await all<ConversationRow>(sql, ...params)).map(mapConversation);
}

export async function getConversationById(conversationId: string): Promise<Conversation | undefined> {
  const row = await first<ConversationRow>("SELECT * FROM conversations WHERE id = ?", conversationId);
  return row ? mapConversation(row) : undefined;
}

export async function getConversationByPsid(instagramAccountId: string, customerPsid: string): Promise<Conversation | undefined> {
  const row = await first<ConversationRow>("SELECT * FROM conversations WHERE instagram_account_id = ? AND customer_psid = ?", instagramAccountId, customerPsid);
  return row ? mapConversation(row) : undefined;
}

export async function upsertConversation(params: {
  instagramAccountId: string; customerPsid: string; customerName?: string; customerProfilePic?: string; folder?: string;
}): Promise<Conversation> {
  await run(`INSERT INTO conversations (id, instagram_account_id, customer_psid, customer_name, customer_profile_pic, folder)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(instagram_account_id, customer_psid) DO UPDATE SET
      customer_name = COALESCE(excluded.customer_name, conversations.customer_name),
      customer_profile_pic = COALESCE(excluded.customer_profile_pic, conversations.customer_profile_pic)`,
  crypto.randomUUID(), params.instagramAccountId, params.customerPsid, params.customerName ?? null,
  params.customerProfilePic ?? null, params.folder ?? "general");
  return (await getConversationByPsid(params.instagramAccountId, params.customerPsid))!;
}

export async function updateConversation(conversationId: string, updates: Partial<Pick<Conversation, "folder" | "status" | "assignedTo" | "lastMessageText">>): Promise<void> {
  const sets = ["updated_at = datetime('now')"];
  const vals: unknown[] = [];
  if (updates.lastMessageText !== undefined) { sets.push("last_message_text = ?, last_message_at = ?"); vals.push(updates.lastMessageText, new Date().toISOString()); }
  if (updates.folder !== undefined) { sets.push("folder = ?"); vals.push(updates.folder); }
  if (updates.status !== undefined) { sets.push("status = ?"); vals.push(updates.status); }
  if (updates.assignedTo !== undefined) { sets.push("assigned_to = ?"); vals.push(updates.assignedTo); }
  await run(`UPDATE conversations SET ${sets.join(", ")} WHERE id = ?`, ...vals, conversationId);
}

export async function markConversationRead(conversationId: string): Promise<void> {
  await getDb().transaction(async () => {
    await run("UPDATE conversations SET is_unread = 0, updated_at = datetime('now') WHERE id = ?", conversationId);
    await run("UPDATE messages SET is_read = 1 WHERE conversation_id = ? AND direction = 'inbound'", conversationId);
  })();
}

// rowid breaks ties deterministically, including messages created within the same millisecond.
const MESSAGE_ORDER = "julianday(COALESCE(sent_at, created_at))";
export async function getMessages(conversationId: string, options?: { limit?: number; before?: string }): Promise<Message[]> {
  let sql = "SELECT * FROM messages WHERE conversation_id = ?";
  const params: unknown[] = [conversationId];
  if (options?.before) {
    sql += ` AND (${MESSAGE_ORDER}, rowid) < (SELECT ${MESSAGE_ORDER}, rowid FROM messages WHERE id = ? AND conversation_id = ?)`;
    params.push(options.before, conversationId);
  }
  sql += ` ORDER BY ${MESSAGE_ORDER} DESC, rowid DESC LIMIT ?`;
  params.push(Math.max(1, Math.min(options?.limit ?? 50, 101)));
  return (await all<MessageRow>(sql, ...params)).map(mapMessage);
}

export interface NewMessage {
  conversationId: string; mid?: string; direction: MessageDirection; messageType: MessageType;
  textContent?: string; attachmentUrl?: string; attachmentType?: string; storyReplyTo?: string;
  commentId?: string; sentAt?: string;
}

async function insertMessageResult(params: NewMessage): Promise<{ message: Message; inserted: boolean }> {
  const duplicate = params.mid
    ? await first<MessageRow>("SELECT * FROM messages WHERE conversation_id = ? AND mid = ?", params.conversationId, params.mid)
    : params.commentId && params.direction === "inbound"
      ? await first<MessageRow>("SELECT * FROM messages WHERE conversation_id = ? AND comment_id = ? AND direction = 'inbound'", params.conversationId, params.commentId)
      : undefined;
  if (duplicate) {
    // A Meta echo can arrive before the Send API response. Keep the comment link
    // when that response later reconciles with the already-persisted message.
    if (params.commentId && !duplicate.comment_id) {
      await run("UPDATE messages SET comment_id = ? WHERE id = ?", params.commentId, duplicate.id);
      duplicate.comment_id = params.commentId;
    }
    return { message: mapMessage(duplicate), inserted: false };
  }
  const id = crypto.randomUUID();
  await run(`INSERT INTO messages (id, conversation_id, mid, direction, message_type, text_content,
    attachment_url, attachment_type, story_reply_to, comment_id, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  id, params.conversationId, params.mid ?? null, params.direction, params.messageType,
  params.textContent ?? null, params.attachmentUrl ?? null, params.attachmentType ?? null,
  params.storyReplyTo ?? null, params.commentId ?? null, params.sentAt ?? new Date().toISOString());
  return { message: mapMessage((await first<MessageRow>("SELECT * FROM messages WHERE id = ?", id))!), inserted: true };
}

export async function insertMessage(params: NewMessage): Promise<Message> {
  return getDb().transaction(async () => (await insertMessageResult(params)).message)();
}

/** Persist the message and preview together; retries never reset unread state or move previews. */
export async function recordMessage(params: NewMessage, preview: string): Promise<Message> {
  return getDb().transaction(async () => {
    const { message, inserted } = await insertMessageResult(params);
    if (!inserted) return message;
    await run(`UPDATE conversations SET last_message_text = ?, last_message_at = ?, updated_at = datetime('now')
      WHERE id = ? AND (last_message_at IS NULL OR julianday(last_message_at) <= julianday(?))`,
    preview.slice(0, 200), message.sentAt, params.conversationId, message.sentAt);
    if (params.direction === "inbound") {
      await run("UPDATE conversations SET is_unread = 1 WHERE id = ?", params.conversationId);
    }
    return message;
  })();
}

export async function markMessageRead(messageId: string): Promise<void> {
  await run("UPDATE messages SET is_read = 1 WHERE id = ?", messageId);
}

/** Customer read receipts apply only to outbound messages, never the agent's unread inbox. */
export async function markOutboundMessagesRead(conversationId: string, receipt: { mid?: string; watermark?: number }): Promise<void> {
  if (receipt.mid) {
    await run(`UPDATE messages SET is_read = 1 WHERE conversation_id = ? AND direction = 'outbound'
      AND (${MESSAGE_ORDER}, rowid) <= (SELECT ${MESSAGE_ORDER}, rowid FROM messages WHERE conversation_id = ? AND mid = ? AND direction = 'outbound' LIMIT 1)`,
    conversationId, conversationId, receipt.mid);
  } else if (receipt.watermark !== undefined) {
    await run(`UPDATE messages SET is_read = 1 WHERE conversation_id = ? AND direction = 'outbound' AND ${MESSAGE_ORDER} <= julianday(?)`,
    conversationId, new Date(receipt.watermark).toISOString());
  }
}

const nonempty = z.string().min(1);
export async function getInstagramProfile(accessToken: string, instagramAccountId: string): Promise<{ username?: string; profilePic?: string }> {
  const data = await graphRequest(encodeURIComponent(instagramAccountId), accessToken,
    z.object({ username: z.string().optional(), profile_picture_url: z.string().optional() }),
    { query: { fields: "username,profile_picture_url" } });
  return { username: data.username, profilePic: data.profile_picture_url };
}

export async function getCustomerProfile(accessToken: string, psid: string): Promise<{ name: string; profilePic?: string } | null> {
  try {
    const data = await graphRequest(encodeURIComponent(psid), accessToken,
      z.object({ name: z.string().optional(), username: z.string().optional(), profile_pic: z.string().optional() }),
      { query: { fields: "name,username,profile_pic" } });
    return { name: data.name || data.username || "Instagram user", profilePic: data.profile_pic };
  } catch { return null; }
}

function requireOwnerAccount(instagramAccountId: string): void {
  if (instagramAccountId !== getOwnerInstagramId()) throw new Error("This Instagram account is not authorized for this workspace.");
}

const sentMessageSchema = z.object({ recipient_id: nonempty.optional(), message_id: nonempty });
type SendContent = { text?: string; attachmentUrl?: string; attachmentType?: string; replyToMid?: string };
function messageContent(params: SendContent): Record<string, unknown> {
  const message: Record<string, unknown> = {};
  if (params.text?.trim()) message.text = params.text;
  else if (params.attachmentUrl && params.attachmentType) {
    message.attachment = { type: params.attachmentType, payload: { url: params.attachmentUrl } };
  } else throw new Error("A message or attachment is required.");
  if (params.replyToMid) message.reply_to = { mid: params.replyToMid };
  return message;
}

export async function sendMessage(params: SendContent & {
  instagramAccountId: string; accessToken: string; recipientPsid: string;
}): Promise<{ recipientId: string; messageId: string }> {
  requireOwnerAccount(params.instagramAccountId);
  const data = await graphRequest(`${encodeURIComponent(params.instagramAccountId)}/messages`, params.accessToken, sentMessageSchema,
    { body: { recipient: { id: params.recipientPsid }, message: messageContent(params) } });
  return { recipientId: data.recipient_id ?? params.recipientPsid, messageId: data.message_id };
}

export async function sendPrivateReply(params: SendContent & {
  instagramAccountId: string; accessToken: string; commentId: string;
}): Promise<{ id: string; messageId: string; recipientId?: string }> {
  requireOwnerAccount(params.instagramAccountId);
  const data = await graphRequest(`${encodeURIComponent(params.instagramAccountId)}/messages`, params.accessToken, sentMessageSchema,
    { body: { recipient: { comment_id: params.commentId }, message: messageContent(params) } });
  return { id: data.message_id, messageId: data.message_id, recipientId: data.recipient_id };
}

export async function subscribeAccountWebhooks(params: { instagramAccountId: string; accessToken: string }): Promise<void> {
  requireOwnerAccount(params.instagramAccountId);
  // Subscribe this Instagram professional account directly after OAuth.
  await graphRequest(`${encodeURIComponent(params.instagramAccountId)}/subscribed_apps`, params.accessToken,
    z.object({ success: z.literal(true) }),
    { body: { subscribed_fields: "messages,messaging_postbacks,messaging_seen,comments" } });
}
