"use client";

import { Search } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useOptimistic, useRef, useState, useTransition } from "react";
import type { AppStatus } from "@/generated/prisma/enums";
import type { TrackerApplication } from "@/lib/applications/tracker";
import { isEditable, isPlainKey } from "@/app/listings/keys";
import { attrSelector, celebrate, celebrateProgress, celebrateUndo } from "@/components/celebrate";
import { unlock } from "@/components/celebrate/sound";
import Toast, { type ToastData } from "@/components/Toast";
import { celebrationMessage, momentFor } from "@/lib/celebrate/moments";
import { setTrackerNotesAction, setTrackerStatusAction } from "./actions";
import KanbanBoard from "./KanbanBoard";
import ListView from "./ListView";
import type { NotesApi } from "./NotesEditor";
import { applyStatusPatch, effectiveNotes, persistedNotes, searchApps, STATUS_LABELS } from "./state";

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
      (focus a row, press <kbd className="rounded border border-line px-1 font-mono text-subhead">a</kbd>), or
      bulk-add ones you already sent via{" "}
      <Link href="/import" className="text-accent hover:underline">
        Import
      </Link>
      .
    </span>
  );
}

/** The card (kanban) or row (list) for an application, wherever it is now. */
function landedCard(id: string): Element | null {
  return document.querySelector(attrSelector("data-app-id", id));
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
  const [toast, setToast] = useState<ToastData | null>(null);
  const closeToast = useCallback(() => setToast(null), []);
  const changeStatusRef = useRef<((id: string, status: AppStatus, how?: { quiet?: boolean }) => void) | null>(null);

  const changeStatus = useCallback(
    (id: string, status: AppStatus, how: { quiet?: boolean } = {}) => {
      const app = apps.find((a) => a.id === id);
      const moment = app && !how.quiet ? momentFor(app.status, status) : null;
      const dream = (app?.score ?? 0) >= 70;
      // Audio may only start inside the gesture; the show itself waits a frame.
      if (how.quiet) celebrateUndo();
      else if (moment) unlock();
      setStatusError(null);
      startTransition(async () => {
        addPatch({ id, status, at: new Date().toISOString() });
        // Two frames: the optimistic move has rendered, so the confetti
        // bursts from where the card lands, not where it was.
        if (moment) {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => celebrate(moment, { origin: landedCard(id), dream })),
          );
        }
        let message: string | null = null;
        let progress;
        try {
          const res = await setTrackerStatusAction({ applicationId: id, status });
          if (!res.ok) message = res.message;
          else progress = res.progress;
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
        if (!message && moment && app) {
          celebrateProgress(progress, { origin: landedCard(id) });
          setToast({
            id: Date.now(),
            kind: "celebrate",
            message: celebrationMessage(moment, { company: app.company, dream, progress }),
            action: { label: "Undo", run: () => changeStatusRef.current?.(id, app.status, { quiet: true }) },
          });
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
  useEffect(() => {
    changeStatusRef.current = changeStatus;
  }, [changeStatus]);

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

  // --- Search ---------------------------------------------------------------
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const searching = search.trim() !== "";
  const visible = useMemo(
    () => searchApps(shown, search, (a) => persistedNotes(a, saved), open),
    [shown, search, saved, open],
  );

  // "/" jumps to the search box, as on Listings.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.defaultPrevented || !isPlainKey(e) || isEditable(e.target)) return;
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const noMatches = searching && visible.length === 0 && shown.length > 0 && (
    <span>
      No applications match &ldquo;{search.trim()}&rdquo;.{" "}
      <button type="button" onClick={() => setSearch("")} className="text-accent hover:underline">
        Clear search
      </button>
    </span>
  );

  const manualCount = shown.filter((a) => a.listingId === null).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* Its own line on a phone; beside the view switch from sm up. */}
        <div className="relative min-w-0 basis-full sm:basis-auto">
          <Search aria-hidden size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
          <input
            ref={searchRef}
            type="search"
            value={search}
            placeholder="Search applications"
            aria-label="Search applications"
            title='Matches company, role, location, stage and notes. Every word must match; put "-" in front of a word to exclude it.'
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              e.preventDefault();
              if (search) setSearch("");
              else e.currentTarget.blur();
            }}
            className="h-9 w-full rounded-[10px] border border-transparent bg-raised pr-8 pl-9 text-body text-ink placeholder:text-faint sm:w-72"
          />
          <kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded-md border border-line bg-canvas px-1.5 font-mono text-footnote text-faint">
            /
          </kbd>
        </div>
        <div role="group" aria-label="View" className="seg">
          {(["kanban", "list"] as const).map((mode) => (
            <Link
              key={mode}
              href={mode === "kanban" ? "/tracker" : "/tracker?view=list"}
              scroll={false}
              aria-current={view === mode ? "page" : undefined}
            >
              {mode === "kanban" ? "Kanban" : "List"}
            </Link>
          ))}
        </div>
        <span className="text-callout text-faint tabular-nums" aria-live="polite">
          {searching && `${visible.length} of `}
          {shown.length} application{shown.length === 1 ? "" : "s"}
          {manualCount > 0 && ` · ${manualCount} manual`}
        </span>
        <div className="ml-auto flex items-center gap-2 text-callout">
          <span className="text-subhead text-faint">
            An export can be re-imported to restore statuses and notes.
          </span>
          <a
            href="/api/applications/export"
            download
            className="btn"
          >
            Export CSV
          </a>
          <Link
            href="/import"
            className="btn"
          >
            Import CSV
          </Link>
        </div>
      </div>

      {statusError && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-bad/25 bg-panel px-2 py-1 text-callout text-bad"
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
            <p data-testid="empty-hint" className="text-callout text-dim">
              <EmptyHint />
            </p>
          )}
          {noMatches && (
            <p data-testid="no-matches" className="text-callout text-dim">
              {noMatches}
            </p>
          )}
          <KanbanBoard apps={visible} nowMs={nowMs} onStatus={changeStatus} notes={notes} />
        </>
      ) : (
        <ListView
          apps={visible}
          nowMs={nowMs}
          onStatus={changeStatus}
          notes={notes}
          emptyHint={noMatches || <EmptyHint />}
        />
      )}

      {toast && <Toast key={toast.id} toast={toast} onClose={closeToast} />}
    </div>
  );
}
