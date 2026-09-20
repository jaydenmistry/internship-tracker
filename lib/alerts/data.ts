import { prisma } from "@/lib/db";
import { primaryLocation } from "@/lib/listings/location";
import type { AlertChannel, AlertKind, AlertListing } from "./types";
import type { AlertSettings } from "./settings";

/**
 * Database reads for the alerts package. Everything that touches Prisma lives
 * here or in config.ts, so `build.ts` stays pure.
 */

/**
 * Never alert on a listing the user cleared, one the engine disqualified, or
 * one that has disappeared from every source. `build.ts` re-applies this — the
 * duplication is deliberate, since neither layer should depend on the other
 * having filtered.
 */
const ALERTABLE = { dismissed: false, disqualified: false, likelyClosed: false } as const;

const SELECT = {
  id: true,
  title: true,
  locations: true,
  remote: true,
  url: true,
  finalScore: true,
  deadline: true,
  firstSeen: true,
  saved: true,
  dismissed: true,
  disqualified: true,
  likelyClosed: true,
  company: { select: { name: true } },
  application: { select: { status: true } },
} as const;

type Row = {
  id: string;
  title: string;
  locations: string[];
  remote: boolean;
  url: string;
  finalScore: number | null;
  deadline: Date | null;
  firstSeen: Date;
  saved: boolean;
  dismissed: boolean;
  disqualified: boolean;
  likelyClosed: boolean;
  /**
   * Nullable defensively: Prisma types this as required, but a join through
   * `prisma dev`'s proxy has been observed returning null when a concurrent
   * connection's search_path leaks (the trap documented in CLAUDE.md). An
   * alert naming "(unknown company)" beats a worker cycle dying on a TypeError.
   */
  company: { name: string } | null;
  application: { status: string } | null;
};

function toAlertListing(l: Row): AlertListing {
  return {
    id: l.id,
    company: l.company?.name ?? "(unknown company)",
    title: l.title,
    location: primaryLocation(l.locations, l.remote),
    url: l.url,
    score: l.finalScore,
    deadline: l.deadline,
    firstSeen: l.firstSeen,
    saved: l.saved,
    dismissed: l.dismissed,
    disqualified: l.disqualified,
    likelyClosed: l.likelyClosed,
    // A NOT_APPLIED row exists only to hold notes written before applying, so
    // it does not count as applied — same rule as lib/applications/tracker.ts.
    applied: l.application !== null && l.application.status !== "NOT_APPLIED",
  };
}

/**
 * Sanity bound on one run's candidate set. The per-run send cap
 * (`maxAlertsPerRun`) is applied later, AFTER dedupe, so a backlog drains over
 * successive runs; this only stops one query from loading the whole catalog.
 */
const MAX_CANDIDATES = 2000;

export async function loadAlertCandidates(
  kind: AlertKind,
  settings: AlertSettings,
  now: Date = new Date(),
): Promise<AlertListing[]> {
  if (kind === "DAILY_DIGEST") {
    const cutoff = new Date(now.getTime() - settings.digestLookbackHours * 3_600_000);
    const rows = await prisma.listing.findMany({
      where: { ...ALERTABLE, finalScore: { gte: settings.digestMinScore }, firstSeen: { gte: cutoff } },
      select: SELECT,
      orderBy: [{ finalScore: "desc" }, { firstSeen: "asc" }],
      take: MAX_CANDIDATES,
    });
    return rows.map(toAlertListing);
  }

  if (kind === "HIGH_SCORE") {
    const rows = await prisma.listing.findMany({
      where: { ...ALERTABLE, finalScore: { gte: settings.highScoreMin } },
      select: SELECT,
      orderBy: [{ finalScore: "desc" }, { firstSeen: "asc" }],
      take: MAX_CANDIDATES,
    });
    return rows.map(toAlertListing);
  }

  // CLOSING_SOON. The window is widened by a day on each side here and narrowed
  // to exact calendar days in build.ts, so a deadline stored at local midnight
  // is never dropped by a timezone offset before the builder can judge it.
  const from = new Date(now.getTime() - 86_400_000);
  const to = new Date(now.getTime() + (settings.closingSoonDays + 1) * 86_400_000);
  const rows = await prisma.listing.findMany({
    where: {
      ...ALERTABLE,
      deadline: { gte: from, lte: to },
      OR: [{ saved: true }, { finalScore: { gte: settings.highScoreMin } }],
    },
    select: SELECT,
    orderBy: [{ deadline: "asc" }, { finalScore: "desc" }],
    take: MAX_CANDIDATES,
  });
  return rows.map(toAlertListing);
}

// ---------------------------------------------------------------------------
// AlertLog
// ---------------------------------------------------------------------------

export interface RecentAlert {
  id: string;
  kind: AlertKind;
  channel: AlertChannel;
  listingId: string | null;
  dedupeKey: string;
  sentAt: string;
  /**
   * Preformatted on the server, in ALERT_TIMEZONE. The list renders this
   * string verbatim: formatting a Date in the client component instead would
   * produce different text on the server and in the browser whenever the
   * container's zone differs from the viewer's, which is a hydration mismatch.
   */
  sentAtLabel: string;
  /** Resolved from the listing when it still exists; null for the digest. */
  company: string | null;
  title: string | null;
}

/**
 * The last N alerts actually delivered, newest first, for the /alerts page.
 *
 * AlertLog has no relation to Listing (a listing row can outlive the alert's
 * relevance and vice versa), so the listing names are looked up in a second
 * query rather than joined.
 */
/** "2026-09-20 07:04" in the alert timezone — dense and unambiguous. */
function formatSentAt(d: Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

export async function loadRecentAlerts(limit = 50): Promise<RecentAlert[]> {
  const timeZone = process.env.ALERT_TIMEZONE?.trim() || undefined;
  const rows = await prisma.alertLog.findMany({
    orderBy: { sentAt: "desc" },
    take: Math.min(Math.max(limit, 1), 200),
  });

  const ids = [...new Set(rows.map((r) => r.listingId).filter((id): id is string => id !== null))];
  const listings =
    ids.length === 0
      ? []
      : await prisma.listing.findMany({
          where: { id: { in: ids } },
          select: { id: true, title: true, company: { select: { name: true } } },
        });
  const byId = new Map(listings.map((l) => [l.id, l]));

  return rows.map((r) => {
    const listing = r.listingId ? byId.get(r.listingId) : undefined;
    return {
      id: r.id,
      kind: r.kind,
      channel: r.channel,
      listingId: r.listingId,
      dedupeKey: r.dedupeKey,
      sentAt: r.sentAt.toISOString(),
      sentAtLabel: formatSentAt(r.sentAt, timeZone),
      company: listing?.company.name ?? null,
      title: listing?.title ?? null,
    };
  });
}
