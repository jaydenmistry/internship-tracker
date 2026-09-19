import {
  differenceInCalendarDays,
  differenceInHours,
  differenceInMinutes,
  format,
  parseISO,
} from "date-fns";
import type { AppStatus } from "@/generated/prisma/enums";
import type { ListingRow } from "@/lib/listings/query";

/**
 * Everything the main table decides — sorting, filtering, badge and date
 * formatting — lives here as pure functions over plain data. No React, no DOM,
 * no I/O, so the behaviour the user actually depends on (what is hidden by
 * default, what "closing soon" means, where nulls sort) is unit-testable
 * without rendering ~2,900 rows.
 */

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export interface TableRow extends ListingRow {
  /** 1-based position in the server's ranking (score desc). Fixed: filtering
   *  the view never renumbers a listing, so "rank 12" means the same thing all
   *  session long. */
  rank: number;
  /** Lowercased "company title location" for substring search. Precomputed
   *  once because the search box filters on every keystroke. */
  haystack: string;
  /** Epoch ms of postedAt, falling back to firstSeen — what the age column shows. */
  ageTs: number;
  /** Epoch ms of the deadline, or null. */
  deadlineTs: number | null;
  /** Status with the "no Application row" case folded into NOT_APPLIED. */
  statusKey: AppStatus;
}

function epoch(iso: string): number {
  const ms = parseISO(iso).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

export function prepareRows(rows: readonly ListingRow[]): TableRow[] {
  return rows.map((row, index) => ({
    ...row,
    rank: index + 1,
    haystack: `${row.company} ${row.title} ${row.location}`.toLowerCase(),
    ageTs: epoch(row.postedAt ?? row.firstSeen),
    deadlineTs: row.deadline ? epoch(row.deadline) : null,
    statusKey: row.status ?? "NOT_APPLIED",
  }));
}

// ---------------------------------------------------------------------------
// URL safety
// ---------------------------------------------------------------------------

/**
 * React escapes text but not `href`, and listing URLs are scraped third-party
 * data — `javascript:` in an attribute is the one XSS vector left open. Mirrors
 * `safeHttpUrl` in app/import/state.ts; duplicated deliberately so the client
 * bundle for the table does not pull in the import matcher's module graph.
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

// ---------------------------------------------------------------------------
// Fetch status → badge
// ---------------------------------------------------------------------------

export interface FetchBadge {
  label: string;
  /** Tooltip text; always names the raw status so the cause is never guessed at. */
  title: string;
  tone: "bad" | "warn";
}

const FETCH_BADGES: Record<string, FetchBadge> = {
  http_403: {
    label: "no text · 403",
    title:
      "Couldn't fetch the posting: HTTP 403 (bot protection). The score is text-independent — this is not a low-quality listing.",
    tone: "bad",
  },
  http_404: {
    label: "no text · 404",
    title: "Couldn't fetch the posting: HTTP 404. The posting may already be gone.",
    tone: "warn",
  },
  robots_denied: {
    label: "no text · robots",
    title:
      "Couldn't fetch the posting: robots.txt disallows it. The score is text-independent — not a low-quality listing.",
    tone: "warn",
  },
  parse_failed: {
    label: "no text · parse",
    title:
      "Fetched the posting but couldn't extract text (parse_failed). The score is text-independent.",
    tone: "warn",
  },
  timeout: {
    label: "no text · timeout",
    title: "Couldn't fetch the posting: the request timed out.",
    tone: "warn",
  },
};

/**
 * A listing whose fetch was *attempted and failed* must not read as a genuinely
 * weak listing, so it gets an unmissable marker. `null` means never attempted —
 * a different, quieter state that gets no badge at all.
 */
