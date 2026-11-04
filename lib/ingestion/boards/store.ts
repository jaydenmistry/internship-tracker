/**
 * The watchlist of company job boards (JobBoard rows): discovered from the
 * apply links already in the catalog, added by hand on /boards, and updated
 * with each check's outcome by the job-boards adapter.
 */
import { prisma } from "@/lib/db";
import {
  ATS_LABEL,
  BOARD_ATS,
  BOARDS_SOURCE_ID,
  boardFromUrl,
  boardKey,
  boardPageUrl,
  type BoardAts,
  type BoardRef,
} from "@/lib/ingestion/boards/feeds";

/** Failed checks in a row before a board is skipped until someone retries it. */
export const PAUSE_AFTER_FAILURES = 5;

/** What the adapter needs to check one board. */
export interface WatchedBoard extends BoardRef {
  key: string;
  companyName: string;
}

/** One board's check, as the adapter reports it. */
export interface BoardCheck {
  key: string;
  status: string;
  total?: number;
  kept?: number;
}

/** A board that answered "no such board" is gone, not down: its postings may close. */
export function isDefinitiveStatus(status: string): boolean {
  return status === "ok" || status === "http_404";
}

/**
 * Add a board for every Greenhouse/Lever/Ashby link in the catalog that isn't
 * watched yet, named after the company whose listing linked to it. Existing
 * rows are never touched, so a hand-edited name or a mute sticks.
 */
export async function discoverBoards(): Promise<number> {
  const hosts = ["greenhouse.io", "jobs.lever.co", "jobs.ashbyhq.com"];
  const [listings, sources] = await Promise.all([
    prisma.listing.findMany({
      where: { OR: hosts.map((h) => ({ url: { contains: h } })) },
      select: { url: true, company: { select: { name: true } } },
    }),
    prisma.listingSource.findMany({
      where: { OR: hosts.map((h) => ({ url: { contains: h } })) },
      select: { url: true, listing: { select: { company: { select: { name: true } } } } },
    }),
  ]);
  const found = new Map<string, { ref: BoardRef; companyName: string }>();
  for (const { url, companyName } of [
    ...listings.map((l) => ({ url: l.url, companyName: l.company.name })),
    ...sources.map((s) => ({ url: s.url, companyName: s.listing.company.name })),
  ]) {
    const ref = boardFromUrl(url);
    if (ref && !found.has(boardKey(ref))) found.set(boardKey(ref), { ref, companyName });
  }
  if (found.size === 0) return 0;
  const { count } = await prisma.jobBoard.createMany({
    data: [...found.entries()].map(([key, { ref, companyName }]) => ({
      key,
      ats: ref.ats,
      slug: ref.slug,
      companyName,
    })),
    skipDuplicates: true,
  });
  return count;
}

/** Boards to check this run: watched and not paused. */
export async function loadBoardsToCheck(): Promise<WatchedBoard[]> {
  const rows = await prisma.jobBoard.findMany({
    where: { muted: false, consecutiveFailures: { lt: PAUSE_AFTER_FAILURES } },
    orderBy: { key: "asc" },
    select: { key: true, ats: true, slug: true, companyName: true },
  });
  return rows.flatMap((r) =>
    (BOARD_ATS as readonly string[]).includes(r.ats) ? [{ ...r, ats: r.ats as BoardAts }] : [],
  );
}

/**
 * Boards NOT checked this run whose postings must count as still seen: muted
 * and paused boards, unless their last answer was that the board is gone.
 * Stopping watching a company is not evidence that its roles closed.
 */
export async function boardsLeftAsIs(): Promise<string[]> {
  const rows = await prisma.jobBoard.findMany({
    // Spelled out with an explicit null: in SQL, NOT (lastStatus = 'http_404')
    // is never true for a board that has not been checked yet.
    where: {
      AND: [
        { OR: [{ muted: true }, { consecutiveFailures: { gte: PAUSE_AFTER_FAILURES } }] },
        { OR: [{ lastStatus: null }, { lastStatus: { not: "http_404" } }] },
      ],
    },
    select: { key: true },
  });
  return rows.map((r) => r.key);
}

export async function recordBoardChecks(
  checks: BoardCheck[],
  now: Date,
  { countFailures }: { countFailures: boolean } = { countFailures: true },
): Promise<void> {
  for (const check of checks) {
    const ok = check.status === "ok";
    await prisma.jobBoard.update({
      where: { key: check.key },
      data: {
        lastCheckedAt: now,
        lastStatus: check.status,
        ...(ok
          ? { lastJobCount: check.total ?? 0, lastInternCount: check.kept ?? 0, consecutiveFailures: 0 }
          : countFailures
            ? { consecutiveFailures: { increment: 1 } }
            : {}),
      },
    });
  }
}

