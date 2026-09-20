import { prisma } from "@/lib/db";
import type { AppStatus } from "@/generated/prisma/enums";
import { primaryLocation } from "@/lib/listings/location";
import { countMergeEntries } from "@/lib/ingestion/merge-audit";

/**
 * Read model for the main table.
 *
 * The whole eligible catalog ships to the client once so sorting and filtering
 * on every column stay instant; the row shape is kept deliberately lean for
 * that reason. Anything only the detail panel needs (posting text, full score
 * breakdown, evidence, timeline) is fetched per row on demand.
 */
export interface ListingRow {
  id: string;
  /**
   * Global position by score, assigned during the scoring run — NOT derived
   * from load order, so every tab and every filtered view agrees on it.
   * Null for disqualified listings. `previousRank` shows where it moved from.
   */
  rank: number | null;
  previousRank: number | null;
  /**
   * Whether the listing's OWN score changed in the run that last moved its
   * rank. Almost every rank move is a cascade — the listing sat still while
   * others crossed it — so the table reports movement only when this is true.
   */
  scoreMoved: boolean;
  company: string;
  faangPlus: boolean;
  title: string;
  /**
   * Location shown in the column. A US location wins when the listing has one:
   * these are multi-country postings, and showing "Canada" first for a role
   * that is also in Santa Clara reads as ineligible when it isn't.
   */
  location: string;
  locationCount: number;
  /** Every location (capped), so the cell can name them rather than say "+1". */
  allLocations: string[];
  remote: boolean;
  url: string;
  score: number | null;
  llmAdjustment: number | null;
  /** ISO dates — Server Components can't hand Date objects to client code. */
  postedAt: string | null;
  firstSeen: string;
  deadline: string | null;
  saved: boolean;
  dismissed: boolean;
  disqualified: boolean;
  /** Every reason, in engine order (degree, work authorization, closed). A
   *  listing excluded on two grounds tells you something neither does alone. */
  disqualifyReasons: string[];
  likelyClosed: boolean;
  sources: string[];
  /**
   * How many source records were merged into this listing, so the row knows
   * whether "Split merged listing…" applies to it. Counting distinct
   * `sources` instead would miss a same-source merge — two Simplify records
   * collapsed into one row share a source id — and a wrong merge that stays
   * unsplittable is the exact failure this action exists to undo.
   */
  mergedCount: number;
  /** null means no Application row yet, i.e. "Not Applied". */
  status: AppStatus | null;
  hasPostingText: boolean;
  /**
   * Why a posting page has no text: "http_403" (bot-protected), "robots_denied",
   * "parse_failed", … or null when never attempted. The table shows this so a
   * blocked posting reads as "couldn't fetch" rather than a genuinely low score.
   */
  fetchStatus: string | null;
}

export async function loadListingRows(): Promise<ListingRow[]> {
  const rows = await prisma.listing.findMany({
    select: {
      id: true,
      rank: true,
      previousRank: true,
      scoreMoved: true,
      title: true,
      locations: true,
      remote: true,
      url: true,
      finalScore: true,
      llmAdjustment: true,
      postedAt: true,
      firstSeen: true,
      deadline: true,
      saved: true,
      dismissed: true,
      disqualified: true,
      disqualifyReasons: true,
      likelyClosed: true,
      postingText: false,
      detailFetchStatus: true,
      company: { select: { name: true, faangPlus: true } },
      sources: { select: { source: true } },
      mergedFrom: true,
      application: { select: { status: true } },
      postingTextHash: true,
    },
    // Same ordering the rank pass uses, so the server-rendered order already
    // matches rank before the client sorts. Rank itself is authoritative.
    orderBy: [{ finalScore: "desc" }, { firstSeen: "desc" }, { id: "asc" }],
  });

  return rows.map((l) => ({
    id: l.id,
    rank: l.rank,
    previousRank: l.previousRank,
    scoreMoved: l.scoreMoved,
    company: l.company.name,
    faangPlus: l.company.faangPlus,
    title: l.title,
    location: primaryLocation(l.locations, l.remote),
    locationCount: l.locations.length,
    allLocations: l.locations.slice(0, 8),
    remote: l.remote,
    url: l.url,
    score: l.finalScore,
    llmAdjustment: l.llmAdjustment,
    postedAt: l.postedAt?.toISOString() ?? null,
    firstSeen: l.firstSeen.toISOString(),
    deadline: l.deadline?.toISOString() ?? null,
    saved: l.saved,
    dismissed: l.dismissed,
    disqualified: l.disqualified,
    disqualifyReasons: l.disqualifyReasons,
    likelyClosed: l.likelyClosed,
    sources: [...new Set(l.sources.map((s) => s.source))],
    // NOT l.mergedFrom.length: the same column also holds the reverse
    // "splitFrom" audit written onto a listing that was split back out, and
    // counting those would offer "Split" on a row with nothing to split.
    mergedCount: countMergeEntries(l.mergedFrom),
    status: l.application?.status ?? null,
    hasPostingText: l.postingTextHash !== null,
    fetchStatus: l.detailFetchStatus,
  }));
}
