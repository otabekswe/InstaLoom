import type { Conversation, InstagramAccount, Message } from "@/types";

export interface AccountRow {
  id: string;
  user_id: string;
  instagram_account_id: string;
  display_name: string;
  access_token: string;
  token_expires_at: number | null;
  token_refreshed_at: number | null;
  token_refresh_attempted_at: number;
  instagram_username: string | null;
  instagram_profile_pic: string | null;
  is_active: number;
  connected_at: string;
  updated_at: string;
}

export interface ConversationRow {
  id: string;
  instagram_account_id: string;
  customer_psid: string;
  customer_name: string | null;
  customer_profile_pic: string | null;
  folder: Conversation["folder"];
  last_message_text: string | null;
  last_message_at: string | null;
  is_unread: number;
  assigned_to: string | null;
  status: Conversation["status"];
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  mid: string | null;
  direction: Message["direction"];
  message_type: Message["messageType"];
  text_content: string | null;
  attachment_url: string | null;
  attachment_type: string | null;
  story_reply_to: string | null;
  comment_id: string | null;
  is_read: number;
  sent_at: string | null;
  created_at: string;
}

export function mapAccount(row: AccountRow): InstagramAccount {
  return {
    id: row.id, userId: row.user_id, instagramAccountId: row.instagram_account_id,
    displayName: row.display_name, accessToken: row.access_token,
    tokenExpiresAt: row.token_expires_at, tokenRefreshedAt: row.token_refreshed_at,
    tokenRefreshAttemptedAt: row.token_refresh_attempted_at,
    instagramUsername: row.instagram_username, instagramProfilePic: row.instagram_profile_pic,
    isActive: row.is_active === 1, connectedAt: row.connected_at, updatedAt: row.updated_at,
  };
}

export function mapConversation(row: ConversationRow): Conversation {
  return {
    id: row.id, instagramAccountId: row.instagram_account_id, customerPsid: row.customer_psid,
    customerName: row.customer_name, customerProfilePic: row.customer_profile_pic, folder: row.folder,
    lastMessageText: row.last_message_text, lastMessageAt: row.last_message_at,
    isUnread: row.is_unread === 1, assignedTo: row.assigned_to, status: row.status,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function mapMessage(row: MessageRow): Message {
  return {
    id: row.id, conversationId: row.conversation_id, mid: row.mid, direction: row.direction,
    messageType: row.message_type, textContent: row.text_content, attachmentUrl: row.attachment_url,
    attachmentType: row.attachment_type, storyReplyTo: row.story_reply_to, commentId: row.comment_id,
    isRead: row.is_read === 1, sentAt: row.sent_at, createdAt: row.created_at,
  };
}
