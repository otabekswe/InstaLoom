import crypto from "node:crypto";
import { enqueueAutomation } from "@/lib/automations/store";
import { z } from "zod";
import type { InstagramAccount, WebhookEvent, WebhookMessaging, WebhookChange, MessageType } from "@/types";
import { getDb, first, run } from "@/lib/db";
import { getOwnerInstagramId } from "@/lib/config";
import {
  upsertConversation, recordMessage, getConversationByPsid, getConversationById,
  getAccountById, getAccountAccessToken, getAccountsForWebhook, markOutboundMessagesRead,
  sendMessage as sendInstagramMessage, sendPrivateReply as sendInstagramPrivateReply,
} from "@/lib/instagram";

const id = z.string().min(1).max(512);
const text = z.string().max(20000);
const timestamp = z.number().int().nonnegative().max(8640000000000000);
const attachment = z.object({ type: z.string().min(1).max(128), payload: z.object({ url: z.string().max(8192).optional() }).default({}) });
const messagingSchema = z.object({
  sender: z.object({ id }), recipient: z.object({ id }), timestamp,
  message: z.object({ mid: id, text: text.optional(), attachments: z.array(attachment).max(20).optional(),
    reply_to: z.object({ mid: id.optional(), story: z.object({ id: id.optional(), url: z.string().max(8192).optional() }).optional() }).optional(),
    is_unsupported: z.boolean().optional(), is_deleted: z.boolean().optional(), is_echo: z.boolean().optional(),
  }).optional(),
  postback: z.object({ mid: id.optional(), title: text.optional(), payload: text }).optional(),
  read: z.object({ mid: id.optional(), watermark: timestamp.optional() }).optional(),
});
const changeSchema = z.object({ field: z.string().max(128), value: z.object({
  id: id.optional(), from: z.object({ id, name: z.string().max(512).optional(), username: z.string().max(512).optional() }).optional(),
  comment_id: id.optional(), parent_id: id.optional(), post_id: id.optional(), post: z.object({ id }).optional(),
  media: z.object({ id, media_product_type: z.string().max(128).optional() }).optional(),
  created_time: z.union([timestamp, z.string().max(64)]).optional(), text: text.optional(), message: text.optional(),
  verb: z.string().max(128).optional(), item: z.string().max(128).optional(),
}) });

/** Keep signed batches small enough to commit before Meta's delivery timeout. */
export const webhookEventSchema = z.object({
  object: z.literal("instagram"),
  entry: z.array(z.object({ id, time: timestamp, messaging: z.array(messagingSchema).max(100).optional(), changes: z.array(changeSchema).max(100).optional() })).max(50),
}).refine((event) => event.entry.reduce((total, entry) => total + (entry.messaging?.length ?? 0) + (entry.changes?.length ?? 0), 0) <= 500, "Webhook batch is too large");

