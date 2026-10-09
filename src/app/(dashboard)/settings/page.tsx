"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AlertCircle, ArrowUpRight, Camera, Check, CheckCircle2, Copy, ExternalLink, Link2, Loader2, Plus, RefreshCw, Unplug } from "lucide-react";
import { toast } from "sonner";
import { useApp, type PublicAccount } from "@/components/app/app-context";
import { PersonAvatar } from "@/components/app/person-avatar";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, errorMessage, isAbortError } from "@/lib/client";
import { oauthErrors } from "@/lib/oauth-errors";
import { cn } from "@/lib/utils";

type AppSettings = { privacyUrl: string; dataDeletionUrl: string; privacyContactConfigured: boolean; appUrl: string; webhookUrl: string; redirectUri: string; instagramConfigured: boolean; webhookConfigured: boolean };

export default function SettingsPage() {
  return <Suspense fallback={<SettingsSkeleton />}><SettingsContent /></Suspense>;
}

function SettingsContent() {
  const { accounts, loading, error: workspaceError, refreshAccounts, retry } = useApp();
  const searchParams = useSearchParams();
  const oauthError = searchParams.get("error");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [origin, setOrigin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectTarget, setDisconnectTarget] = useState<PublicAccount | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    api<AppSettings>("/api/settings", { signal: controller.signal }).then((value) => { setSettings(value); setOrigin(window.location.origin); setError(null); }).catch((cause) => { if (!isAbortError(cause)) setError(errorMessage(cause)); });
    return () => controller.abort();
  }, [revision]);
  const appOrigin = getOrigin(settings?.appUrl);
  const wrongOrigin = !!origin && !!appOrigin && origin !== appOrigin;
  const connectDisabled = connecting || !settings?.instagramConfigured || wrongOrigin;

  async function connect() {
    setConnecting(true);
    try {
      const data = await api<{ url: string }>("/api/auth/instagram");
      window.location.assign(data.url);
    } catch (cause) { toast.error(errorMessage(cause)); setConnecting(false); }
  }
  async function disconnect() {
    if (!disconnectTarget) return;
    setDisconnecting(true);
    try {
      await api(`/api/accounts/${disconnectTarget.id}`, { method: "DELETE" });
      await refreshAccounts();
      setDisconnectTarget(null);
      toast.success("Instagram account disconnected");
    } catch (cause) { toast.error(errorMessage(cause)); }
    finally { setDisconnecting(false); }
  }

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b px-6 py-6 sm:px-10"><div><h1 className="text-xl font-semibold tracking-tight">Settings</h1><p className="mt-1.5 text-sm text-muted-foreground">Manage your accounts and workspace connection.</p></div><a href="#public-pages-heading" className="text-xs font-medium text-primary underline-offset-4 hover:underline">Privacy &amp; data deletion</a></header>
      <div className="max-w-[900px] space-y-9 px-6 py-8 sm:px-10">
        {oauthError && <div role="alert" className="flex items-start gap-3 rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-sm leading-6 text-destructive"><AlertCircle className="mt-1 size-4 shrink-0" /><p>{oauthErrors[oauthError] || "The connection didn’t finish. Check your settings and try again."}</p></div>}
        {(error || workspaceError) && <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-destructive/20 p-4 text-sm text-destructive"><p>{error || workspaceError}</p><Button variant="outline" onClick={() => { setRevision((value) => value + 1); retry(); }}><RefreshCw />Retry</Button></div>}
        <section aria-labelledby="accounts-heading">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-4"><div><h2 id="accounts-heading" className="text-sm font-semibold">Instagram accounts</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">Connect a professional account to receive and reply to messages.</p></div><Button onClick={connect} disabled={connectDisabled} className="h-9 px-3">{connecting ? <Loader2 className="animate-spin" /> : <Plus />}Connect account</Button></div>
          {loading ? <div className="space-y-3"><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /></div> : accounts.length ? <div className="divide-y rounded-lg border">{accounts.map((account) => <div key={account.id} className="flex items-center gap-3 px-4 py-4"><PersonAvatar name={account.instagramUsername || account.displayName} src={account.instagramProfilePic} /><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">@{account.instagramUsername || account.displayName}</p><p className="mt-1 truncate text-xs text-muted-foreground">{account.displayName}</p></div><span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">{account.needsReconnect ? <AlertCircle className="size-3.5 text-amber-600" /> : <CheckCircle2 className="size-3.5 text-emerald-600" />}{account.needsReconnect ? "Reconnect needed" : "Connected"}</span>{account.needsReconnect && <Button variant="outline" size="sm" onClick={connect} disabled={connectDisabled}>Reconnect</Button>}<Button variant="ghost" size="icon" aria-label={`Disconnect ${account.instagramUsername || account.displayName}`} title="Disconnect account" onClick={() => setDisconnectTarget(account)} className="ml-2 text-muted-foreground hover:text-destructive"><Unplug /></Button></div>)}</div> : <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed p-6 sm:flex-row sm:items-center sm:gap-4"><Camera className="size-7 shrink-0 text-muted-foreground/60" strokeWidth={1.4} /><div><p className="text-sm font-medium">No accounts connected</p><p className="mt-1 text-xs leading-5 text-muted-foreground">Your connected Instagram accounts will appear here.</p></div></div>}
          {settings && !settings.instagramConfigured && <p className="mt-3 text-xs leading-5 text-amber-700">Add your Instagram app ID and Instagram app secret to the workspace environment, then restart the app to enable connections.</p>}
          {wrongOrigin && <div className="mt-4 rounded-lg border bg-background p-4"><p className="text-sm font-medium">Continue on your public workspace</p><p className="mt-1 text-xs leading-5 text-muted-foreground">Sign in at your configured app address before connecting Instagram. The connection needs to return to the same browser session.</p><a href={`${appOrigin}/settings`} className={buttonVariants({ variant: "outline", className: "mt-3 bg-card" })}>Open workspace<ArrowUpRight /></a></div>}
        </section>
        <section aria-labelledby="connection-heading" className="border-t pt-8">
          <div className="mb-5 flex items-start justify-between gap-4"><div><h2 id="connection-heading" className="text-sm font-semibold">Connection setup</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">Use these addresses in your Meta app’s configuration.</p></div><a href="https://developers.facebook.com/apps/" target="_blank" rel="noopener noreferrer" className="flex shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline">Meta dashboard<ExternalLink className="size-3" /></a></div>
          {settings ? <div className="space-y-5">
            <div className="flex flex-wrap gap-x-6 gap-y-2 pb-1"><ConfigurationStatus ready={settings.instagramConfigured} label="Instagram login credentials" /><ConfigurationStatus ready={settings.webhookConfigured} label="Webhook credentials" /></div>
            <ConfigValue label="Workspace URL" value={settings.appUrl} openPage />
            <ConfigValue label="OAuth redirect URI" value={settings.redirectUri} hint="Meta → Instagram → Set up Instagram business login → Valid OAuth Redirect URIs." />
            <ConfigValue label="Webhook callback URL" value={settings.webhookUrl} hint="Meta → Instagram → Webhooks → Callback URL. Keep /api/webhook at the end." />
          </div> : !error && <div className="space-y-4"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div>}
          <div className="mt-6 space-y-3 border-t pt-5 text-xs leading-6 text-muted-foreground"><p>Paste your <span className="font-medium text-foreground">WEBHOOK_VERIFY_TOKEN</span> into Meta’s Verify token field, then choose Verify and save.</p><p>Subscribe to <span className="font-medium text-foreground">messages</span>, <span className="font-medium text-foreground">messaging_postbacks</span>, <span className="font-medium text-foreground">messaging_seen</span>, and <span className="font-medium text-foreground">comments</span>. Complete Meta’s prerequisites and set App Mode to Live. Test with a new message from another Instagram account.</p><p>If your domain changes, update APP_URL, redeploy, and replace the URLs in Meta.</p></div>
        </section>
        <section aria-labelledby="public-pages-heading" className="border-t pt-8">
          <div className="mb-5"><h2 id="public-pages-heading" className="text-sm font-semibold">Public pages</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">Already included. Open to check, then copy the URL into Meta.</p></div>
          {settings ? <div className="space-y-5">
            <ConfigValue label="Privacy Policy URL" value={settings.privacyUrl} openPage hint="Meta → App settings → Basic → Privacy Policy URL." />
            <ConfigValue label="Data Deletion Instructions URL" value={settings.dataDeletionUrl} openPage hint="Meta → App settings → Basic → User data deletion → select Data deletion instructions URL." />
            {!settings.privacyContactConfigured && <p className="text-xs leading-5 text-amber-700">Add PRIVACY_CONTACT_NAME and either PRIVACY_CONTACT_EMAIL or PRIVACY_CONTACT_URL to your environment, then redeploy to publish your contact details.</p>}
            <p className="text-xs leading-5 text-muted-foreground">Both pages must open without signing in. Check them in a private browser window before switching your Meta app to Live.</p>
          </div> : !error && <div className="space-y-4"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div>}
        </section>
      </div>
      <Dialog open={!!disconnectTarget} onOpenChange={(open) => { if (!open && !disconnecting) setDisconnectTarget(null); }}><DialogContent showCloseButton={!disconnecting}><DialogHeader><DialogTitle>Disconnect Instagram account?</DialogTitle><DialogDescription>New messages from @{disconnectTarget?.instagramUsername || disconnectTarget?.displayName} will stop arriving. Your existing conversations will be kept.</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setDisconnectTarget(null)} disabled={disconnecting}>Cancel</Button><Button variant="destructive" onClick={disconnect} disabled={disconnecting}>{disconnecting && <Loader2 className="animate-spin" />}Disconnect account</Button></DialogFooter></DialogContent></Dialog>
    </div>
  );
}

