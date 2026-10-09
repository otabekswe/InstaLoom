"use client";

import { useCallback, useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { AlertCircle, ChevronDown, Zap, RefreshCw, Search, X } from "lucide-react";
import { useApp, type PublicAccount } from "@/components/app/app-context";
import { ConversationList } from "@/components/inbox/conversation-list";
import { MessageThread } from "@/components/inbox/message-thread";
import { EmptyState } from "@/components/inbox/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage, isAbortError } from "@/lib/client";
import { cn } from "@/lib/utils";
import type { Conversation } from "@/types";

export default function InboxPage() {
  return <Suspense fallback={<InboxSkeleton />}><InboxContent /></Suspense>;
}

function InboxContent() {
  const { accounts, loading, error, retry } = useApp();
  const [selectedAccount, setSelectedAccount] = useState("");
  const searchParams = useSearchParams();
  const account = accounts.find((item) => item.id === selectedAccount) ?? accounts[0];
  if (loading) return <InboxSkeleton />;
  if (error) return <div className="flex h-full items-center justify-center p-6"><div className="max-w-sm text-center"><AlertCircle className="mx-auto mb-3 size-6 text-destructive" /><h1 className="font-medium">Couldn’t load your workspace</h1><p className="my-3 text-sm text-muted-foreground">{error}</p><Button variant="outline" onClick={retry}>Try again</Button></div></div>;
  if (!account) return <div className="flex h-full items-center justify-center"><EmptyState type="no-accounts" /></div>;
  return <InboxWorkspace key={account.id} account={account} accounts={accounts} onAccountChange={setSelectedAccount} connected={Number(searchParams.get("connected")) > 0} />;
}

function InboxWorkspace({ account, accounts, onAccountChange, connected }: { account: PublicAccount; accounts: PublicAccount[]; onAccountChange: (id: string) => void; connected: boolean }) {
  const [status, setStatus] = useState("open");
  const [folder, setFolder] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [showConnected, setShowConnected] = useState(connected);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const controls = (
    <>
      <div className="flex items-center justify-between px-5 pt-6 pb-5"><h1 className="text-xl font-semibold tracking-tight">Inbox</h1><Link href="/inbox/automations" className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"><Zap className="size-3.5" />Automation</Link></div>
      <div className="px-5 pb-4">
        <label htmlFor="inbox-account" className="sr-only">Instagram account</label>
        <div className="relative"><select id="inbox-account" value={account.id} onChange={(event) => onAccountChange(event.target.value)} className="h-10 w-full appearance-none rounded-md border bg-card pr-8 pl-3 text-sm font-medium">{accounts.map((item) => <option key={item.id} value={item.id}>@{item.instagramUsername || item.displayName}</option>)}</select><ChevronDown className="pointer-events-none absolute top-3 right-3 size-4 text-muted-foreground" /></div>
        <div className="relative mt-3"><Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" /><Input aria-label="Search conversations" maxLength={200} placeholder="Search conversations" value={search} onChange={(event) => setSearch(event.target.value)} className="h-9 border-transparent bg-muted pr-9 pl-9 shadow-none" />{search && <button aria-label="Clear search" onClick={() => setSearch("")} className="absolute top-1 right-1 rounded p-1.5 text-muted-foreground"><X className="size-4" /></button>}</div>
      </div>
      <div className="flex items-center justify-between border-b px-5">
        <div className="flex gap-5" aria-label="Conversation status">{["open", "closed"].map((value) => <button key={value} onClick={() => setStatus(value)} aria-pressed={status === value} className={cn("app-transition -mb-px border-b-2 py-3 text-xs font-medium", status === value ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}>{value === "open" ? "Open" : "Closed"}</button>)}</div>
        <select aria-label="Filter by folder" value={folder} onChange={(event) => setFolder(event.target.value)} className="max-w-28 rounded bg-transparent py-1 text-xs text-muted-foreground"><option value="">All folders</option><option value="primary">Primary</option><option value="general">General</option><option value="requests">Requests</option></select>
      </div>
    </>
  );
  return (
    <div className="flex h-full flex-col">
      {account.needsReconnect && <div role="alert" className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-5 py-3 text-xs"><span>Reconnect Instagram to keep receiving messages and sending replies.</span><Link href="/settings" className="font-medium text-primary underline underline-offset-4">Open Settings</Link></div>}
      {showConnected && <div role="status" className="flex shrink-0 items-center justify-between border-b bg-accent px-5 py-2 text-xs text-accent-foreground"><span>Instagram connected. New conversations will appear here.</span><button aria-label="Dismiss connection message" onClick={() => setShowConnected(false)} className="ml-2 rounded p-1"><X className="size-3.5" /></button></div>}
      <ConversationFeed key={`${account.id}:${status}:${folder}:${query}`} account={account} status={status} folder={folder} search={query} controls={controls} />
    </div>
  );
}

type ConversationResponse = { conversations: Conversation[]; hasMore?: boolean };

function ConversationFeed({ account, status, folder, search, controls }: { account: PublicAccount; status: string; folder: string; search: string; controls: React.ReactNode }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pages, setPages] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const markRead = useCallback((id: string) => setConversations((items) => items.map((item) => item.id === id ? { ...item, isUnread: false } : item)), []);
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    async function load() {
      if (busy) return;
      busy = true;
      try {
        const results = await Promise.all(Array.from({ length: pages }, (_, page) => {
          const params = new URLSearchParams({ account_id: account.id, status, limit: "50", offset: String(page * 50) });
          if (folder) params.set("folder", folder);
          if (search) params.set("search", search);
          return api<ConversationResponse>(`/api/conversations?${params}`, { signal: controller.signal });
        }));
        if (controller.signal.aborted) return;
        setConversations(Array.from(new Map(results.flatMap((result) => result.conversations).map((item) => [item.id, item])).values()));
        const last = results[results.length - 1];
        setHasMore(last.hasMore ?? last.conversations.length === 50);
        setError(null);
      } catch (cause) { if (!isAbortError(cause)) setError(errorMessage(cause)); }
      finally { if (!controller.signal.aborted) { setLoading(false); setLoadingMore(false); } busy = false; }
    }
    void load();
    const interval = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 10000);
    return () => { controller.abort(); clearInterval(interval); };
  }, [account.id, status, folder, search, pages, revision]);
  const selected = conversations.find((item) => item.id === selectedId);
  return (
    <div className="flex min-h-0 flex-1">
      <section aria-label="Conversations" className={cn("min-h-0 w-full shrink-0 flex-col border-r bg-card md:flex md:w-[340px]", selected ? "hidden" : "flex")}>
        {controls}
        {error && <div role="alert" className="flex items-center gap-2 border-b bg-destructive/5 px-4 py-3 text-xs text-destructive"><span className="flex-1">{error}</span><Button variant="ghost" size="icon-sm" onClick={refresh} aria-label="Retry conversations"><RefreshCw /></Button></div>}
        <ConversationList conversations={conversations} selectedId={selectedId} onSelect={setSelectedId} accountName={account.instagramUsername || account.displayName} loading={loading} filtered={!!search || !!folder || status === "closed"} hasMore={hasMore} loadingMore={loadingMore} onLoadMore={() => { setLoadingMore(true); setPages((value) => value + 1); }} />
        <div className="border-t px-5 py-3 text-[11px] text-muted-foreground">{loading ? "Loading conversations…" : `${conversations.length}${hasMore ? "+" : ""} ${conversations.length === 1 ? "conversation" : "conversations"}`}<span className="float-right">Instagram</span></div>
      </section>
      <section aria-label="Message thread" className={cn("min-h-0 min-w-0 flex-1 bg-background md:flex", selected ? "flex" : "hidden")}>
        {selected ? <MessageThread key={selected.id} conversation={selected} accountId={account.id} onMessageSent={refresh} onRead={markRead} onBack={() => setSelectedId("")} onStatusChange={() => { setSelectedId(""); refresh(); }} /> : <div className="flex flex-1 items-center justify-center"><EmptyState type="no-conversation" /></div>}
      </section>
    </div>
  );
}

function InboxSkeleton() {
  return <div className="flex h-full"><div className="w-full space-y-5 border-r p-5 md:w-[340px]"><Skeleton className="h-7 w-20" /><Skeleton className="h-10 w-full" /><Skeleton className="h-9 w-full" />{Array.from({ length: 5 }, (_, index) => <div key={index} className="flex gap-3 py-3"><Skeleton className="size-10 rounded-full" /><div className="flex-1 space-y-2"><Skeleton className="h-3 w-2/3" /><Skeleton className="h-3 w-full" /></div></div>)}</div><div className="hidden flex-1 bg-background md:block" /></div>;
}
