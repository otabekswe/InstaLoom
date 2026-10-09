"use client";

import { useRef, useState, type ComponentProps, type ReactNode } from "react";
import { ArrowDown, ArrowLeft, ArrowUp, Check, ChevronDown, Info, Loader2, Pause, Pencil, Play, Plus, Trash2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, errorMessage } from "@/lib/client";
import { cn } from "@/lib/utils";
import type { AutomationChannel, AutomationRule, AutomationRun } from "@/lib/automations/schema";
import { AutomationEditor } from "./automation-editor";

type Props = {
  accountId: string;
  channel: AutomationChannel;
  mediaId: string;
  rules: AutomationRule[];
  runs: AutomationRun[];
  expired?: boolean;
  needsReconnect: boolean;
  onSave: (rule: AutomationRule) => void;
  onRulesChange: (rules: AutomationRule[]) => void;
  onBusyChange: (busy: boolean) => void;
  onEditingChange: (editing: boolean) => void;
};

export function AutomationList({ accountId, channel, mediaId, rules, runs, expired, needsReconnect, onSave, onRulesChange, onBusyChange, onEditingChange }: Props) {
  // Keep an editing snapshot so background activity polling never resets a draft.
  const [editing, setEditing] = useState<AutomationRule | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<AutomationRule | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const newButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLElement | null>(null);

  function changeBusy(value: boolean) { setBusy(value); onBusyChange(value); }
  function edit(rule: AutomationRule | "new") { setEditing(rule); onEditingChange(true); setError(""); setNotice(""); }
  async function act(rule: AutomationRule, action: "enable" | "pause" | "move-up" | "move-down") {
    changeBusy(true); setError(""); setNotice("");
    try {
      const result = await api<{ rules: AutomationRule[] }>("/api/automations", { method: "PATCH", body: JSON.stringify({ accountId, id: rule.id, action }) });
      onRulesChange(result.rules);
      setNotice(action === "enable" ? `${rule.name} enabled` : action === "pause" ? `${rule.name} paused` : "Order updated");
    } catch (cause) { setError(errorMessage(cause)); }
    finally { changeBusy(false); }
  }
  async function remove() {
    if (!deleteTarget || busy) return;
    changeBusy(true); setDeleteError(""); setNotice("");
    try {
      const result = await api<{ rules: AutomationRule[] }>("/api/automations", { method: "DELETE", body: JSON.stringify({ accountId, id: deleteTarget.id }) });
      onRulesChange(result.rules);
      setNotice(`${deleteTarget.name} deleted`);
      setDeleteTarget(null);
    } catch (cause) { setDeleteError(errorMessage(cause)); }
    finally { changeBusy(false); }
  }

  if (editing) return <div className="mx-auto max-w-xl">
    <div className="mb-5 flex items-center gap-2">
      <Button variant="ghost" size="icon" aria-label="All automations" title="Back to automations" className="-ml-2 text-muted-foreground" disabled={busy} onClick={() => { setEditing(null); onEditingChange(false); }}><ArrowLeft /></Button>
      <h2 className="text-base font-semibold">{editing === "new" ? "New automation" : "Edit automation"}</h2>
    </div>
    <AutomationEditor accountId={accountId} channel={channel} mediaId={mediaId} rule={editing === "new" ? undefined : editing}
      runs={runs.filter((run) => editing !== "new" && run.ruleId === editing.id)} expired={expired}
      onBusyChange={changeBusy} onSave={(rule) => { onSave(rule); setEditing(null); onEditingChange(false); setNotice(rule.enabled ? "Saved and enabled" : "Saved · Paused"); }} />
  </div>;

  return <div className="@container mx-auto max-w-xl">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-1">
        <h3 className="text-sm font-semibold">Automations <span className="ml-1 font-normal text-muted-foreground">{rules.length}</span></h3>
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="How automations run" className="text-muted-foreground" />}><Info className="size-3.5" /></TooltipTrigger>
          <TooltipContent className="max-w-64 leading-5">The first enabled match wins, from top to bottom. Put catch-all rules last. Use the row number to change priority.</TooltipContent>
        </Tooltip>
      </div>
      <Button ref={newButton} onClick={() => edit("new")} disabled={busy}><Plus />New automation</Button>
    </div>
    {expired && <p className="mt-3 text-xs text-muted-foreground">This story has expired. Its rules and activity are kept here.</p>}
    {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground"><Check className="size-3.5" />{notice}</p>}
    {rules.length ? <ol aria-label="Automations in priority order" className="mt-4 divide-y border-y">
      {rules.map((rule, index) => {
        const status = expired ? "Expired" : rule.enabled ? "Enabled" : "Paused";
        const trigger = rule.matchAll ? `Any ${channel === "post" ? "comment" : channel === "story" ? "story reply" : "message"}` : rule.keywords.join(", ");
        return <li key={rule.id} className="flex min-h-14 items-center gap-2 py-2">
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={`Change priority for ${rule.name}`} title="Change priority" disabled={busy} className="gap-0.5 text-xs tabular-nums text-muted-foreground" />}>
              {index + 1}<ChevronDown className="size-2.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem aria-label={`Move ${rule.name} up`} disabled={index === 0 || busy} onClick={() => void act(rule, "move-up")}><ArrowUp />Move up</DropdownMenuItem>
              <DropdownMenuItem aria-label={`Move ${rule.name} down`} disabled={index === rules.length - 1 || busy} onClick={() => void act(rule, "move-down")}><ArrowDown />Move down</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <span role="img" aria-label={status} title={status} className={cn("size-1.5 shrink-0 rounded-full", rule.enabled && !expired ? "bg-primary" : "bg-muted-foreground/40")} />
          <h4 title={rule.name} className="min-w-0 flex-1 truncate text-sm font-medium">{rule.name}</h4>
          <span title={rule.matchAll ? trigger : `Keywords: ${trigger}`} className="hidden min-w-0 max-w-[30%] flex-1 truncate text-xs text-muted-foreground @[480px]:block">{trigger}</span>
          <div className="flex shrink-0 items-center">
            <RowAction label={`Edit ${rule.name}`} hint="Edit" disabled={busy} onClick={() => edit(rule)}><Pencil /></RowAction>
            <RowAction label={`${rule.enabled ? "Pause" : "Enable"} ${rule.name}`} hint={rule.enabled ? "Pause" : "Enable"}
              disabled={busy || (!rule.enabled && (!!expired || needsReconnect))} onClick={() => void act(rule, rule.enabled ? "pause" : "enable")}>
              {rule.enabled ? <Pause /> : <Play />}
            </RowAction>
            <RowAction label={`Delete ${rule.name}`} hint="Delete" disabled={busy} className="hover:bg-destructive/10 hover:text-destructive" onClick={(event) => {
              deleteButton.current = event.currentTarget;
              setDeleteTarget(rule); setDeleteError(""); setError("");
            }}><Trash2 /></RowAction>
          </div>
        </li>;
      })}
    </ol> : <div className="mt-6 border-t py-12 text-center"><Zap className="mx-auto mb-3 size-6 text-muted-foreground" strokeWidth={1.5} /><p className="text-sm font-medium">Your first automatic reply</p><p className="mx-auto mt-2 max-w-xs text-xs leading-5 text-muted-foreground">Add a rule for pricing, opening hours, or anything people ask you often.</p></div>}
    <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open && !busy) setDeleteTarget(null); }}>
      <DialogContent showCloseButton={false} initialFocus={cancelButton} finalFocus={() => deleteButton.current?.isConnected ? deleteButton.current : newButton.current}>
        <DialogHeader>
          <DialogTitle>Delete automation?</DialogTitle>
          <DialogDescription className="break-words">“{deleteTarget?.name}” and its activity will be removed. Queued replies will be canceled. Replies already sent will stay on Instagram.</DialogDescription>
        </DialogHeader>
        {deleteError && <p role="alert" className="text-sm text-destructive">{deleteError}</p>}
        <DialogFooter>
          <Button ref={cancelButton} variant="outline" disabled={busy} onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button variant="destructive" disabled={busy} onClick={() => void remove()}>{busy ? <Loader2 className="animate-spin" /> : <Trash2 />}Delete automation</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}

function RowAction({ label, hint, children, className, ...props }: Omit<ComponentProps<typeof Button>, "children"> & { label: string; hint: string; children: ReactNode }) {
  return <Tooltip>
    <TooltipTrigger render={<Button variant="ghost" size="icon-lg" aria-label={label} className={cn("text-muted-foreground hover:text-foreground", className)} {...props} />}>{children}</TooltipTrigger>
    <TooltipContent>{hint}</TooltipContent>
  </Tooltip>;
}
