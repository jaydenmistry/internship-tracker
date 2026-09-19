"use client";

import { useEffect, useRef } from "react";
import type { TrackerApplication } from "@/lib/applications/tracker";
import { MAX_NOTES } from "./state";

/**
 * Notes state is owned by TrackerView and handed down as this interface, so a
 * draft survives its card moving columns, the view switching, or the editor
 * closing. A draft is only cleared once the server confirmed the save.
 */
export interface NotesApi {
  isOpen: (id: string) => boolean;
  toggle: (id: string) => void;
  close: (id: string) => void;
  value: (app: TrackerApplication) => string;
  isDirty: (app: TrackerApplication) => boolean;
  error: (id: string) => string | undefined;
  isSaving: (id: string) => boolean;
  change: (id: string, text: string) => void;
  save: (app: TrackerApplication) => void;
  discard: (id: string) => void;
}

/** Collapsed notes: a two-line preview plus the open button. Plain text only. */
export function NotesPreview({ app, notes }: { app: TrackerApplication; notes: NotesApi }) {
  const text = notes.value(app);
  const dirty = notes.isDirty(app);
  const err = notes.error(app.id);
  return (
    <button
      type="button"
      onClick={() => notes.toggle(app.id)}
      aria-expanded={notes.isOpen(app.id)}
      aria-label={`Notes for ${app.company}, ${app.role}`}
      title={text || undefined}
      className="block w-full min-w-0 rounded px-1 py-0.5 text-left text-[12px] text-dim hover:bg-raised"
    >
      {text ? (
        <span data-testid="notes-preview" className="line-clamp-2 break-words whitespace-pre-wrap">
          {text}
        </span>
      ) : (
        <span className="text-faint">+ note</span>
      )}
      {(dirty || err) && (
        <span className={`mt-0.5 block font-mono text-[10px] ${err ? "text-bad" : "text-warn"}`}>
          {err ? "not saved" : "unsaved"}
        </span>
      )}
    </button>
  );
}

export function NotesEditor({ app, notes }: { app: TrackerApplication; notes: NotesApi }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const err = notes.error(app.id);
  const dirty = notes.isDirty(app);
  const saving = notes.isSaving(app.id);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div className="flex flex-col gap-1">
      <textarea
        ref={ref}
        aria-label={`Edit notes for ${app.company}, ${app.role}`}
        value={notes.value(app)}
        maxLength={MAX_NOTES}
        rows={4}
        onChange={(e) => notes.change(app.id, e.target.value)}
        // Saving on blur means clicking away never strands an edit; a failed
        // save keeps the draft and shows why.
        onBlur={() => notes.save(app)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            notes.save(app);
          } else if (e.key === "Escape") {
            // Closing keeps the draft (and blur saves it) — Esc never throws text away.
            e.preventDefault();
            notes.close(app.id);
          }
        }}
        className="w-full resize-y rounded border border-line bg-canvas px-1.5 py-1 text-[12px] leading-snug text-ink"
      />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
        <button
          type="button"
          title="Save (⌘/Ctrl+Enter). Clicking away or Esc also saves."
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => notes.save(app)}
          disabled={!dirty || saving}
          className="rounded border border-line px-1.5 py-px text-dim enabled:hover:text-ink disabled:opacity-50"
        >
          {saving ? "saving…" : err ? "retry" : "save"}
        </button>
        {dirty && !saving && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => notes.discard(app.id)}
            className="text-faint hover:text-ink"
            title="Throw away the unsaved text and go back to the saved notes"
          >
            discard
          </button>
        )}
        <span className={`ml-auto font-mono text-[10px] ${dirty ? "text-warn" : "text-faint"}`}>
          {dirty ? "unsaved" : "saved"}
        </span>
      </div>
      {err && (
        <p role="alert" className="text-[11px] text-bad">
          {err} — your text is kept; retry when ready.
        </p>
      )}
    </div>
  );
}
