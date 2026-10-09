"use client";

import { Loader2, MessageSquare, Search } from "lucide-react";
import { PersonAvatar } from "@/components/app/person-avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { parseDate } from "@/lib/client";
import { cn } from "@/lib/utils";
import type { Conversation } from "@/types";

export function ConversationList({ conversations, selectedId, onSelect, accountName, loading, filtered, hasMore, loadingMore, onLoadMore }: {
  conversations: Conversation[]; selectedId: string; onSelect: (id: string) => void; accountName: string;
  loading: boolean; filtered: boolean; hasMore: boolean; loadingMore: boolean; onLoadMore: () => void;
}) {
  if (loading) return <div aria-label="Loading conversations" className="space-y-5 p-5">{Array.from({ length: 5 }, (_, index) => <div key={index} className="flex gap-3"><Skeleton className="size-10 rounded-full" /><div className="flex-1 space-y-3"><Skeleton className="h-3 w-2/3" /><Skeleton className="h-3 w-full" /></div></div>)}</div>;
  if (!conversations.length) {
    const Icon = filtered ? Search : MessageSquare;
    return <div className="flex flex-1 items-center justify-center p-7"><div className="text-center"><Icon className="mx-auto mb-3 size-6 text-muted-foreground/60" strokeWidth={1.5} /><h2 className="text-sm font-medium">{filtered ? "No matching conversations" : "No conversations yet"}</h2><p className="mt-2 text-xs leading-5 text-muted-foreground">{filtered ? "Try another search or change your filters." : `New messages to @${accountName} will appear here.`}</p></div></div>;
  }
  return (
    <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto py-2">
      <div className="px-2" role="list" aria-label="Conversation list">
        {conversations.map((conversation) => {
          const name = conversation.customerName || "Instagram user";
          return <div role="listitem" key={conversation.id}><button onClick={() => onSelect(conversation.id)} aria-label={`Conversation with ${name}${conversation.isUnread ? ", unread" : ""}`} aria-current={conversation.id === selectedId ? "true" : undefined} className={cn("app-transition mb-1 flex w-full items-start gap-3 rounded-lg px-3 py-4 text-left", conversation.id === selectedId ? "bg-accent" : "hover:bg-muted/80")}>
            <PersonAvatar name={name} src={conversation.customerProfilePic} />
            <div className="min-w-0 flex-1"><div className="flex items-baseline justify-between gap-2"><span className={cn("truncate text-[13px]", conversation.isUnread ? "font-semibold" : "font-medium")}>{name}</span><span className="shrink-0 text-[10px] text-muted-foreground">{conversation.lastMessageAt ? relativeTime(conversation.lastMessageAt) : ""}</span></div><div className="mt-1.5 flex items-center gap-2"><p className={cn("min-w-0 flex-1 truncate text-xs leading-5", conversation.isUnread ? "text-foreground" : "text-muted-foreground")}>{conversation.lastMessageText || "Start a reply"}</p>{conversation.isUnread && <span className="size-1.5 shrink-0 rounded-full bg-primary" />}</div>{conversation.folder === "requests" && <p className="mt-1 text-[10px] text-muted-foreground">Message request</p>}</div>
          </button></div>;
        })}
      </div>
      {hasMore && <div className="px-5 py-3"><Button variant="outline" className="w-full" onClick={onLoadMore} disabled={loadingMore}>{loadingMore && <Loader2 className="animate-spin" />}{loadingMore ? "Loading…" : "Load more conversations"}</Button></div>}
    </div>
  );
}

function relativeTime(value: string) {
  const date = parseDate(value);
  if (Number.isNaN(date.getTime())) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000));
  if (minutes < 1) return "Now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 10080) return `${Math.floor(minutes / 1440)}d`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
