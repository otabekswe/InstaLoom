"use client";

import { useState } from "react";
import { ChevronRight, Eye, History, Loader2, MessageCircle, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HelpTip } from "@/components/ui/help-tip";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage } from "@/lib/client";
import { cn } from "@/lib/utils";
import { automationSchema, type AutomationChannel, type AutomationRule, type AutomationRun } from "@/lib/automations/schema";
import { getKeywords, KeywordInput, type KeywordValue } from "./keyword-input";

export function AutomationEditor({ accountId, channel, mediaId, rule, runs, expired, onSave, onBusyChange }: {
  accountId: string; channel: AutomationChannel; mediaId: string; rule?: AutomationRule;
  runs: AutomationRun[]; expired?: boolean; onSave: (rule: AutomationRule) => void; onBusyChange: (busy: boolean) => void;
}) {
  const [name, setName] = useState(rule?.name ?? "");
  const [matchAll, setMatchAll] = useState(rule?.matchAll ?? false);
  const [keywords, setKeywords] = useState<KeywordValue>({ tags: rule?.keywords ?? [], draft: "" });
  const [mode, setMode] = useState(rule?.publicReply ? rule.dmReply ? "both" : "public" : "dm");
  const [publicReply, setPublicReply] = useState(rule?.publicReply ?? "");
  const [dmReply, setDmReply] = useState(rule?.dmReply ?? "");
  const [enabled, setEnabled] = useState(rule?.enabled ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const noun = channel === "post" ? "comment" : channel === "story" ? "story reply" : "message";
  const sendsPublic = channel === "post" && mode !== "dm";
  const sendsDm = channel !== "post" || mode !== "public";
  const hasPreview = !!((sendsPublic && publicReply.trim()) || (sendsDm && dmReply.trim()));
  const failedRuns = runs.filter((run) => run.status === "failed" || run.status === "unknown").length;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    const words = matchAll ? [] : getKeywords(keywords);
    const parsed = automationSchema.safeParse({ name, accountId, channel, mediaId, enabled, matchAll,
      keywords: words, publicReply: sendsPublic ? publicReply : "", dmReply: sendsDm ? dmReply : "" });
    if (!parsed.success) {
      if (!name.trim()) setError("Give this automation a name.");
      else if (!matchAll && !words.length) setError("Add a word to match, or choose the “Any” option.");
      else if (words.length > 20 || words.some((word) => word.length > 80)) setError("Use up to 20 words or phrases, each with 80 characters or fewer.");
      else if ((sendsPublic && !publicReply.trim()) || (sendsDm && !dmReply.trim())) setError("Write a reply for each selected message type.");
      else setError("Your reply is too long. Shorten it before saving.");
      return;
    }
    setSaving(true); onBusyChange(true);
    try {
      const result = await api<{ rule: AutomationRule }>("/api/automations", { method: rule ? "PUT" : "POST", body: JSON.stringify({ ...parsed.data, ...(rule ? { id: rule.id } : {}) }) });
      onSave(result.rule);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setSaving(false); onBusyChange(false); }
  }

  return <div className="mx-auto w-full max-w-xl">
    <form onSubmit={save} onChange={() => setError("")}>
      <fieldset disabled={saving} className="space-y-5">
        <div className="space-y-1.5">
          <FieldLabel htmlFor="automation-name" label="Name" help="Only you see this name. Pick something easy to recognize, like “Pricing” or “Opening hours”." />
          <Input id="automation-name" required maxLength={80} placeholder="e.g. Pricing details" value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <fieldset className="space-y-3">
          <legend className="mb-2 flex items-center gap-1 text-sm font-medium">Reply when
            <HelpTip label="Reply when">Choose what starts this reply. “Specific words” only matches {noun}s containing your words. “Any {noun}” matches all new {noun}s. If several automations match, only the first enabled one runs.</HelpTip>
          </legend>
          <div className="flex flex-wrap gap-x-6 gap-y-3 text-sm">
            <label className="flex cursor-pointer items-center gap-2"><input type="radio" name="trigger" checked={!matchAll} onChange={() => setMatchAll(false)} className="size-4 accent-primary" />Specific words</label>
            <label className="flex cursor-pointer items-center gap-2"><input type="radio" name="trigger" checked={matchAll} onChange={() => setMatchAll(true)} className="size-4 accent-primary" />Any {noun}</label>
          </div>
          {!matchAll && <div className="space-y-1.5">
            <FieldLabel htmlFor="automation-keywords" label="Words to match" help="Add words or short phrases, separated by commas or Enter. Each becomes a tag. Spaces stay together, like “opening hours”. Only one tag needs to match; “price” matches “What is the PRICE?” too. Use × to remove a tag, or Backspace in the empty field to edit the last one." />
            <KeywordInput id="automation-keywords" value={keywords} onChange={(value) => { setKeywords(value); setError(""); }} />
          </div>}
        </fieldset>
        {channel === "post" && <div className="space-y-1.5">
          <FieldLabel htmlFor="reply-action" label="Send as" help="“Private Message” sends a message to their inbox. “Reply to the comment” adds a reply below their comment, visible to anyone who can see the post. Choose “Both” to do both." />
          <select id="reply-action" value={mode} onChange={(event) => setMode(event.target.value)} className="h-10 w-full rounded-md border bg-card px-3 text-sm">
            <option value="dm">Private Message</option><option value="public">Reply to the comment</option><option value="both">Both</option>
          </select>
        </div>}
        {sendsPublic && <ReplyField id="public-reply" label="Public comment" value={publicReply} onChange={setPublicReply} placeholder="Thanks for your comment!"
          help="This appears as a reply under their comment. Everyone who can see the post can read it." />}
        {sendsDm && <ReplyField id="dm-reply" label={channel === "post" ? "Private message" : "Your reply"} value={dmReply} onChange={setDmReply} placeholder="Hi! Here are the details…"
          help={channel === "post" ? "Sent privately to the person who commented. Other people viewing the post won’t see this message." : "This message is sent automatically from your Instagram account when the chosen words match, or when you’ve selected the “Any” option."} />}
        {hasPreview && <details className="group">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-2 rounded text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden"><Eye className="size-3.5" />Preview reply<ChevronRight className="size-3 group-open:rotate-90" /></summary>
          <div className="mt-3 space-y-3 border-l-2 border-primary/20 pl-4" aria-label="Reply preview">
            {sendsPublic && publicReply.trim() && <div className="flex gap-2.5"><MessageCircle className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><div className="min-w-0 text-sm"><span className="font-medium">Your comment</span><p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{publicReply}</p></div></div>}
            {sendsDm && dmReply.trim() && <div className="flex items-start gap-2.5"><Send className="mt-3 size-4 shrink-0 text-primary" /><p className="min-w-0 rounded-lg rounded-br-sm bg-accent px-3 py-2 text-sm whitespace-pre-wrap break-words text-accent-foreground">{dmReply}</p></div>}
          </div>
        </details>}
        <div className="border-t pt-4">
          {expired && <p className="mb-3 text-sm text-muted-foreground">This story has expired. You can pause this reply or choose another story.</p>}
          <div className="mb-4 flex items-center gap-1 text-xs text-muted-foreground">
            <span>Once per person, every 24 hours</span>
            <HelpTip label="Reply frequency">This automation replies to each person at most once in 24 hours, even if they send the same words again.{channel === "post" ? " It only checks new comments directly on this post, not replies inside comment threads." : channel === "dm" ? " Story replies are set up separately on the Story page." : " It only applies to replies to this story."}</HelpTip>
          </div>
          {error && <p role="alert" className="mb-4 text-sm text-destructive">{error}</p>}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1">
              <label className="flex cursor-pointer items-center gap-2.5 text-sm font-medium">
                <input type="checkbox" role="switch" checked={enabled} disabled={expired && !enabled} onChange={(event) => setEnabled(event.target.checked)} className="peer sr-only" />
                <span aria-hidden="true" className="relative h-5 w-9 rounded-full bg-muted-foreground/30 transition-colors peer-checked:bg-primary peer-focus-visible:outline-2 peer-focus-visible:outline-offset-3 peer-focus-visible:outline-ring peer-disabled:opacity-50 after:absolute after:top-0.5 after:left-0.5 after:size-4 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-4" />Auto-reply
              </label>
              <HelpTip label="Auto-reply">Turn this on to start replying after you save. Leave it off to save your settings without sending anything. You can turn it on later from the list.</HelpTip>
            </div>
            <Button type="submit" disabled={saving}>{saving && <Loader2 className="animate-spin" />}{enabled ? "Save & turn on" : "Save"}</Button>
          </div>
        </div>
      </fieldset>
    </form>
    {!!runs.length && <details className="group mt-6 border-t pt-4" open={failedRuns > 0}>
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded text-xs text-muted-foreground [&::-webkit-details-marker]:hidden"><History className="size-3.5" />Recent replies<span className="tabular-nums">{runs.length}</span>{failedRuns > 0 && <span className="ml-auto text-destructive">{failedRuns} unconfirmed</span>}<ChevronRight className="ml-auto size-3 group-open:rotate-90" /></summary>
      <ul className="mt-2 divide-y">{runs.slice(0, 8).map((run) => <li key={run.id} className="py-3"><div className="flex items-center justify-between gap-3 text-xs"><span>{run.action === "public" ? "Public comment" : "Private message"}</span><span className={run.status === "failed" || run.status === "unknown" ? "text-destructive" : "text-muted-foreground"}>{({ queued: "Waiting", sending: "Sending", sent: "Sent", failed: "Unconfirmed", unknown: "Unconfirmed", skipped: "Skipped" } as Record<string, string>)[run.status] ?? run.status}</span></div><p className="mt-1 truncate text-xs text-muted-foreground">{run.replyText}</p>{run.error && <p className="mt-1 text-xs leading-5 text-muted-foreground">{run.error}</p>}</li>)}</ul>
    </details>}
  </div>;
}