export function fetchBadge(fetchStatus: string | null | undefined): FetchBadge | null {
  if (!fetchStatus || fetchStatus === "ok") return null;
  const known = FETCH_BADGES[fetchStatus];
  if (known) return known;
  const http = /^http_(\d{3})$/.exec(fetchStatus);
  if (http) {
    return {
      label: `no text · ${http[1]}`,
      title: `Couldn't fetch the posting: HTTP ${http[1]}. The score is text-independent.`,
      tone: "bad",
    };
  }
  return {
    label: "no text",
    title: `Couldn't fetch the posting (${fetchStatus}). The score is text-independent.`,
    tone: "warn",
  };
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** "4m" / "7h" / "12d" / "3mo" — fixed-width-ish so the column scans vertically. */
export function relativeAge(ts: number, now: number): string {
  const then = new Date(ts);
  const nowDate = new Date(now);
  const minutes = differenceInMinutes(nowDate, then);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = differenceInHours(nowDate, then);
  if (hours < 24) return `${hours}h`;
  const days = differenceInCalendarDays(nowDate, then);
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

export function absoluteDate(ts: number): string {
  return format(new Date(ts), "EEE d MMM yyyy, HH:mm");
}

export function absoluteDay(ts: number): string {
  return format(new Date(ts), "EEE d MMM yyyy");
}

export const CLOSING_SOON_DAYS = 7;

export type DeadlineUrgency = "none" | "soon" | "past";

/** Whole calendar days from `now` to the deadline; negative once it has passed. */
export function daysUntilDeadline(deadlineTs: number, now: number): number {
  return differenceInCalendarDays(new Date(deadlineTs), new Date(now));
}

/**
 * "Closing soon" is 0..7 whole calendar days out, inclusive at both ends: today
 * counts, day 7 counts, day 8 does not, and an already-passed deadline is
 * "past" rather than urgent.
 */
export function deadlineUrgency(
  deadlineTs: number | null,
  now: number,
): DeadlineUrgency {
  if (deadlineTs === null) return "none";
  const days = daysUntilDeadline(deadlineTs, now);
  if (days < 0) return "past";
  return days <= CLOSING_SOON_DAYS ? "soon" : "none";
}

export function isClosingSoon(deadlineTs: number | null, now: number): boolean {
  return deadlineUrgency(deadlineTs, now) === "soon";
}

/** Short deadline text: "today", "3d", "passed", or an absolute day. */
export function formatDeadline(deadlineTs: number | null, now: number): string {
  if (deadlineTs === null) return "—";
  const days = daysUntilDeadline(deadlineTs, now);
  if (days < 0) return "passed";
  if (days === 0) return "today";
  if (days <= CLOSING_SOON_DAYS) return `${days}d`;
  return format(new Date(deadlineTs), "d MMM");
}

// ---------------------------------------------------------------------------
// Status presentation
// ---------------------------------------------------------------------------

export const STATUS_LABELS: Record<AppStatus, string> = {
  NOT_APPLIED: "—",
  APPLIED: "applied",
  OA: "OA",
  PHONE_SCREEN: "phone",
  INTERVIEW: "interview",
  OFFER: "offer",
  REJECTED: "rejected",
  CLOSED: "closed",
  SKIPPED: "skipped",
};

/** Filter-menu wording, where "—" would be meaningless. */
export const STATUS_FILTER_LABELS: Record<AppStatus, string> = {
  ...STATUS_LABELS,
  NOT_APPLIED: "not applied",
};

/** Pipeline order, used for sorting the status column. */
export const STATUS_ORDER: AppStatus[] = [
  "NOT_APPLIED",
  "SKIPPED",
  "APPLIED",
  "OA",
  "PHONE_SCREEN",
  "INTERVIEW",
  "OFFER",
  "REJECTED",
  "CLOSED",
];

const STATUS_RANK: Record<AppStatus, number> = STATUS_ORDER.reduce(
  (acc, status, i) => {
    acc[status] = i;
    return acc;
  },
  {} as Record<AppStatus, number>,
);

/** Statuses that mean "this application is live", for the `applied` chip. */
const ACTIVE_STATUSES = new Set<AppStatus>([
  "APPLIED",
  "OA",
  "PHONE_SCREEN",
  "INTERVIEW",
  "OFFER",
]);

export function isTrackedApplied(status: AppStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

export type DeadlineFilter = "any" | "has" | "none";

export interface FilterState {
  /** Free text matched against company + role + location. */
  search: string;
  /** Both default to false: a fresh table shows neither pile. */
  showDisqualified: boolean;
  showDismissed: boolean;
  chipSaved: boolean;
  chipApplied: boolean;
  chipClosingSoon: boolean;
  chipHighScore: boolean;
  /** Empty means "no status filter". */
  statuses: AppStatus[];
  /** Empty means "no source filter". */
  sources: string[];
  minScore: number | null;
  maxScore: number | null;
  deadline: DeadlineFilter;
  /** Only rows whose posting text could not be fetched. */
  fetchIssuesOnly: boolean;
}

export const HIGH_SCORE_THRESHOLD = 60;

export const EMPTY_FILTER: FilterState = {
  search: "",
  showDisqualified: false,
  showDismissed: false,
  chipSaved: false,
  chipApplied: false,
  chipClosingSoon: false,
  chipHighScore: false,
  statuses: [],
  sources: [],
  minScore: null,
  maxScore: null,
  deadline: "any",
  fetchIssuesOnly: false,
};

/** True when anything at all narrows the default view (used to offer a reset). */
export function isFilterActive(filter: FilterState): boolean {
  return (
    filter.search.trim() !== "" ||
    filter.showDisqualified ||
    filter.showDismissed ||
    filter.chipSaved ||
    filter.chipApplied ||
    filter.chipClosingSoon ||
    filter.chipHighScore ||
    filter.statuses.length > 0 ||
    filter.sources.length > 0 ||
    filter.minScore !== null ||
    filter.maxScore !== null ||
    filter.deadline !== "any" ||
    filter.fetchIssuesOnly
  );
}

/** Every whitespace-separated token must appear somewhere in the haystack. */
export function matchesSearch(row: TableRow, search: string): boolean {
  const tokens = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((t) => row.haystack.includes(t));
}

export function makeRowPredicate(
  filter: FilterState,
  now: number,
): (row: TableRow) => boolean {
  const tokens = filter.search.toLowerCase().split(/\s+/).filter(Boolean);
  const statuses = filter.statuses.length ? new Set(filter.statuses) : null;
  const sources = filter.sources.length ? new Set(filter.sources) : null;

  return (row) => {
    // Disqualified and dismissed are hidden by default; each has its own toggle.
    if (row.disqualified && !filter.showDisqualified) return false;
    if (row.dismissed && !filter.showDismissed) return false;

    if (tokens.length && !tokens.every((t) => row.haystack.includes(t))) return false;

    if (filter.chipSaved && !row.saved) return false;
    if (filter.chipApplied && !isTrackedApplied(row.statusKey)) return false;
    if (filter.chipClosingSoon && !isClosingSoon(row.deadlineTs, now)) return false;
    if (filter.chipHighScore && (row.score ?? -Infinity) < HIGH_SCORE_THRESHOLD) {
      return false;
    }

    if (statuses && !statuses.has(row.statusKey)) return false;
    if (sources && !row.sources.some((s) => sources.has(s))) return false;

    // An unscored row cannot satisfy a minimum, and is not excluded by a maximum.
    if (filter.minScore !== null && (row.score ?? -Infinity) < filter.minScore) return false;
    if (filter.maxScore !== null && row.score !== null && row.score > filter.maxScore) {
      return false;
    }

    if (filter.deadline === "has" && row.deadlineTs === null) return false;
    if (filter.deadline === "none" && row.deadlineTs !== null) return false;

    if (filter.fetchIssuesOnly && fetchBadge(row.fetchStatus) === null) return false;

    return true;
  };
}

export function filterRows(
  rows: readonly TableRow[],
  filter: FilterState,
  now: number,
): TableRow[] {
  return rows.filter(makeRowPredicate(filter, now));
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

export type SortKey =
  | "rank"
  | "score"
  | "company"
  | "role"
  | "location"
  | "age"
  | "deadline"
  | "status"
  | "source";

export type SortDir = "asc" | "desc";

export interface SortState {
  key: SortKey;
  dir: SortDir;
}

/** The server hands rows back score-desc, which is rank ascending. */
export const DEFAULT_SORT: SortState = { key: "rank", dir: "asc" };

/**
 * Most columns read best descending on the first click (highest score, newest,
 * soonest deadline); the text columns read best ascending.
 */
const FIRST_DIR: Record<SortKey, SortDir> = {
  rank: "asc",
  score: "desc",
  company: "asc",
  role: "asc",
  location: "asc",
  age: "asc", // asc = newest first (smallest age)
  deadline: "asc", // asc = soonest first
  status: "asc",
  source: "asc",
};

export function nextSort(current: SortState, key: SortKey): SortState {
  if (current.key !== key) return { key, dir: FIRST_DIR[key] };
  return { key, dir: current.dir === "asc" ? "desc" : "asc" };
}

type Cmp = (a: TableRow, b: TableRow) => number;

/**
 * Nulls (unscored listings, listings with no deadline) always sort to the
 * bottom, in both directions. Flipping them to the top on a descending sort
 * would bury the rows the user actually wants to look at.
 */
function numericNullsLast(get: (row: TableRow) => number | null, dir: SortDir): Cmp {
  const sign = dir === "asc" ? 1 : -1;
  return (a, b) => {
    const av = get(a);
    const bv = get(b);
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return sign * (av - bv);
  };
}

function text(get: (row: TableRow) => string, dir: SortDir): Cmp {
  const sign = dir === "asc" ? 1 : -1;
  return (a, b) => sign * get(a).localeCompare(get(b), "en", { sensitivity: "base" });
}

export function comparatorFor(sort: SortState): Cmp {
  switch (sort.key) {
    case "rank":
      return numericNullsLast((r) => r.rank, sort.dir);
    case "score":
      return numericNullsLast((r) => r.score, sort.dir);
    case "company":
      return text((r) => r.company, sort.dir);
    case "role":
      return text((r) => r.title, sort.dir);
    case "location":
      return text((r) => r.location, sort.dir);
    // Age is a duration, not an instant: ascending means youngest first, which
    // is the newest timestamp. Negating keeps the column reading as "age".
    case "age":
      return numericNullsLast((r) => -r.ageTs, sort.dir);
    case "deadline":
      return numericNullsLast((r) => r.deadlineTs, sort.dir);
    case "status":
      return numericNullsLast((r) => STATUS_RANK[r.statusKey], sort.dir);
    case "source":
      return text((r) => [...r.sources].sort().join(","), sort.dir);
  }
}

/** Sorts a copy. Ties always fall back to rank, so the order never wobbles. */
export function sortRows(rows: readonly TableRow[], sort: SortState): TableRow[] {
  const cmp = comparatorFor(sort);
  return [...rows].sort((a, b) => cmp(a, b) || a.rank - b.rank);
}

export function visibleRows(
  rows: readonly TableRow[],
  filter: FilterState,
  sort: SortState,
  now: number,
): TableRow[] {
  return sortRows(filterRows(rows, filter, now), sort);
}

// ---------------------------------------------------------------------------
// Optimistic overlay
// ---------------------------------------------------------------------------

/**
 * Pending keystroke mutations are held as a patch per listing so a key press
 * shows instantly and can be reverted verbatim if the Server Action fails.
 */
export interface RowPatch {
  status?: AppStatus | null;
  saved?: boolean;
  dismissed?: boolean;
}

export type PatchMap = Record<string, RowPatch>;

export function applyPatches(rows: readonly TableRow[], patches: PatchMap): TableRow[] {
  if (Object.keys(patches).length === 0) return rows as TableRow[];
  return rows.map((row) => {
    const patch = patches[row.id];
    if (!patch) return row;
    const status = patch.status === undefined ? row.status : patch.status;
    return {
      ...row,
      status,
      statusKey: status ?? "NOT_APPLIED",
      saved: patch.saved ?? row.saved,
      dismissed: patch.dismissed ?? row.dismissed,
    };
  });
}

// ---------------------------------------------------------------------------
// Misc presentation helpers
// ---------------------------------------------------------------------------

/** Score colour band. Disqualified rows are handled separately by the row itself. */
export function scoreTone(score: number | null): "high" | "mid" | "low" | "none" {
  if (score === null) return "none";
  if (score >= 70) return "high";
  if (score >= 45) return "mid";
  return "low";
}

export function formatScore(score: number | null): string {
  return score === null ? "—" : String(Math.round(score));
}

/** "312 of 2,893" */
export function formatCount(shown: number, total: number): string {
  return `${shown.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}`;
}

/** Every source seen across the catalog, for the source filter menu. */
export function allSources(rows: readonly TableRow[]): string[] {
  const set = new Set<string>();
  for (const row of rows) for (const s of row.sources) set.add(s);
  return [...set].sort();
}
