"use client";

/* Instagram attachment URLs are temporary and delivered directly by Meta. */
/* eslint-disable @next/next/no-img-element */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, Check, ChevronDown, ExternalLink, FileText, ImageIcon, Loader2, MessageCircle, Paperclip, RefreshCw, RotateCcw, Send, X } from "lucide-react";
import { toast } from "sonner";
import { PersonAvatar } from "@/components/app/person-avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, errorMessage, isAbortError, parseDate, safeMediaUrl } from "@/lib/client";
import { cn } from "@/lib/utils";
import type { Conversation, Message } from "@/types";

type ThreadResponse = { conversation: Conversation; messages: Message[]; hasMore?: boolean };
type Attachment = { url: string; type: string };
type ScrollIntent = { kind: "bottom" } | { kind: "preserve"; height: number; top: number } | null;

export function MessageThread({ conversation, accountId, onMessageSent, onRead, onBack, onStatusChange }: {
  conversation: Conversation; accountId: string; onMessageSent: () => void;
  onRead: (id: string) => void; onBack: () => void; onStatusChange: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [attachmentOpen, setAttachmentOpen] = useState(false);
  const [privateReply, setPrivateReply] = useState<Message | null>(null);
  const [sending, setSending] = useState(false);
  const [changingStatus, setChangingStatus] = useState(false);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const controller = useRef<AbortController | null>(null);
  const scrollIntent = useRef<ScrollIntent>({ kind: "bottom" });
  const fetching = useRef(false);
  const refreshAfterFetch = useRef(false);
  const sendingRef = useRef(false);
  const initial = useRef(true);
  const name = conversation.customerName || "Instagram user";

  const refresh = useCallback(async (forceBottom = false) => {
    const signal = controller.current?.signal;
    if (!signal || signal.aborted) return;
    if (fetching.current) {
      if (forceBottom) refreshAfterFetch.current = true;
      return;
    }
    fetching.current = true;
    try {
      const data = await api<ThreadResponse>(`/api/conversations/${conversation.id}?limit=50`, { signal });
      if (signal.aborted) return;
      const node = scrollRef.current;
      if (forceBottom || initial.current || (node && node.scrollHeight - node.scrollTop - node.clientHeight < 100)) scrollIntent.current = { kind: "bottom" };
      if (initial.current) setHasMore(data.hasMore ?? data.messages.length === 50);
      setMessages((previous) => mergeMessages(data.messages, previous));
      setLoading(false);
      setError(null);
      initial.current = false;
      if (data.conversation.isUnread) {
        await api(`/api/conversations/${conversation.id}`, { method: "PATCH", body: JSON.stringify({ isRead: true }), signal });
        if (!signal.aborted) onRead(conversation.id);
      }
    } catch (cause) { if (!isAbortError(cause)) { setError(errorMessage(cause)); setLoading(false); } }
    finally {
      if (controller.current?.signal === signal) {
        fetching.current = false;
        if (refreshAfterFetch.current && !signal.aborted) {
          refreshAfterFetch.current = false;
          void refresh(true);
        }
      }
    }
  }, [conversation.id, onRead]);

  useEffect(() => {
    controller.current = new AbortController();
    fetching.current = false;
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 5000);
    return () => { controller.current?.abort(); clearInterval(timer); };
  }, [refresh]);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    const intent = scrollIntent.current;
    if (!node || !intent) return;
    node.scrollTop = intent.kind === "bottom" ? node.scrollHeight : intent.top + node.scrollHeight - intent.height;
    scrollIntent.current = null;
  }, [messages]);

  async function loadOlder() {
    const before = messages[messages.length - 1]?.id;
    const signal = controller.current?.signal;
    if (!before || !signal || fetching.current) return;
    fetching.current = true;
    setLoadingOlder(true);
    try {
      const data = await api<ThreadResponse>(`/api/conversations/${conversation.id}?limit=50&before=${encodeURIComponent(before)}`, { signal });
      if (signal.aborted) return;
      const node = scrollRef.current;
      if (node) scrollIntent.current = { kind: "preserve", height: node.scrollHeight, top: node.scrollTop };
      setMessages((previous) => mergeMessages(previous, data.messages));
      setHasMore(data.hasMore ?? data.messages.length === 50);
    } catch (cause) { if (!isAbortError(cause)) toast.error(errorMessage(cause)); }
    finally {
      fetching.current = false;
      if (!signal.aborted) {
        setLoadingOlder(false);
        if (refreshAfterFetch.current) {
          refreshAfterFetch.current = false;
          void refresh(true);
        }
      }
    }
  }

  async function send(event?: React.FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    const signal = controller.current?.signal;
    if ((!text && !attachment) || sendingRef.current || !signal) return;
    if (!attachment && new TextEncoder().encode(text).length > 1000) {
      toast.error("This message is too long for Instagram. Shorten it and try again.");
      return;
    }
    sendingRef.current = true;
    setSending(true);
    try {
      await api(`/api/conversations/${conversation.id}/messages`, {
        method: "POST", signal,
        body: JSON.stringify({ accountId, ...(attachment ? { attachmentUrl: attachment.url, attachmentType: attachment.type } : { text }), ...(privateReply?.commentId ? { commentId: privateReply.commentId } : {}) }),
      });
      if (signal.aborted) return;
      setDraft(""); setAttachment(null); setPrivateReply(null);
      await refresh(true);
      onMessageSent();
      inputRef.current?.focus();
    } catch (cause) { if (!isAbortError(cause)) toast.error(errorMessage(cause), { duration: 7000 }); }
    finally { sendingRef.current = false; if (!signal.aborted) setSending(false); }
  }

  async function toggleStatus() {
    setChangingStatus(true);
    try {
      await api(`/api/conversations/${conversation.id}`, { method: "PATCH", body: JSON.stringify({ status: conversation.status === "closed" ? "open" : "closed" }), signal: controller.current?.signal });
      toast.success(conversation.status === "closed" ? "Conversation reopened" : "Conversation closed");
      onStatusChange();
    } catch (cause) { if (!isAbortError(cause)) toast.error(errorMessage(cause)); }
    finally { setChangingStatus(false); }
  }

  const chronological = [...messages].reverse();
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <header className="flex min-h-[76px] shrink-0 items-center gap-3 border-b bg-card px-4 sm:px-6">
        <Button variant="ghost" size="icon" className="-ml-2 md:hidden" onClick={onBack} aria-label="Back to conversations"><ArrowLeft /></Button>
        <PersonAvatar name={name} src={conversation.customerProfilePic} className="size-9" />
        <div className="min-w-0 flex-1"><h2 className="truncate text-sm font-semibold">{name}</h2><p className="mt-0.5 text-xs text-muted-foreground">Instagram {conversation.status === "closed" ? "· Closed" : ""}</p></div>
        <Button variant="outline" size={conversation.status === "closed" ? "lg" : "icon-lg"} onClick={toggleStatus} disabled={changingStatus || sending}
          aria-label={conversation.status === "closed" ? "Reopen conversation" : "Close conversation"}
          title={conversation.status === "closed" ? "Reopen conversation" : "Close conversation"}>
          {changingStatus ? <Loader2 className="animate-spin" /> : conversation.status === "closed" ? <RotateCcw /> : <X />}
          {conversation.status === "closed" && <span className="hidden sm:inline">Reopen</span>}
        </Button>
      </header>
      {error && <div role="alert" className="flex items-center justify-between border-b bg-destructive/5 px-5 py-3 text-xs text-destructive"><span>{error}</span><Button variant="ghost" size="sm" onClick={() => void refresh()}><RefreshCw />Retry</Button></div>}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={scrollRef} onScroll={() => { const node = scrollRef.current; if (node) setAwayFromBottom(node.scrollHeight - node.scrollTop - node.clientHeight > 180); }} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-7" aria-label="Messages">
          {loading ? <div className="mx-auto max-w-3xl space-y-5"><Skeleton className="h-16 w-2/3" /><Skeleton className="ml-auto h-20 w-1/2" /><Skeleton className="h-12 w-1/2" /></div> : <div className="mx-auto max-w-3xl">
            {hasMore && <div className="mb-6 text-center"><Button size="sm" variant="outline" onClick={loadOlder} disabled={loadingOlder}>{loadingOlder ? <Loader2 className="animate-spin" /> : <ChevronDown className="rotate-180" />}{loadingOlder ? "Loading…" : "Load older messages"}</Button></div>}
            {!messages.length && <p className="py-12 text-center text-sm text-muted-foreground">No messages in this conversation yet.</p>}
            {chronological.map((message, index) => {
              const date = parseDate(message.sentAt || message.createdAt);
              const previous = chronological[index - 1];
              const previousDate = previous ? parseDate(previous.sentAt || previous.createdAt) : null;
              const showDay = !previousDate || date.toDateString() !== previousDate.toDateString();
              return <div key={message.id}>{showDay && <div className="flex items-center gap-4 py-5"><div className="h-px flex-1 bg-border" /><time className="text-[10px] text-muted-foreground">{Number.isNaN(date.getTime()) ? "Messages" : date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}</time><div className="h-px flex-1 bg-border" /></div>}<MessageBubble message={message} canReply={conversation.status === "open" && !sending} onPrivateReply={() => { setPrivateReply(message); inputRef.current?.focus(); }} /></div>;
            })}
          </div>}
        </div>
        {awayFromBottom && <Button variant="outline" size="icon" className="absolute right-5 bottom-4 bg-card shadow-sm" aria-label="Scroll to latest message" onClick={() => { const node = scrollRef.current; if (node) node.scrollTop = node.scrollHeight; }}><ArrowDown /></Button>}
      </div>
      <div className="shrink-0 border-t bg-card px-4 pt-4 pb-3 sm:px-6">
        {conversation.status === "closed" ? <div className="flex items-center justify-center gap-3 py-3"><p className="text-sm text-muted-foreground">This conversation is closed.</p><Button variant="outline" onClick={toggleStatus} disabled={changingStatus}>Reopen</Button></div> : <form onSubmit={send} className="mx-auto max-w-3xl">
          <div className="overflow-hidden rounded-lg border bg-card focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/10">
            {privateReply && <div className="flex items-center gap-2 border-b bg-accent px-3 py-2 text-xs"><MessageCircle className="size-3.5 text-primary" /><div className="min-w-0 flex-1"><span className="font-medium text-primary">Private reply to comment</span><p className="mt-0.5 truncate text-muted-foreground">{privateReply.textContent}</p></div><Button variant="ghost" size="icon-xs" type="button" aria-label="Cancel private reply" onClick={() => setPrivateReply(null)} disabled={sending}><X /></Button></div>}
            {attachment ? <div className="flex items-center gap-3 px-3 py-4"><Paperclip className="size-4 text-primary" /><div className="min-w-0 flex-1"><p className="text-xs font-medium capitalize">{attachment.type} attachment</p><p className="mt-1 truncate text-xs text-muted-foreground">{attachment.url}</p></div><Button type="button" variant="ghost" size="icon-sm" onClick={() => setAttachment(null)} aria-label="Remove attachment" disabled={sending}><X /></Button></div> : <textarea ref={inputRef} aria-label={privateReply ? "Private reply" : "Message"} placeholder={privateReply ? "Write a private reply…" : "Write a reply…"} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} rows={2} maxLength={1000} disabled={sending} className="max-h-40 min-h-[82px] w-full resize-none bg-transparent px-3.5 py-3 text-sm leading-6 outline-none placeholder:text-muted-foreground/70 focus-visible:outline-none disabled:opacity-60" />}
            <div className="flex items-center justify-between px-2.5 pb-2.5"><div className="flex items-center gap-2"><Button type="button" variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Attach media" title="Attach media" onClick={() => setAttachmentOpen(true)} disabled={sending || !!draft.trim()}><Paperclip /></Button><span className="text-[10px] text-muted-foreground">{privateReply ? "Only visible to the commenter" : "Reply on Instagram"}</span></div><Button type="submit" disabled={sending || (!draft.trim() && !attachment)} className="h-8 gap-2 px-3">{sending ? <Loader2 className="animate-spin" /> : <Send className="size-3.5" />}Send</Button></div>
          </div>
          <p className="mt-2 text-right text-[10px] text-muted-foreground"><span className="hidden sm:inline">Enter to send · Shift + Enter for a new line</span></p>
        </form>}
      </div>
      <AttachmentDialog open={attachmentOpen} onOpenChange={setAttachmentOpen} onAttach={(value) => { setAttachment(value); setAttachmentOpen(false); }} />
    </div>
  );
}