export function verifySignature(payload: string | Uint8Array, signature: string, appSecret: string): boolean {
  if (!appSecret || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(payload).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}

export function handleVerification(mode: string, verifyToken: string, challenge: string, expectedToken: string): { status: number; body: string } {
  if (!expectedToken) return { status: 503, body: "Webhook verification is not configured" };
  if (mode === "subscribe" && verifyToken === expectedToken && challenge) return { status: 200, body: challenge };
  return { status: 403, body: "Forbidden" };
}

/** Every event and its receipt commit in one transaction; failures stay retryable. */
export async function processWebhook(event: WebhookEvent): Promise<void> {
  const deadline = Date.now() + 4000;
  for (const entry of event.entry) {
    for (const account of await getAccountsForWebhook(entry.id)) {
      for (const message of entry.messaging ?? []) {
        if (Date.now() > deadline) throw new Error("Webhook processing deadline exceeded");
        const eventKey = message.message ? `message:${message.message.mid}`
          : message.postback?.mid ? `postback:${message.postback.mid}`
          : `event:${crypto.createHash("sha256").update(JSON.stringify(message)).digest("hex")}`;
        await processOnce(account.id, eventKey, () => processMessagingEvent(account, message));
      }
      for (const change of entry.changes ?? []) {
        if (Date.now() > deadline) throw new Error("Webhook processing deadline exceeded");
        const commentId = change.value.id ?? change.value.comment_id;
        if (!commentId) continue;
        await processOnce(account.id, `comment:${commentId}`, () => processChangeEvent(account, change, entry.time));
      }
    }
  }
}

async function processOnce(accountId: string, eventKey: string, process: () => Promise<void>): Promise<void> {
  await getDb().transaction(async () => {
    const receipt = await run("INSERT OR IGNORE INTO webhook_receipts (account_id, event_key) VALUES (?, ?)", accountId, eventKey);
    if (receipt.changes === 0) return;
    await process();
  })();
}

async function processMessagingEvent(account: InstagramAccount, event: WebhookMessaging): Promise<void> {
  const isAccountSender = event.sender.id === account.instagramAccountId;
  const outbound = event.message?.is_echo === true || isAccountSender;
  const customerPsid = outbound ? event.recipient.id : event.sender.id;
  if (customerPsid === account.instagramAccountId) return;
  if (event.read) {
    const conversation = await getConversationByPsid(account.id, customerPsid);
    if (conversation) await markOutboundMessagesRead(conversation.id, event.read);
    return;
  }
  if (event.message?.is_deleted || (!event.message && !event.postback)) return;
  const conversation = await upsertConversation({ instagramAccountId: account.id, customerPsid });
  const sentAt = new Date(event.timestamp).toISOString();
  if (event.message) {
    const message = event.message;
    const attachment = message.attachments?.[0];
    const messageType: MessageType = message.is_unsupported ? "unsupported"
      : message.reply_to?.story ? "story_reply"
      : attachment ? mapAttachmentToMessageType(attachment.type) : "text";
    await recordMessage({
      conversationId: conversation.id, mid: message.mid, direction: outbound ? "outbound" : "inbound",
      messageType, textContent: message.text, attachmentUrl: attachment?.payload.url,
      attachmentType: attachment?.type, storyReplyTo: message.reply_to?.story?.url, sentAt,
    }, message.text || `[${attachment?.type ?? messageType}]`);
    if (!outbound && messageType !== "unsupported" && (!message.reply_to?.story || message.reply_to.story.id)) {
      await enqueueAutomation({ accountId: account.id, channel: message.reply_to?.story ? "story" : "dm",
        mediaId: message.reply_to?.story?.id, text: message.text ?? "", eventKey: `message:${message.mid}`,
        customerId: customerPsid, conversationId: conversation.id, timestamp: event.timestamp });
    }
  }
  if (event.postback) {
    await recordMessage({ conversationId: conversation.id, mid: event.postback.mid,
      direction: outbound ? "outbound" : "inbound", messageType: "postback",
      textContent: event.postback.title || event.postback.payload, sentAt,
    }, event.postback.title || event.postback.payload);
  }
}

function sourceTime(value: number | string | undefined, fallback: number): string {
  const candidate = typeof value === "string" && !/^\d+$/.test(value) ? Date.parse(value) : Number(value ?? fallback);
  const milliseconds = candidate < 100000000000 ? candidate * 1000 : candidate;
  return new Date(Number.isFinite(milliseconds) && Math.abs(milliseconds) <= 8640000000000000 ? milliseconds : Date.now()).toISOString();
}

async function processChangeEvent(account: InstagramAccount, change: WebhookChange, entryTime: number): Promise<void> {
  const value = change.value;
  if (change.field !== "comments" && change.field !== "live_comments") return;
  if (value.verb && value.verb !== "add") return;
  const commentId = value.id ?? value.comment_id;
  const from = value.from;
  if (!commentId || !from || from.id === account.instagramAccountId) return;
  const conversation = await upsertConversation({ instagramAccountId: account.id, customerPsid: from.id, customerName: from.username ?? from.name });
  const commentText = value.text ?? value.message ?? "[Comment]";
  await recordMessage({ conversationId: conversation.id, direction: "inbound", messageType: "comment_reply",
    textContent: commentText, commentId, sentAt: sourceTime(value.created_time, entryTime),
  }, `Comment: ${commentText}`);
  const mediaId = value.media?.id ?? value.post_id ?? value.post?.id;
  if (change.field === "comments" && mediaId && !value.parent_id) {
    await enqueueAutomation({ accountId: account.id, channel: "post", mediaId, text: commentText,
      eventKey: `comment:${commentId}`, customerId: from.id, conversationId: conversation.id, commentId,
      timestamp: Date.parse(sourceTime(value.created_time, entryTime)) });
  }
}

export class ReplyEligibilityError extends Error {
  constructor(message: string, public readonly status: number = 409) {
    super(message);
    this.name = "ReplyEligibilityError";
  }
}

const REPLY_LEASE_MS = 120_000;

type AgentReply = {
  accountId: string; conversationId: string; text?: string; attachmentUrl?: string;
  attachmentType?: string; replyToMid?: string; commentId?: string;
};

export async function sendAgentReply(params: AgentReply): Promise<{ messageId: string }> {
  const claimedAt = Date.now();
  // The lease is shared by serverless instances; provider requests run outside
  // transactions so an in-flight reply never holds the database write lock.
  const claim = await run(`INSERT INTO outbound_send_claims (conversation_id, claimed_at) VALUES (?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET claimed_at = excluded.claimed_at
    WHERE outbound_send_claims.claimed_at <= ?`, params.conversationId, claimedAt, claimedAt - REPLY_LEASE_MS);
  if (!claim.changes) throw new ReplyEligibilityError("A reply is already being sent. Please wait.");
  try { return await sendAgentReplyOnce(params); }
  finally {
    try {
      await run("DELETE FROM outbound_send_claims WHERE conversation_id = ? AND claimed_at = ?", params.conversationId, claimedAt);
    } catch {
      // Expiry recovers failed cleanup without turning a confirmed send into a retry.
    }
  }
}

async function sendAgentReplyOnce(params: {
  accountId: string; conversationId: string; text?: string; attachmentUrl?: string;
  attachmentType?: string; replyToMid?: string; commentId?: string;
}): Promise<{ messageId: string }> {
  const conversation = await getConversationById(params.conversationId);
  if (!conversation || conversation.instagramAccountId !== params.accountId) throw new Error("Conversation not found");
  const account = await getAccountById(params.accountId);
  if (!account?.isActive || account.instagramAccountId !== getOwnerInstagramId()) throw new Error("Account not found or inactive");
  if (!account.tokenExpiresAt || account.tokenExpiresAt <= Date.now() || !account.accessToken) {
    throw new ReplyEligibilityError("Reconnect this Instagram account in Settings to send replies.");
  }
  const hasInboundMessage = await first("SELECT id FROM messages WHERE conversation_id = ? AND direction = 'inbound' AND message_type != 'comment_reply' LIMIT 1", conversation.id);
  let commentId = params.commentId;
  if (!commentId && !hasInboundMessage) {
    commentId = (await first<{ comment_id: string }>(`SELECT comment_id FROM messages WHERE conversation_id = ? AND direction = 'inbound'
      AND comment_id IS NOT NULL ORDER BY julianday(COALESCE(sent_at, created_at)) DESC, rowid DESC LIMIT 1`, conversation.id))?.comment_id;
    if (!commentId) throw new ReplyEligibilityError("Wait for a customer message before sending a reply.");
  }
  if (commentId) {
    const comment = await first("SELECT id FROM messages WHERE conversation_id = ? AND comment_id = ? AND direction = 'inbound'", conversation.id, commentId);
    if (!comment) throw new ReplyEligibilityError("Comment not found in this conversation", 400);
    const replied = await first("SELECT id FROM messages WHERE conversation_id = ? AND comment_id = ? AND direction = 'outbound'", conversation.id, commentId);
    if (replied) throw new ReplyEligibilityError("This comment already has a private reply. Wait for the customer to respond.");
  }
  const content = { instagramAccountId: account.instagramAccountId, accessToken: await getAccountAccessToken(account.id),
    text: params.text, attachmentUrl: params.attachmentUrl, attachmentType: params.attachmentType, replyToMid: params.replyToMid };
  const result = commentId
    ? await sendInstagramPrivateReply({ ...content, commentId })
    : await sendInstagramMessage({ ...content, recipientPsid: conversation.customerPsid });
  const message = await recordMessage({ conversationId: conversation.id, mid: result.messageId, direction: "outbound",
    messageType: params.attachmentType ? mapAttachmentToMessageType(params.attachmentType) : "text",
    textContent: params.text, attachmentUrl: params.attachmentUrl, attachmentType: params.attachmentType,
    commentId, sentAt: new Date().toISOString(),
  }, params.text || `[${params.attachmentType ?? "media"}]`);
  return { messageId: message.id };
}

function mapAttachmentToMessageType(type: string): MessageType {
  const types: Record<string, MessageType> = { image: "image", video: "video", audio: "audio", file: "file", reel: "video", ig_reel: "video" };
  return types[type] ?? "unsupported";
}