/* ------------------------------------------------------------------ */
/* /boards                                                             */
/* ------------------------------------------------------------------ */

export interface BoardRow {
  id: string;
  key: string;
  ats: BoardAts;
  atsLabel: string;
  slug: string;
  /** The board's public page, for people. */
  pageUrl: string;
  companyName: string;
  manual: boolean;
  muted: boolean;
  paused: boolean;
  lastCheckedAt: string | null;
  lastStatus: string | null;
  lastJobCount: number | null;
  lastInternCount: number | null;
  /** Listings this board's feed has found, open or not. */
  listingsFound: number;
}

export async function listBoards(): Promise<BoardRow[]> {
  const [rows, counts] = await Promise.all([
    prisma.jobBoard.findMany({ orderBy: { companyName: "asc" } }),
    prisma.listingSource.findMany({
      where: { source: BOARDS_SOURCE_ID },
      select: { sourceUid: true },
    }),
  ]);
  const found = new Map<string, number>();
  for (const { sourceUid } of counts) {
    const key = sourceUid.slice(0, sourceUid.lastIndexOf(":"));
    found.set(key, (found.get(key) ?? 0) + 1);
  }
  return rows.flatMap((r) =>
    (BOARD_ATS as readonly string[]).includes(r.ats)
      ? [
          {
            id: r.id,
            key: r.key,
            ats: r.ats as BoardAts,
            atsLabel: ATS_LABEL[r.ats as BoardAts],
            slug: r.slug,
            pageUrl: boardPageUrl({ ats: r.ats as BoardAts, slug: r.slug }),
            companyName: r.companyName,
            manual: r.manual,
            muted: r.muted,
            paused: r.consecutiveFailures >= PAUSE_AFTER_FAILURES,
            lastCheckedAt: r.lastCheckedAt?.toISOString() ?? null,
            lastStatus: r.lastStatus,
            lastJobCount: r.lastJobCount,
            lastInternCount: r.lastInternCount,
            listingsFound: found.get(r.key) ?? 0,
          },
        ]
      : [],
  );
}

export type AddBoardResult =
  | { ok: true; created: boolean; companyName: string }
  | { ok: false; message: string };

/** Watch a board by any link into it. Re-adding a muted board watches it again. */
export async function addBoard(url: string, companyName: string | undefined): Promise<AddBoardResult> {
  const ref = boardFromUrl(url.trim());
  if (!ref) {
    return {
      ok: false,
      message: "That isn't a Greenhouse, Lever or Ashby job board link (boards.greenhouse.io/…, jobs.lever.co/…, jobs.ashbyhq.com/…).",
    };
  }
  const key = boardKey(ref);
  // A company the catalog already links to this board keeps its spelling:
  // requisition-id merges only look within one company, so "Scaleai" next to
  // Simplify's "Scale AI" would list every shared role twice.
  const name = (await companyLinkedTo(ref)) ?? (companyName || nameFromSlug(ref.slug));
  const existing = await prisma.jobBoard.findUnique({ where: { key }, select: { id: true } });
  // Upsert: the worker's discovery may create the same row at the same moment.
  await prisma.jobBoard.upsert({
    where: { key },
    create: { key, ats: ref.ats, slug: ref.slug, companyName: name, manual: true },
    update: { muted: false, consecutiveFailures: 0, companyName: name },
  });
  return { ok: true, created: !existing, companyName: name };
}

/** The company whose listings already link into this board, if any. */
async function companyLinkedTo(ref: BoardRef): Promise<string | null> {
  const key = boardKey(ref);
  const rows = await prisma.listing.findMany({
    where: { url: { contains: ref.slug, mode: "insensitive" } },
    select: { url: true, company: { select: { name: true } } },
    take: 200,
  });
  const match = rows.find((r) => {
    const linked = boardFromUrl(r.url);
    return linked !== null && boardKey(linked) === key;
  });
  return match?.company.name ?? null;
}

/** "scale-ai" → "Scale Ai": a starting point the user can correct by re-adding. */
export function nameFromSlug(slug: string): string {
  return slug
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

export async function setBoardMuted(id: string, muted: boolean): Promise<void> {
  await prisma.jobBoard.update({ where: { id }, data: { muted } });
}

/** Un-pause: the next run checks it again. */
export async function retryBoard(id: string): Promise<void> {
  await prisma.jobBoard.update({ where: { id }, data: { consecutiveFailures: 0 } });
}

export async function retryAllPaused(): Promise<number> {
  const { count } = await prisma.jobBoard.updateMany({
    where: { consecutiveFailures: { gte: PAUSE_AFTER_FAILURES } },
    data: { consecutiveFailures: 0 },
  });
  return count;
}