function FieldLabel({ htmlFor, label, help }: { htmlFor: string; label: string; help: string }) {
  return <div className="flex items-center gap-1"><label htmlFor={htmlFor} className="text-sm font-medium">{label}</label><HelpTip label={label}>{help}</HelpTip></div>;
}

function ReplyField({ id, label, value, onChange, placeholder, help }: { id: string; label: string; value: string; onChange: (value: string) => void; placeholder: string; help: string }) {
  const size = new TextEncoder().encode(value.trim()).length;
  const tooLong = size > 1000;
  return <div className="space-y-1.5">
    <FieldLabel htmlFor={id} label={label} help={help} />
    <Textarea id={id} required rows={3} maxLength={1000} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder}
      aria-invalid={tooLong || undefined} aria-describedby={tooLong ? `${id}-limit` : undefined} className="min-h-24 resize-y text-sm" />
    {size >= 800 && <div className={cn("flex items-center justify-end gap-1 text-xs", tooLong ? "text-destructive" : "text-muted-foreground")}>
      <span id={`${id}-limit`}>{tooLong ? "Reply too long — shorten it a little." : "Almost at the message limit"}</span>
      <HelpTip label={`${label} limit`}>Instagram limits message size. Emoji and some letters take more space than others. Shorten your reply until this warning disappears.</HelpTip>
    </div>}
  </div>;
}
