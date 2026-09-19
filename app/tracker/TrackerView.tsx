"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useOptimistic, useRef, useState, useTransition } from "react";
import type { AppStatus } from "@/generated/prisma/enums";
import type { TrackerApplication } from "@/lib/applications/tracker";
import { setTrackerNotesAction, setTrackerStatusAction } from "./actions";
import KanbanBoard from "./KanbanBoard";
import ListView from "./ListView";
import type { NotesApi } from "./NotesEditor";
import { applyStatusPatch, effectiveNotes, persistedNotes, STATUS_LABELS } from "./state";

export type TrackerViewMode = "kanban" | "list";

interface Props {
  apps: TrackerApplication[];
  view: TrackerViewMode;
  /** Fixed on the server so first paint and hydration agree on relative dates. */
  nowIso: string;
}

type TextMap = Record<string, string>;

function omit(map: TextMap, id: string): TextMap {
  if (!(id in map)) return map;
  const next = { ...map };
  delete next[id];
  return next;
}

export function EmptyHint() {
  return (
    <span>
      No applications yet. Mark listings applied on{" "}
      <Link href="/" className="text-accent hover:underline">
        Listings
      </Link>{" "}
      (focus a row, press <kbd className="rounded border border-line px-1 font-mono text-[11px]">a</kbd>), or
      bulk-add ones you already sent via{" "}
      <Link href="/import" className="text-accent hover:underline">
        Import
      </Link>
      .
    </span>
  );
}

