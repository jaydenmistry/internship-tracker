import { differenceInDays } from "date-fns";
import type { AppStatus } from "@/generated/prisma/enums";
import type { TrackerApplication } from "@/lib/applications/tracker";
import { TRACKER_STATUSES, type TrackerStatus } from "@/lib/applications/statuses";

/**
 * Pure presentation logic for /tracker. No React, no DOM, no I/O. Imports only
 * TYPES from lib/applications/tracker (which pulls in Prisma and must never
 * reach the client bundle); the status order comes from the Prisma-free
 * lib/applications/statuses, so there is one list, not a copy.
 */

export type { TrackerStatus };

/** Kanban column order — the pipeline order. */
export const COLUMNS = TRACKER_STATUSES;

export const STATUS_LABELS: Record<AppStatus, string> = {
  NOT_APPLIED: "not applied",
  APPLIED: "applied",
  OA: "OA",
  PHONE_SCREEN: "phone screen",
  INTERVIEW: "interview",
  OFFER: "offer",
  REJECTED: "rejected",
  CLOSED: "closed",
  SKIPPED: "skipped",
};

/** Text colour per status — the same tokens the rest of the app uses. */
export const STATUS_TONE: Record<AppStatus, string> = {
  NOT_APPLIED: "text-faint",
  APPLIED: "text-accent",
  OA: "text-info",
  PHONE_SCREEN: "text-info",
  INTERVIEW: "text-info",
  OFFER: "text-ok",
  REJECTED: "text-bad",
  CLOSED: "text-faint",
  SKIPPED: "text-faint",
};

export interface KanbanColumn {
  status: TrackerStatus;
  apps: TrackerApplication[];
}

/**
 * One column per tracker status, in pipeline order, present even when empty.
 * Input order is preserved within a column (the loader sorts by most recently
 * updated). An app whose status isn't a tracker status (NOT_APPLIED) has no
 * column and is dropped — the loader already excludes those.
 */
export function groupIntoColumns(apps: readonly TrackerApplication[]): KanbanColumn[] {
  const byStatus = new Map<AppStatus, TrackerApplication[]>(COLUMNS.map((s) => [s, []]));
  for (const app of apps) byStatus.get(app.status)?.push(app);
  return COLUMNS.map((status) => ({ status, apps: byStatus.get(status)! }));
}

/** "67%", or plain words when there is nothing to divide by. */
export function formatResponseRate(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return "no submitted applications yet";
  return `${Math.round(rate * 100)}%`;
}

// ---------------------------------------------------------------------------
// Optimistic status patches
// ---------------------------------------------------------------------------

export interface StatusPatch {
  id: string;
  status: AppStatus;
  /** When the change was made, so "last change" updates with the card. */
  at: string;
}

/**
 * Reducer for `useOptimistic`: returns a NEW array with one application's
 * status replaced. The base array is never mutated, so reverting a failed
 * change is simply showing the base again. NOT_APPLIED removes the row, matching
 * what the server loader will return once the change lands.
 */
export function applyStatusPatch(
  apps: readonly TrackerApplication[],
  patch: StatusPatch,
): TrackerApplication[] {
  if (patch.status === "NOT_APPLIED") return apps.filter((a) => a.id !== patch.id);
  return apps.map((a) =>
    a.id === patch.id && a.status !== patch.status
      ? {
          ...a,
          status: patch.status,
          lastEventAt: patch.at,
          appliedAt: patch.status === "APPLIED" ? patch.at : a.appliedAt,
        }
      : a,
  );
}

// ---------------------------------------------------------------------------
// Notes drafts
// ---------------------------------------------------------------------------

/** Generous, but bounded — a Server Action body is capped at 1MB. */
export const MAX_NOTES = 20_000;

/**
 * Notes text shown in an editor: an unsaved draft wins over a value saved this
 * session, which wins over what the server sent. Drafts live above the card so
 * they survive the card moving columns or the view switching.
 */
export function effectiveNotes(
  app: Pick<TrackerApplication, "id" | "notes">,
  drafts: Readonly<Record<string, string>>,
  saved: Readonly<Record<string, string>>,
): string {
  return drafts[app.id] ?? saved[app.id] ?? app.notes ?? "";
}

/** The last persisted notes value (ignores drafts). */
export function persistedNotes(
  app: Pick<TrackerApplication, "id" | "notes">,
  saved: Readonly<Record<string, string>>,
): string {
  return saved[app.id] ?? app.notes ?? "";
}

// ---------------------------------------------------------------------------
// Links and dates
// ---------------------------------------------------------------------------

/**
 * React escapes text but not `href`: `javascript:` in an attribute is the XSS
 * vector left open, and apply URLs are scraped or user-typed. Same approach as
 * `safeHttpUrl` in app/import/state.ts (copied so this route owns its guard).
 */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Compact relative age: "today", "3d", "5w", "4mo". Null input → "—". */
export function relativeAge(iso: string | null, nowMs: number): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const days = differenceInDays(nowMs, t);
  if (days <= 0) return "today";
  if (days < 14) return `${days}d`;
  if (days < 60) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 30)}mo`;
}

/** Absolute timestamp for the hover title, in UTC so server and client agree. */
export function absoluteDate(iso: string | null): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}