function mergeMessages(first: Message[], second: Message[]) {
  const unique = new Map<string, Message>();
  for (const message of [...first, ...second]) {
    if (!unique.has(message.id)) unique.set(message.id, message);
  }
  return Array.from(unique.values());
}

function MessageBubble({ message, onPrivateReply, canReply = true }: { message: Message; onPrivateReply: () => void; canReply?: boolean }) {
  const outbound = message.direction === "outbound";
  const url = safeMediaUrl(message.attachmentUrl);
  const story = safeMediaUrl(message.storyReplyTo);
  const date = parseDate(message.sentAt || message.createdAt);
  return <div className={cn("mb-4 flex flex-col", outbound ? "items-end" : "items-start")}>
    {message.messageType === "comment_reply" && <p className="mb-1.5 flex items-center gap-1.5 text-[10px] text-muted-foreground"><MessageCircle className="size-3" />{outbound ? "Private reply" : "Instagram comment"}</p>}
    <div className={cn("max-w-[88%] overflow-hidden rounded-lg text-sm leading-6 sm:max-w-[76%]", outbound ? "bg-primary text-white" : "border bg-card text-foreground")}>
      {story && <a href={story} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 border-b border-current/10 px-3.5 py-2 text-xs"><ImageIcon className="size-3.5" />Replied to a story<ExternalLink className="size-3" /></a>}
      {url && message.messageType === "image" && <a href={url} target="_blank" rel="noopener noreferrer"><img src={url} alt="Instagram message attachment" loading="lazy" className="max-h-80 max-w-full object-contain" /></a>}
      {url && message.messageType === "video" && <video src={url} controls preload="metadata" className="max-h-80 max-w-full" aria-label="Video attachment" />}
      {url && message.messageType === "audio" && <div className="p-2"><audio src={url} controls preload="metadata" className="max-w-full" aria-label="Audio attachment" /></div>}
      {url && !["image", "video", "audio"].includes(message.messageType) && <a href={url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 px-3.5 py-3"><FileText className="size-5" /><span className="text-xs underline underline-offset-4">Open attachment</span><ExternalLink className="size-3" /></a>}
      {message.textContent && <p className="whitespace-pre-wrap break-words px-3.5 py-2.5 [overflow-wrap:anywhere]">{message.textContent}</p>}
      {!message.textContent && !url && !story && <p className="px-3.5 py-2.5 text-xs">{message.messageType === "unsupported" ? "This message is available on Instagram." : "Attachment unavailable"}</p>}
    </div>
    <div className="mt-1 flex items-center gap-1.5"><time className="text-[10px] text-muted-foreground" title={Number.isNaN(date.getTime()) ? undefined : date.toLocaleString()}>{Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</time>{outbound && <Check className="size-3 text-muted-foreground" aria-label={message.isRead ? "Read" : "Sent"} />}{!outbound && message.commentId && canReply && <button type="button" onClick={onPrivateReply} className="ml-2 rounded px-1 py-0.5 text-[10px] font-medium text-primary hover:underline">Reply privately</button>}</div>
  </div>;
}

function AttachmentDialog({ open, onOpenChange, onAttach }: { open: boolean; onOpenChange: (open: boolean) => void; onAttach: (value: Attachment) => void }) {
  const [url, setUrl] = useState("");
  const [type, setType] = useState("image");
  const [error, setError] = useState("");
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>Attach media</DialogTitle><DialogDescription>Add a public HTTPS link to the file you want to send.</DialogDescription></DialogHeader><form onSubmit={(event) => { event.preventDefault(); const validUrl = safeMediaUrl(url.trim()); if (!validUrl) { setError("Enter a valid HTTPS URL."); return; } onAttach({ url: validUrl, type }); setUrl(""); setError(""); }} className="space-y-4"><div className="space-y-2"><Label htmlFor="attachment-type">File type</Label><select id="attachment-type" value={type} onChange={(event) => setType(event.target.value)} className="h-10 w-full rounded-md border bg-card px-3 text-sm"><option value="image">Image</option><option value="video">Video</option><option value="audio">Audio</option><option value="file">File</option></select></div><div className="space-y-2"><Label htmlFor="attachment-url">File URL</Label><Input id="attachment-url" type="url" placeholder="https://example.com/image.jpg" value={url} onChange={(event) => { setUrl(event.target.value); setError(""); }} required className="h-10" />{error && <p role="alert" className="text-xs text-destructive">{error}</p>}</div><DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit">Add attachment</Button></DialogFooter></form></DialogContent></Dialog>;
}