export default function TrackerView({ apps, view, nowIso }: Props) {
  const nowMs = useMemo(() => Date.parse(nowIso), [nowIso]);

  // --- Status: optimistic overlay over the server copy --------------------
  // While the transition runs the patched list is shown; when it ends the
  // overlay is dropped. On success the action's refresh() has already swapped
  // in the new server list (and dashboard); on failure the base list — which
  // never changed — is what reappears. That's the revert.
  const [shown, addPatch] = useOptimistic(apps, applyStatusPatch);
  const [, startTransition] = useTransition();
  const [statusError, setStatusError] = useState<string | null>(null);

  const changeStatus = useCallback(
    (id: string, status: AppStatus) => {
      const app = apps.find((a) => a.id === id);
      setStatusError(null);
      startTransition(async () => {
        addPatch({ id, status, at: new Date().toISOString() });
        let message: string | null = null;
        try {
          const res = await setTrackerStatusAction({ applicationId: id, status });
          if (!res.ok) message = res.message;
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
        if (message) {
          setStatusError(
            `Could not move ${app ? `${app.company} — ${app.role}` : "application"} to ${
              STATUS_LABELS[status]
            }: ${message}. Reverted.`,
          );
        }
      });
    },
    [apps, addPatch],
  );

  // --- Notes: drafts above the cards so nothing is lost on re-render -------
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [drafts, setDrafts] = useState<TextMap>({});
  const [saved, setSaved] = useState<TextMap>({});
  const [errors, setErrors] = useState<TextMap>({});
  const [saving, setSaving] = useState<ReadonlySet<string>>(() => new Set());
  const inFlight = useRef(new Set<string>());

  // `text` and `persisted` come from the render that handled the event, which
  // is always the latest one for a blur/click/keypress.
  const save = useCallback(async (app: TrackerApplication, text: string | undefined, persisted: string) => {
    if (text === undefined || inFlight.current.has(app.id)) return;
    if (text === persisted) {
      setDrafts((d) => omit(d, app.id));
      setErrors((e) => omit(e, app.id));
      return;
    }
    inFlight.current.add(app.id);
    setSaving((s) => new Set(s).add(app.id));
    let message: string | null = null;
    try {
      const res = await setTrackerNotesAction({ applicationId: app.id, notes: text });
      if (!res.ok) message = res.message;
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    inFlight.current.delete(app.id);
    setSaving((s) => {
      const n = new Set(s);
      n.delete(app.id);
      return n;
    });
    if (message) {
      // Keep the draft exactly as typed; only record why it didn't save.
      setErrors((e) => ({ ...e, [app.id]: message }));
      return;
    }
    setErrors((e) => omit(e, app.id));
    setSaved((s) => ({ ...s, [app.id]: text }));
    // Only clear the draft if nothing was typed while the save was in flight.
    setDrafts((d) => (d[app.id] === text ? omit(d, app.id) : d));
  }, []);

  const appsById = useMemo(() => new Map(shown.map((a) => [a.id, a])), [shown]);

  const notes: NotesApi = useMemo(
    () => ({
      isOpen: (id) => open.has(id),
      toggle: (id) =>
        setOpen((o) => {
          const n = new Set(o);
          if (n.has(id)) n.delete(id);
          else n.add(id);
          return n;
        }),
      close: (id) => {
        const app = appsById.get(id);
        if (app) void save(app, drafts[id], persistedNotes(app, saved));
        setOpen((o) => {
          const n = new Set(o);
          n.delete(id);
          return n;
        });
      },
      value: (app) => effectiveNotes(app, drafts, saved),
      isDirty: (app) => app.id in drafts && drafts[app.id] !== persistedNotes(app, saved),
      error: (id) => errors[id],
      isSaving: (id) => saving.has(id),
      change: (id, text) => setDrafts((d) => ({ ...d, [id]: text })),
      save: (app) => void save(app, drafts[app.id], persistedNotes(app, saved)),
      discard: (id) => {
        setDrafts((d) => omit(d, id));
        setErrors((e) => omit(e, id));
      },
    }),
    [open, drafts, saved, errors, saving, save, appsById],
  );

  // Unsaved notes: ask before the tab closes or reloads.
  const hasUnsaved = shown.some((a) => a.id in drafts && drafts[a.id] !== persistedNotes(a, saved));
  useEffect(() => {
    if (!hasUnsaved) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasUnsaved]);

  const manualCount = shown.filter((a) => a.listingId === null).length;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div role="group" aria-label="View" className="flex rounded border border-line bg-panel p-px">
          {(["kanban", "list"] as const).map((mode) => (
            <Link
              key={mode}
              href={mode === "kanban" ? "/tracker" : "/tracker?view=list"}
              scroll={false}
              aria-current={view === mode ? "page" : undefined}
              className={`rounded-sm px-2 py-0.5 text-[12px] ${
                view === mode ? "bg-accent text-accent-ink" : "text-dim hover:text-ink"
              }`}
            >
              {mode === "kanban" ? "Kanban" : "List"}
            </Link>
          ))}
        </div>
        <span className="font-mono text-[11px] text-faint">
          {shown.length} application{shown.length === 1 ? "" : "s"}
          {manualCount > 0 && ` · ${manualCount} manual`}
        </span>
        <div className="ml-auto flex items-center gap-2 text-[12px]">
          <span className="text-[11px] text-faint">
            An export can be re-imported to restore statuses and notes.
          </span>
          <a
            href="/api/applications/export"
            download
            className="rounded border border-line bg-panel px-2 py-0.5 text-dim hover:text-ink"
          >
            Export CSV
          </a>
          <Link
            href="/import"
            className="rounded border border-line bg-panel px-2 py-0.5 text-dim hover:text-ink"
          >
            Import CSV
          </Link>
        </div>
      </div>

      {statusError && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded border border-bad/50 bg-panel px-2 py-1 text-[12px] text-bad"
        >
          <span className="min-w-0 flex-1">{statusError}</span>
          <button type="button" onClick={() => setStatusError(null)} className="text-faint hover:text-ink">
            dismiss
          </button>
        </div>
      )}

      {view === "kanban" ? (
        <>
          {shown.length === 0 && (
            <p data-testid="empty-hint" className="text-[12px] text-dim">
              <EmptyHint />
            </p>
          )}
          <KanbanBoard apps={shown} nowMs={nowMs} onStatus={changeStatus} notes={notes} />
        </>
      ) : (
        <ListView apps={shown} nowMs={nowMs} onStatus={changeStatus} notes={notes} emptyHint={<EmptyHint />} />
      )}
    </div>
  );
}