function ConfigurationStatus({ ready, label }: { ready: boolean; label: string }) {
  const Icon = ready ? CheckCircle2 : AlertCircle;
  return <div className="flex items-center gap-1.5 text-xs"><Icon className={cn("size-3.5", ready ? "text-emerald-600" : "text-amber-600")} /><span className="text-muted-foreground">{label}</span><span className={ready ? "text-emerald-700" : "text-amber-700"}>{ready ? "Ready" : "Missing"}</span></div>;
}

function ConfigValue({ label, value, hint, openPage = false }: { label: string; value: string; hint?: string; openPage?: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const timeout = setTimeout(() => setCopied(false), 1800); return () => clearTimeout(timeout); }, [copied]);
  async function copy() {
    try { await navigator.clipboard.writeText(value); setCopied(true); }
    catch { toast.error("Couldn’t copy the address. Select the text and copy it manually."); }
  }
  return <div><p className="mb-2 text-xs font-medium">{label}</p><div className="flex min-w-0 items-center gap-3 rounded-md border bg-background px-3 py-2"><Link2 className="size-3.5 shrink-0 text-muted-foreground" /><code className="min-w-0 flex-1 select-all break-all font-mono text-xs leading-5">{value}</code><div className="flex shrink-0 items-center gap-1">{openPage && <a href={value} target="_blank" rel="noopener noreferrer" aria-label={`Open ${label}`} title={`Open ${label}`} className={buttonVariants({ variant: "ghost", size: "icon-sm", className: "text-muted-foreground" })}><ExternalLink /></a>}<Button variant="ghost" size="icon-sm" onClick={copy} aria-label={`Copy ${label}`} title={copied ? "Copied" : `Copy ${label}`}>{copied ? <Check className="text-emerald-600" /> : <Copy className="text-muted-foreground" />}</Button></div></div>{hint && <p className="mt-1.5 text-[11px] leading-5 text-muted-foreground">{hint}</p>}</div>;
}

function getOrigin(value?: string) {
  if (!value) return "";
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.origin : ""; }
  catch { return ""; }
}

function SettingsSkeleton() {
  return <div className="space-y-8 p-8"><Skeleton className="h-7 w-28" /><Skeleton className="h-24 max-w-2xl" /><Skeleton className="h-40 max-w-2xl" /></div>;
}
