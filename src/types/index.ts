// ── Instagram Account
export interface InstagramAccount {
  id: string;
  userId: string;
  instagramAccountId: string;
  displayName: string;
  accessToken: string;
  tokenExpiresAt: number | null;
  tokenRefreshedAt: number | null;
  tokenRefreshAttemptedAt: number;
  instagramUsername: string | null;
  instagramProfilePic: string | null;
  isActive: boolean;
  connectedAt: string;
  updatedAt: string;
}

/** Safe account shape for browser responses. Access tokens remain server-side. */
export type PublicInstagramAccount = Omit<InstagramAccount, "accessToken" | "tokenRefreshedAt" | "tokenRefreshAttemptedAt"> & { needsReconnect: boolean };

// ── Conversation
export interface Conversation {
  id: string;
  instagramAccountId: string;
  customerPsid: string;
  customerName: string | null;
  customerProfilePic: string | null;
  folder: "primary" | "general" | "requests";
  lastMessageText: string | null;
  lastMessageAt: string | null;
  isUnread: boolean;
  assignedTo: string | null;
  status: "open" | "closed" | "archived";
  createdAt: string;
  updatedAt: string;
}

// ── Message
export type MessageDirection = "inbound" | "outbound";
export type MessageType = "text" | "image" | "video" | "audio" | "file" | "story_reply" | "comment_reply" | "postback" | "unsupported";

export interface Message {
  id: string;
  conversationId: string;
  mid: string | null;
  direction: MessageDirection;
  messageType: MessageType;
  textContent: string | null;
  attachmentUrl: string | null;
  attachmentType: string | null;
  storyReplyTo: string | null;
  commentId: string | null;
  isRead: boolean;
  sentAt: string | null;
  createdAt: string;
}

// ── User (from DB)
export interface User {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Webhook Event
export interface WebhookEvent {
  object: "instagram";
  entry: WebhookEntry[];
}

export interface WebhookEntry {
  id: string; // Instagram professional account user_id, not the app-scoped id
  time: number;
  messaging?: WebhookMessaging[];
  changes?: WebhookChange[];
}

export interface WebhookMessaging {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: {
    mid: string;
    text?: string;
    attachments?: WebhookAttachment[];
    reply_to?: { mid?: string; story?: { id?: string; url?: string } };
    is_unsupported?: boolean;
    is_deleted?: boolean;
    is_echo?: boolean;
  };
  postback?: {
    mid?: string;
    title?: string;
    payload: string;
  };
  reaction?: {
    mid: string;
    reaction: string;
    action: "react" | "unreact";
  };
  read?: { mid?: string; watermark?: number };
}

export interface WebhookAttachment {
  type: string;
  payload: { url?: string };
}

export interface WebhookChange {
  field: string;
  value: {
    id?: string;
    from?: { id: string; name?: string; username?: string };
    post?: { id: string };
    post_id?: string;
    comment_id?: string;
    parent_id?: string;
    media?: { id: string; media_product_type?: string };
    created_time?: number | string;
    text?: string;
    message?: string;
    verb?: string;
    item?: string;
  };
}
