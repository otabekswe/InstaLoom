"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, CirclePlay, ExternalLink, ImageIcon, Loader2, MessageCircle, RefreshCw } from "lucide-react";
import { useApp, type PublicAccount } from "@/components/app/app-context";
import { EmptyState } from "@/components/inbox/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage, isAbortError } from "@/lib/client";
import { cn } from "@/lib/utils";
import type { AutomationChannel, AutomationRule, AutomationRun, InstagramMedia } from "@/lib/automations/schema";
import { AutomationList } from "./automation-list";

type RuleResponse = { rules: AutomationRule[]; runs: AutomationRun[]; media: InstagramMedia[] };
type MediaResponse = { media: InstagramMedia[]; nextCursor: string | null };
const titles = { dm: "Inbox", post: "Post", story: "Story" };

export function AutomationWorkspace({ channel }: { channel: AutomationChannel }) {
  const { accounts, loading, error, retry } = useApp();
  const [accountId, setAccountId] = useState("");
  const account = accounts.find((item) => item.id === accountId) ?? accounts[0];
  if (loading) return <div className="space-y-6 p-6"><Skeleton className="h-8 w-32" /><Skeleton className="h-60 w-full max-w-lg" /></div>;
  if (error) return <div className="p-6"><p role="alert" className="mb-3 text-sm">{error}</p><Button variant="outline" onClick={retry}>Try again</Button></div>;
  if (!account) return <div className="flex h-full items-center justify-center"><EmptyState type="no-accounts" /></div>;
  return <Workspace key={`${account.id}:${channel}`} channel={channel} account={account} accounts={accounts} onAccountChange={setAccountId} />;
}

