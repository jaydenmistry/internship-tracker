import { prisma } from "@/lib/db";
import type { AppStatus } from "@/generated/prisma/enums";
import { recordStatus } from "@/lib/applications/commit";
import { TRACKER_STATUSES } from "@/lib/applications/statuses";
import { primaryLocation } from "@/lib/listings/location";

/**
 * Read/write model for the tracker views (kanban/list + dashboard).
 *
 * Works by APPLICATION id, not listing id, because manual applications (roles
 * found outside the sources) have no listing. Rows with status NOT_APPLIED are
 * excluded everywhere here: they exist only to hold notes written before
 * applying (see lib/listings/mutations.ts) and aren't applications yet.
 */

export { TRACKER_STATUSES, type TrackerStatus } from "@/lib/applications/statuses";

/** Statuses that mean the application was submitted. */
const SUBMITTED: ReadonlySet<AppStatus> = new Set<AppStatus>([
  "APPLIED",
  "OA",
  "PHONE_SCREEN",
  "INTERVIEW",
  "OFFER",
  "REJECTED",
]);

/** Statuses that mean the employer responded. A rejection is a response. */
const RESPONDED: ReadonlySet<AppStatus> = new Set<AppStatus>([
  "OA",
  "PHONE_SCREEN",
  "INTERVIEW",
  "OFFER",
  "REJECTED",
]);

export interface TrackerApplication {
  id: string;
  listingId: string | null;
  /** From the linked listing when present, else what the user typed. */
  company: string;
  role: string;
  location: string | null;
  status: AppStatus;
  appliedAt: string | null;
  updatedAt: string;
  /** When the status last changed. */
  lastEventAt: string | null;
  notes: string | null;
  url: string | null;
  requisitionId: string | null;
  /** Listing context — null for manual applications. */
  score: number | null;
  rank: number | null;
  likelyClosed: boolean;
}

export async function loadTrackerApplications(): Promise<TrackerApplication[]> {
  const apps = await prisma.application.findMany({
    where: { status: { not: "NOT_APPLIED" } },
    include: {
      listing: {
        select: {
          title: true,
          url: true,
          locations: true,
          remote: true,
          finalScore: true,
          rank: true,
          likelyClosed: true,
          company: { select: { name: true } },
        },
      },
      events: { orderBy: { occurredAt: "desc" }, take: 1, select: { occurredAt: true } },
    },
    orderBy: { updatedAt: "desc" },
  });

  return apps.map((a) => ({
    id: a.id,
    listingId: a.listingId,
    company: a.listing?.company.name ?? a.companyName ?? "(unknown company)",
    role: a.listing?.title ?? a.roleTitle ?? "(unknown role)",
    location: a.listing
      ? primaryLocation(a.listing.locations, a.listing.remote)
      : (a.location ?? null),
    status: a.status,
    appliedAt: a.appliedAt?.toISOString() ?? null,
    updatedAt: a.updatedAt.toISOString(),
    lastEventAt: a.events[0]?.occurredAt.toISOString() ?? null,
    notes: a.notes,
    url: a.applyUrl ?? a.listing?.url ?? null,
    requisitionId: a.requisitionId,
    score: a.listing?.finalScore ?? null,
    rank: a.listing?.rank ?? null,
    likelyClosed: a.listing?.likelyClosed ?? false,
  }));
}

export interface DashboardStats {
  /** Current count per pipeline stage (every tracker status, zeros included). */
  byStage: Record<(typeof TRACKER_STATUSES)[number], number>;
  total: number;
  submitted: number;
  responded: number;
  /** responded / submitted, 0–1; null when nothing has been submitted yet. */
  responseRate: number | null;
  /** Shown verbatim in the UI so the number is never ambiguous. */
  definition: string;
}

export const RESPONSE_RATE_DEFINITION =
  "Response rate = applications that ever reached OA, phone screen, interview, offer or rejection, " +
  "divided by applications that were ever submitted. Uses status history, so an application that went " +
  "OA → Rejected counts as a response. Skipped and not-yet-applied entries are excluded.";

/**
 * Pure: derives dashboard numbers from applications and their full status
 * history. Kept separate from the query so it can be unit-tested directly.
 */
export function computeDashboard(
  apps: Array<{ status: AppStatus; appliedAt: Date | string | null; history: AppStatus[] }>,
): DashboardStats {
  const byStage = Object.fromEntries(TRACKER_STATUSES.map((s) => [s, 0])) as DashboardStats["byStage"];
  let total = 0;
  let submitted = 0;
  let responded = 0;

  for (const a of apps) {
    if (a.status === "NOT_APPLIED") continue;
    total += 1;
    if (a.status in byStage) byStage[a.status as keyof typeof byStage] += 1;

    const everHad = (set: ReadonlySet<AppStatus>) =>
      set.has(a.status) || a.history.some((s) => set.has(s));
    const wasSubmitted = a.appliedAt !== null || everHad(SUBMITTED);
    if (!wasSubmitted) continue;
    submitted += 1;
    if (everHad(RESPONDED)) responded += 1;
  }

  return {
    byStage,
    total,
    submitted,
    responded,
    responseRate: submitted > 0 ? responded / submitted : null,
    definition: RESPONSE_RATE_DEFINITION,
  };
}

export async function loadDashboardStats(): Promise<DashboardStats> {
  const apps = await prisma.application.findMany({
    select: { status: true, appliedAt: true, events: { select: { toStatus: true } } },
  });
  return computeDashboard(
    apps.map((a) => ({
      status: a.status,
      appliedAt: a.appliedAt,
      history: a.events.map((e) => e.toStatus),
    })),
  );
}

const hasText = (s: string | null | undefined) => typeof s === "string" && s.trim() !== "";

/** Removes an application and its timeline together. */
async function deleteApplication(applicationId: string): Promise<void> {
  await prisma.$transaction([
    prisma.statusEvent.deleteMany({ where: { applicationId } }),
    prisma.application.delete({ where: { id: applicationId } }),
  ]);
}

/**
 * Status change by application id — works for manual applications too.
 *
 * Mirrors setListingStatus in lib/listings/mutations.ts so both entry points
 * keep one invariant: a NOT_APPLIED row exists only to hold notes. Setting
 * NOT_APPLIED on an application with no notes removes it; with notes, the row
 * stays so the notes are never lost.
 */
export async function setApplicationStatus(
  applicationId: string,
  status: AppStatus,
  opts: { now?: Date; note?: string } = {},
): Promise<{ removed: boolean }> {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { id: true, notes: true },
  });
  if (!app) throw new Error(`no such application: ${applicationId}`);

  if (status === "NOT_APPLIED" && !hasText(app.notes)) {
    await deleteApplication(applicationId);
    return { removed: true };
  }
  await recordStatus(applicationId, status, { occurredAt: opts.now ?? new Date(), note: opts.note });
  return { removed: false };
}

/** Clearing the notes on a notes-only (NOT_APPLIED) row removes the row. */
export async function setApplicationNotes(
  applicationId: string,
  notes: string,
): Promise<{ removed: boolean }> {
  const trimmed = notes.trim() === "" ? null : notes;
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { status: true },
  });
  if (!app) throw new Error(`no such application: ${applicationId}`);

  if (trimmed === null && app.status === "NOT_APPLIED") {
    await deleteApplication(applicationId);
    return { removed: true };
  }
  await prisma.application.update({ where: { id: applicationId }, data: { notes: trimmed } });
  return { removed: false };
}
