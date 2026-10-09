"use client";

import { useRef, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export type KeywordValue = { tags: string[]; draft: string };

function uniqueWords(words: string[]) {
  const seen = new Set<string>();
  return words.map((word) => word.trim()).filter((word) => {
    const key = word.normalize("NFKC").toLowerCase();
    if (!word || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Include unfinished text when saving, even if the field has not lost focus.
export function getKeywords(value: KeywordValue) {
  return uniqueWords([...value.tags, ...value.draft.split(/[,\r\n]/)]);
}

export function KeywordInput({ id, value, onChange }: { id: string; value: KeywordValue; onChange: (value: KeywordValue) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const [announcement, setAnnouncement] = useState("");
  const words = getKeywords(value);
  const error = words.some((word) => word.length > 80) ? "Use 80 characters or fewer for each word or phrase."
    : words.length > 20 ? "Use up to 20 tags. Remove one to make room." : "";

  function commit(text: string, includeLast = true) {
    const parts = text.split(/[,\r\n]/);
    const draft = includeLast ? "" : parts.pop() ?? "";
    const tags = uniqueWords([...value.tags, ...parts]);
    onChange({ tags, draft });
    if (tags.length !== value.tags.length) setAnnouncement(`${tags.length} ${tags.length === 1 ? "tag" : "tags"} total.`);
  }

  return <div>
    <div className={cn("flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-input bg-transparent p-1.5 transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50", error && "border-destructive focus-within:border-destructive focus-within:ring-destructive/20")}>
      {value.tags.map((tag, index) => <span key={tag} className="inline-flex max-w-full items-center rounded-md border border-primary/10 bg-accent pl-2.5 text-sm text-accent-foreground">
        <span className="min-w-0 [overflow-wrap:anywhere]">{tag}</span>
        <button type="button" aria-label={`Remove ${tag}`} className="ml-1 flex size-7 shrink-0 items-center justify-center rounded-sm text-primary/70 transition-colors hover:bg-primary/10 hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:pointer-events-none"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onChange({ ...value, tags: value.tags.filter((_, position) => position !== index) });
            setAnnouncement(`${tag} removed.`);
            input.current?.focus();
          }}><X className="size-3.5" aria-hidden="true" /></button>
      </span>)}
      <input ref={input} id={id} value={value.draft} autoComplete="off" enterKeyHint="enter"
        placeholder={value.tags.length ? "Add a word…" : "Type a word, then comma…"}
        aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`} aria-invalid={!!error || undefined}
        className="h-7 w-32 min-w-24 flex-1 bg-transparent px-1 text-base outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed md:text-sm"
        onChange={(event) => composing.current ? onChange({ ...value, draft: event.target.value }) : commit(event.target.value, false)}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={(event) => { composing.current = false; commit(event.currentTarget.value, false); }}
        onBlur={(event) => { if (!composing.current) commit(event.currentTarget.value); }}
        onPaste={(event) => {
          const text = event.clipboardData.getData("text");
          if (composing.current || !/[,\r\n]/.test(text)) return;
          event.preventDefault();
          const { selectionStart, selectionEnd } = event.currentTarget;
          commit(value.draft.slice(0, selectionStart ?? value.draft.length) + text + value.draft.slice(selectionEnd ?? value.draft.length));
        }}
        onKeyDown={(event) => {
          if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter") { event.preventDefault(); commit(value.draft); }
          else if (event.key === "Backspace" && !value.draft && value.tags.length) {
            event.preventDefault();
            onChange({ tags: value.tags.slice(0, -1), draft: value.tags[value.tags.length - 1] });
          }
        }} />
    </div>
    <span id={`${id}-hint`} className="sr-only">Press comma or Enter to add a tag. Spaces stay in the same phrase. Backspace in an empty field edits the last tag.</span>
    <span className="sr-only" aria-live="polite">{announcement}</span>
    {error && <p id={`${id}-error`} className="mt-2 text-xs text-destructive">{error}</p>}
  </div>;
}