function Workspace({ channel, account, accounts, onAccountChange }: { channel: AutomationChannel; account: PublicAccount; accounts: PublicAccount[]; onAccountChange: (id: string) => void }) {
  const mutation = useRef({ version: 0, busy: false });
  const [data, setData] = useState<RuleResponse | null>(null);
  const [media, setMedia] = useState<InstagramMedia[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [mediaError, setMediaError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const params = new URLSearchParams({ account_id: account.id, channel }).toString();
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    async function loadRules() {
      if (busy || mutation.current.busy) return;
      busy = true;
      const version = mutation.current.version;
      try {
        const result = await api<RuleResponse>(`/api/automations?${params}`, { signal: controller.signal });
        if (!controller.signal.aborted && version === mutation.current.version) { setData(result); setError(""); }
      } catch (cause) { if (!isAbortError(cause)) setError(errorMessage(cause)); }
      finally { busy = false; }
    }
    void loadRules();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void loadRules(); }, 10_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [params, refresh]);
  useEffect(() => {
    if (channel === "dm") return;
    const controller = new AbortController();
    api<MediaResponse>(`/api/media?${params}`, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) { setMedia(result.media); setCursor(result.nextCursor); setMediaError(""); } })
      .catch((cause) => { if (!isAbortError(cause)) setMediaError(errorMessage(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [params, channel, refresh]);
  async function loadMore() {
    setLoadingMore(true);
    try {
      const result = await api<MediaResponse>(`/api/media?${params}&after=${encodeURIComponent(cursor ?? "")}`);
      setMedia((previous) => Array.from(new Map([...previous, ...result.media].map((item) => [item.id, item])).values()));
      setCursor(result.nextCursor); setMediaError("");
    } catch (cause) { setMediaError(errorMessage(cause)); }
    finally { setLoadingMore(false); }
  }
  const items = Array.from(new Map([...media, ...(data?.media ?? []).filter((saved) => !media.some((item) => item.id === saved.id))].map((item) => [item.id, item])).values());
  const selected = items.find((item) => item.id === selectedId);
  const rules = (data?.rules ?? []).filter((item) => item.mediaId === (channel === "dm" ? "" : selectedId));
  const Icon = channel === "story" ? CirclePlay : ImageIcon;
  return <div className="flex h-full flex-col">
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-4 border-b px-5 py-5 sm:px-7">
      <div><h1 className="text-xl font-semibold tracking-tight">{titles[channel]}</h1><p className="mt-1 text-sm text-muted-foreground">{channel === "dm" ? "Automatic replies for your direct messages." : channel === "post" ? "Choose a post. Turn comments into conversations." : "Choose a story and set up an automatic reply."}</p></div>
      <div className="flex items-center gap-2"><label htmlFor="automation-account" className="sr-only">Instagram account</label><select id="automation-account" value={account.id} onChange={(event) => onAccountChange(event.target.value)} className="h-9 max-w-56 rounded-md border bg-card px-3 text-sm">{accounts.map((item) => <option key={item.id} value={item.id}>@{item.instagramUsername || item.displayName}</option>)}</select><Button variant="ghost" size="icon" aria-label="Refresh automations" onClick={() => setRefresh((value) => value + 1)}><RefreshCw /></Button></div>
    </header>
    {account.needsReconnect && <p role="alert" className="border-b px-5 py-3 text-xs">Reconnect Instagram to enable replies. <Link href="/settings" className="text-primary underline">Open Settings</Link></p>}
    {error && <p role="alert" className="border-b px-5 py-3 text-sm text-destructive">{error} <button className="underline" onClick={() => setRefresh((value) => value + 1)}>Try again</button></p>}
    <div className="flex min-h-0 flex-1">
      {channel !== "dm" && <section aria-label={channel === "post" ? "Choose a post" : "Choose a story"} className={cn("w-full shrink-0 overflow-y-auto p-5 md:block md:w-[340px] md:border-r xl:w-[400px]", selected ? "hidden" : "block")}>
        <div className="mb-5 flex items-center justify-between"><h2 className="text-sm font-medium">{channel === "post" ? "Your posts & reels" : "Your stories"}</h2><span className="text-xs text-muted-foreground">{items.length}{cursor ? "+" : ""}</span></div>
        {channel === "story" && <p className="mb-4 text-xs leading-5 text-muted-foreground">Stories stay active for 24 hours. Publish a story on Instagram, then refresh here.</p>}
        {mediaError && <p role="alert" className="mb-4 text-sm text-destructive">{mediaError} <button onClick={() => setRefresh((value) => value + 1)} className="underline">Try again</button></p>}
        {loading ? <div className="grid grid-cols-2 gap-3">{[0, 1, 2, 3].map((id) => <Skeleton key={id} className="aspect-square w-full" />)}</div> : !items.length && !mediaError ? <div className="py-16 text-center"><Icon className="mx-auto mb-3 size-7 text-muted-foreground" /><h3 className="text-sm font-medium">{channel === "post" ? "No posts yet" : "No active stories"}</h3><p className="mt-2 text-xs text-muted-foreground">Publish on Instagram, then refresh to get started.</p></div> : <div className="grid grid-cols-2 gap-3">{items.map((item) => {
          const configured = data?.rules.filter((entry) => entry.mediaId === item.id) ?? [];
          const active = configured.filter((rule) => rule.enabled).length;
          const expired = channel === "story" && isExpired(item);
          return <button key={item.id} aria-label={`Select ${channel}: ${item.caption || item.id}`} aria-pressed={selectedId === item.id} onClick={() => { setSelectedId(item.id); setEditing(false); }} className={cn("group min-w-0 overflow-hidden rounded-lg border text-left transition-colors hover:border-primary/50", selectedId === item.id ? "border-primary ring-1 ring-primary" : "border-border")}>
            <div className={cn("relative flex items-center justify-center overflow-hidden bg-muted", channel === "story" ? "aspect-[3/4]" : "aspect-square")}><MediaImage media={item} />{item.mediaType === "VIDEO" && <CirclePlay className="absolute top-2 right-2 size-5 text-white drop-shadow" />}{selectedId === item.id && <span className="absolute bottom-2 right-2 rounded-full bg-primary p-1 text-primary-foreground"><Check className="size-3" /></span>}</div>
            <div className="px-2.5 py-2"><p className="truncate text-xs font-medium">{item.caption || (channel === "story" ? "Story" : "Instagram post")}</p><p className={cn("mt-1 text-[11px]", active > 0 && !expired ? "text-primary" : "text-muted-foreground")}>{expired ? "Expired" : configured.length ? `${configured.length} ${configured.length === 1 ? "rule" : "rules"} · ${active} on` : "Set up reply"}</p></div>
          </button>;
        })}</div>}
        {cursor && <Button variant="outline" className="mt-5 w-full" disabled={loadingMore} onClick={loadMore}>{loadingMore && <Loader2 className="animate-spin" />}Load more</Button>}
      </section>}
      <section aria-label="Automation settings" className={cn("min-w-0 flex-1 overflow-y-auto p-5 sm:p-7 lg:p-9", channel !== "dm" && !selected ? "hidden md:flex md:items-center md:justify-center" : "block")}>
        {channel === "dm" || selected ? <>
          <div className={cn("mx-auto mb-7 max-w-xl", editing && channel === "dm" && "hidden")}>
            {!editing && (channel === "dm" ? <Link href="/inbox" className="mb-5 inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" />Back to conversations</Link> : <button onClick={() => { setSelectedId(""); setEditing(false); }} className="mb-5 flex items-center gap-2 text-xs text-muted-foreground md:hidden"><ArrowLeft className="size-3.5" />Choose another {channel}</button>)}
            <div className="flex items-start gap-3">{selected && <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted"><MediaImage media={selected} /></div>}<div className="min-w-0 flex-1"><h2 className={cn("text-base font-semibold", editing && "sr-only")}>{channel === "dm" ? "Direct message automations" : channel === "post" ? "Comment automations" : "Story reply automations"}</h2>{selected && <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{selected.caption || (channel === "post" ? "Reply to new comments on this post." : "Reply when someone responds to this story.")}</p>}</div>{selected?.permalink && <a href={selected.permalink} target="_blank" rel="noopener noreferrer" aria-label="View on Instagram" className="rounded p-2 text-muted-foreground"><ExternalLink className="size-4" /></a>}</div>
          </div>
          {data ? <AutomationList key={channel === "dm" ? "dm" : selectedId} accountId={account.id} channel={channel} mediaId={channel === "dm" ? "" : selectedId}
            rules={rules} runs={data.runs} expired={selected && channel === "story" && isExpired(selected)} needsReconnect={account.needsReconnect} onEditingChange={setEditing}
            onBusyChange={(busy) => { mutation.current = { version: mutation.current.version + 1, busy }; }}
            onSave={(updated) => setData((previous) => previous && { ...previous, rules: [...previous.rules.filter((item) => item.id !== updated.id), updated].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)) })}
            onRulesChange={(updated) => setData((previous) => previous && { ...previous, rules: updated })} /> : !error && <Skeleton className="mx-auto h-72 w-full max-w-xl" />}

        </> : <div className="max-w-xs text-center"><MessageCircle className="mx-auto mb-4 size-8 text-muted-foreground/60" strokeWidth={1.5} /><h2 className="font-medium">A reply starts here</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">Choose a {channel} on the left to set your trigger and write a reply.</p></div>}
      </section>
    </div>
  </div>;
}

function isExpired(media: InstagramMedia) { return Date.parse(media.timestamp) < Date.now() - 86400_000; }
function MediaImage({ media }: { media: InstagramMedia }) {
  const [failed, setFailed] = useState(false);
  // Instagram CDN URLs are temporary; render directly without caching them in the image optimizer.
  // eslint-disable-next-line @next/next/no-img-element
  return media.imageUrl && !failed ? <img src={media.imageUrl} alt="" className="size-full object-cover" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : <ImageIcon className="size-6 text-muted-foreground" strokeWidth={1.5} />;
}
