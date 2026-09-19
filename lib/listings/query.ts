import { prisma } from "@/lib/db";
import type { AppStatus } from "@/generated/prisma/enums";

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
  disqualifyReason: string | null;
  likelyClosed: boolean;
  sources: string[];
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

const US_STATE_RE =
  /\b(A[LKZR]|C[AOT]|D[EC]|FL|GA|HI|I[DLNA]|K[SY]|LA|M[EDAINSOT]|N[EVHJMYCD]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[TA]|W[AVIY])\b/;

/** Prefers a US location for display; falls back to the first one given. */
function primaryLocation(locations: string[], remote: boolean): string {
  if (remote) return "Remote";
  if (locations.length === 0) return "—";
  return (
    locations.find((l) => US_STATE_RE.test(l) || /\b(USA|United States|US)\b/i.test(l)) ??
    locations[0]
  );
}

export async function loadListingRows(): Promise<ListingRow[]> {
  const rows = await prisma.listing.findMany({
    select: {
      id: true,
      rank: true,
      previousRank: true,
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
    disqualifyReason: l.disqualifyReasons[0] ?? null,
    likelyClosed: l.likelyClosed,
    sources: [...new Set(l.sources.map((s) => s.source))],
    status: l.application?.status ?? null,
    hasPostingText: l.postingTextHash !== null,
    fetchStatus: l.detailFetchStatus,
  }));
}
