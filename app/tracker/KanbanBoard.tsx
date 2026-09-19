"use client";

import { useState } from "react";
import type { AppStatus } from "@/generated/prisma/enums";
import type { TrackerApplication } from "@/lib/applications/tracker";
import { ApplyLink, Markers, RelDate, StatusSelect } from "./bits";
import { NotesEditor, NotesPreview, type NotesApi } from "./NotesEditor";
import { groupIntoColumns, STATUS_LABELS, STATUS_TONE } from "./state";

const DRAG_TYPE = "application/x-tracker-app-id";

interface Props {
  apps: TrackerApplication[];
  nowMs: number;
  onStatus: (id: string, status: AppStatus) => void;
  notes: NotesApi;
}

/**
 * Eight fixed columns in pipeline order, sized to fit 1440px without
 * horizontal scroll. The per-card select is the primary (keyboard-accessible)
 * way to move a card; drag-and-drop between columns is a pointer shortcut.
 */
export default function KanbanBoard({ apps, nowMs, onStatus, notes }: Props) {
  const columns = groupIntoColumns(apps);
  const [dropTarget, setDropTarget] = useState<AppStatus | null>(null);

  return (
    <div className="grid grid-cols-8 gap-1.5" data-testid="kanban">
      {columns.map((col) => (
        <section
          key={col.status}
          aria-label={`${STATUS_LABELS[col.status]}: ${col.apps.length}`}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (dropTarget !== col.status) setDropTarget(col.status);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null);
          }}
          onDrop={(e) => {
            const id = e.dataTransfer.getData(DRAG_TYPE);
            setDropTarget(null);
            if (!id) return;
            e.preventDefault();
            const app = apps.find((a) => a.id === id);
            if (app && app.status !== col.status) onStatus(id, col.status);
          }}
          className={`flex min-h-40 min-w-0 flex-col rounded border bg-panel ${
            dropTarget === col.status ? "border-accent" : "border-line"
          }`}
        >
          <header className="flex items-baseline justify-between gap-1 border-b border-line px-2 py-1">
            <h2 className={`truncate text-[12px] font-medium ${STATUS_TONE[col.status]}`}>
              {STATUS_LABELS[col.status]}
            </h2>
            <span
              className={`font-mono text-[11px] tabular-nums ${
                col.apps.length ? "text-dim" : "text-faint"
              }`}
            >
              {col.apps.length}
            </span>
          </header>
          <ol className="flex flex-col gap-1.5 p-1.5">
            {col.apps.map((app) => (
              <li key={app.id}>
                <KanbanCard app={app} nowMs={nowMs} onStatus={onStatus} notes={notes} />
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

export function KanbanCard({
  app,
  nowMs,
  onStatus,
  notes,
}: {
  app: TrackerApplication;
  nowMs: number;
  onStatus: (id: string, status: AppStatus) => void;
  notes: NotesApi;
}) {
  return (
    <article
      data-testid="tracker-card"
      data-app-id={app.id}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, app.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      className={`flex min-w-0 flex-col gap-1 rounded border bg-canvas p-1.5 ${
        app.listingId === null ? "border-dashed border-info/50" : "border-line-soft"
      }`}
    >
      <ApplyLink app={app} className="flex min-w-0 flex-col">
        <span className="truncate font-medium text-ink" title={app.company}>
          {app.company}
        </span>
        <span className="truncate text-[12px] text-dim" title={app.role}>
          {app.role}
        </span>
      </ApplyLink>
      {app.location && (
        <span className="truncate text-[11px] text-faint" title={app.location}>
          {app.location}
        </span>
      )}
      <div className="flex flex-wrap items-center gap-1 text-[11px] text-faint">
        <Markers app={app} />
        {app.score !== null && (
          <span className="font-mono tabular-nums text-dim" title={`score ${app.score}, rank ${app.rank ?? "—"}`}>
            {app.score}
            {app.rank !== null && <span className="text-faint"> #{app.rank}</span>}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 text-[11px] text-faint">
        <span title="Applied">
          <RelDate iso={app.appliedAt} nowMs={nowMs} prefix="ap " />
        </span>
        <span title="Last status change">
          <RelDate iso={app.lastEventAt ?? app.updatedAt} nowMs={nowMs} prefix="Δ " />
        </span>
      </div>
      <StatusSelect app={app} onChange={(s) => onStatus(app.id, s)} className="w-full" />
      {notes.isOpen(app.id) ? (
        <NotesEditor app={app} notes={notes} />
      ) : (
        <NotesPreview app={app} notes={notes} />
      )}
    </article>
  );
}
