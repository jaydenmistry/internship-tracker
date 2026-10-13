import {
  differenceInCalendarDays,
  differenceInHours,
  differenceInMinutes,
  format,
  parseISO,
} from "date-fns";
import type { AppStatus } from "@/generated/prisma/enums";
import { compareTerms } from "@/lib/listings/facets";
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

export interface TableRow extends Omit<ListingRow, "rank"> {
  /** 1-based global position, persisted on the listing by the scoring run —
   *  not derived from load order, so every tab agrees and a rescore can't make
   *  two views disagree. Filtering never renumbers it. Disqualified listings
   *  have no position; they sort to the end. */
  rank: number | null;
  /** How far this listing moved at its last rank change: positive = moved up.
   *  Null when there is nothing worth reporting — see `prepareRows`. */
  rankDelta: number | null;
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
  return rows.map((row) => ({
    ...row,
    rank: row.rank,
    // previousRank is where it moved FROM, so a smaller rank now means it rose.
    //
    // Suppressed unless the listing's own score moved. A rank is a position in
    // a field of ~1,600, so a listing that did not change at all still gets
    // shoved around by everything that did: on the real catalog 1,425 of 1,615
    // ranked listings (88%) carried a rank change, nearly all of them cascade.
    // An indicator that fires on 88% of rows tells the reader nothing, so the
    // arrow is reserved for listings that actually moved under their own power.
    rankDelta:
      row.rank !== null && row.previousRank !== null && row.scoreMoved
        ? row.previousRank - row.rank
        : null,
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

/**
 * Deadline filter. "week" / "twoWeeks" / "month" mean "closes within that many
 * days from today, not already passed".
 */
export type DeadlineFilter = "any" | "has" | "none" | "week" | "twoWeeks" | "month";

export const DEADLINE_FILTER_LABELS: Record<DeadlineFilter, string> = {
  any: "any",
  has: "has a deadline",
  none: "no deadline",
  week: "closes within 7 days",
  twoWeeks: "closes within 14 days",
  month: "closes within 30 days",
};

const DEADLINE_WINDOW_DAYS: Partial<Record<DeadlineFilter, number>> = {
  week: 7,
  twoWeeks: 14,
  month: 30,
};

/** "Posted within" choices, in days. */
export const POSTED_WITHIN_OPTIONS: Array<{ days: number; label: string }> = [
  { days: 1, label: "last 24 hours" },
  { days: 3, label: "last 3 days" },
  { days: 7, label: "last week" },
  { days: 14, label: "last 2 weeks" },
  { days: 30, label: "last month" },
];

/** Filter value meaning "the listing names no term at all". */
export const NO_TERM = "none";

/**
 * Every filter combines with AND. Inside one multi-select field (statuses,
 * sources, categories, terms) the options combine with OR: ticking "simplify"
 * and "intern-list" shows listings from either.
 */
export interface FilterState {
  /**
   * Free text matched against company + role + location. Every word must
   * appear; a word starting with "-" must NOT appear ("-amazon -contract").
   */
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
  /** Category groups (`categoryGroup`). Empty means any. */
  categories: string[];
  /** Terms such as "Summer 2027", or NO_TERM. Empty means any. */
  terms: string[];
  remoteOnly: boolean;
  usOnly: boolean;
  /** Substring of any of the listing's locations ("GA", "Atlanta", "New York"). */
  locationText: string;
  faangOnly: boolean;
  /** Posted (or first seen) within this many days. Null means any time. */
  postedWithinDays: number | null;
  minScore: number | null;
  maxScore: number | null;
  deadline: DeadlineFilter;
  /** Only rows with fetched posting text. */
  textOnly: boolean;
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
  categories: [],
  terms: [],
  remoteOnly: false,
  usOnly: false,
  locationText: "",
  faangOnly: false,
  postedWithinDays: null,
  minScore: null,
  maxScore: null,
  deadline: "any",
  textOnly: false,
  fetchIssuesOnly: false,
};

/** True when anything at all narrows the default view (used to offer a reset). */
export function isFilterActive(filter: FilterState): boolean {
  return describeFilters(filter).length > 0;
}

interface SearchTerms {
  include: string[];
  exclude: string[];
}

function parseSearch(search: string): SearchTerms {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const token of search.toLowerCase().split(/\s+/)) {
    if (!token || token === "-") continue;
    if (token.startsWith("-")) exclude.push(token.slice(1));
    else include.push(token);
  }
  return { include, exclude };
}

/** Every word must appear in the haystack; a "-word" must not. */
export function matchesSearch(row: TableRow, search: string): boolean {
  const { include, exclude } = parseSearch(search);
  return (
    include.every((t) => row.haystack.includes(t)) &&
    !exclude.some((t) => row.haystack.includes(t))
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function makeRowPredicate(
  filter: FilterState,
  now: number,
): (row: TableRow) => boolean {
  const { include, exclude } = parseSearch(filter.search);
  const statuses = filter.statuses.length ? new Set(filter.statuses) : null;
  const sources = filter.sources.length ? new Set(filter.sources) : null;
  const categories = filter.categories.length ? new Set(filter.categories) : null;
  const terms = filter.terms.length ? new Set(filter.terms) : null;
  const locationText = filter.locationText.trim().toLowerCase();
  const postedAfter =
    filter.postedWithinDays !== null ? now - filter.postedWithinDays * DAY_MS : null;
  const deadlineWindow = DEADLINE_WINDOW_DAYS[filter.deadline] ?? null;
  // A reversed range ("80 to 50") means the same thing as "50 to 80".
  const [minScore, maxScore] =
    filter.minScore !== null && filter.maxScore !== null && filter.minScore > filter.maxScore
      ? [filter.maxScore, filter.minScore]
      : [filter.minScore, filter.maxScore];

  return (row) => {
    // Disqualified and dismissed are hidden by default; each has its own toggle.
    if (row.disqualified && !filter.showDisqualified) return false;
    if (row.dismissed && !filter.showDismissed) return false;

    if (include.length && !include.every((t) => row.haystack.includes(t))) return false;
    if (exclude.length && exclude.some((t) => row.haystack.includes(t))) return false;

    if (filter.chipSaved && !row.saved) return false;
    if (filter.chipApplied && !isTrackedApplied(row.statusKey)) return false;
    if (filter.chipClosingSoon && !isClosingSoon(row.deadlineTs, now)) return false;
    if (filter.chipHighScore && (row.score ?? -Infinity) < HIGH_SCORE_THRESHOLD) {
      return false;
    }

    if (statuses && !statuses.has(row.statusKey)) return false;
    if (sources && !row.sources.some((s) => sources.has(s))) return false;
    if (categories && (row.category === null || !categories.has(row.category))) return false;
    if (terms) {
      const hit =
        row.terms.length === 0 ? terms.has(NO_TERM) : row.terms.some((t) => terms.has(t));
      if (!hit) return false;
    }

    if (filter.remoteOnly && !row.remote) return false;
    if (filter.usOnly && !row.inUS) return false;
    if (
      locationText &&
      !row.locationSearch.includes(locationText) &&
      !row.location.toLowerCase().includes(locationText)
    ) {
      return false;
    }
    if (filter.faangOnly && !row.faangPlus) return false;

    if (postedAfter !== null && row.ageTs < postedAfter) return false;

    // An unscored row cannot satisfy a minimum, and is not excluded by a maximum.
    if (minScore !== null && (row.score ?? -Infinity) < minScore) return false;
    if (maxScore !== null && row.score !== null && row.score > maxScore) {
      return false;
    }

    if (filter.deadline === "has" && row.deadlineTs === null) return false;
    if (filter.deadline === "none" && row.deadlineTs !== null) return false;
    if (deadlineWindow !== null) {
      if (row.deadlineTs === null) return false;
      const days = daysUntilDeadline(row.deadlineTs, now);
      if (days < 0 || days > deadlineWindow) return false;
    }

    if (filter.textOnly && !row.hasPostingText) return false;
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
// Facets — the options a multi-select offers, with live counts
// ---------------------------------------------------------------------------

export type FacetField = "statuses" | "sources" | "categories" | "terms";

export interface FacetOption {
  value: string;
  label: string;
  /** Rows this option would show, given every OTHER active filter. */
  count: number;
}

function facetValues(row: TableRow, field: FacetField): readonly string[] {
  switch (field) {
    case "statuses":
      return [row.statusKey];
    case "sources":
      return row.sources;
    case "categories":
      return row.category ? [row.category] : [];
    case "terms":
      return row.terms.length ? row.terms : [NO_TERM];
  }
}

export function facetLabel(field: FacetField, value: string): string {
  if (field === "statuses") return STATUS_FILTER_LABELS[value as AppStatus] ?? value;
  if (field === "terms" && value === NO_TERM) return "no term listed";
  return value;
}

/**
 * Options for one multi-select, each counted against every other active
 * filter — so the numbers say what ticking that box would add, the way a
 * shop's sidebar does. Every value in the catalog is listed (a zero count
 * still reads as "exists, but not with these filters"), plus any value the
 * filter already holds that the catalog no longer has, so it can be unticked.
 */
export function facetOptions(
  rows: readonly TableRow[],
  filter: FilterState,
  field: FacetField,
  now: number,
): FacetOption[] {
  const counts = new Map<string, number>();
  const others = makeRowPredicate({ ...filter, [field]: [] }, now);
  for (const row of rows) {
    const values = facetValues(row, field);
    const match = others(row);
    for (const value of values) {
      counts.set(value, (counts.get(value) ?? 0) + (match ? 1 : 0));
    }
  }
  for (const value of filter[field]) if (!counts.has(value)) counts.set(value, 0);

  const values = [...counts.keys()];
  if (field === "statuses") {
    values.sort(
      (a, b) => STATUS_ORDER.indexOf(a as AppStatus) - STATUS_ORDER.indexOf(b as AppStatus),
    );
  } else if (field === "terms") {
    values.sort((a, b) => (a === NO_TERM ? 1 : b === NO_TERM ? -1 : compareTerms(a, b)));
  } else {
    values.sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
  }
  return values.map((value) => ({
    value,
    label: facetLabel(field, value),
    count: counts.get(value) ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Active-filter summary — the removable pills under the toolbar
// ---------------------------------------------------------------------------

export interface ActiveFilter {
  /** Stable React key. */
  key: string;
  label: string;
  /** The filter with just this condition removed. */
  clear: (filter: FilterState) => FilterState;
}

function listLabel(field: FacetField, values: readonly string[]): string {
  const labels = values.map((v) => facetLabel(field, v));
  return labels.length <= 2 ? labels.join(" or ") : `${labels[0]} +${labels.length - 1} more`;
}

/** One entry per condition narrowing the default view, in toolbar order. */
export function describeFilters(filter: FilterState): ActiveFilter[] {
  const out: ActiveFilter[] = [];
  const add = (key: string, label: string, clear: Partial<FilterState>) =>
    out.push({ key, label, clear: (f) => ({ ...f, ...clear }) });

  if (filter.search.trim()) add("search", `search: “${filter.search.trim()}”`, { search: "" });
  if (filter.chipSaved) add("saved", "saved", { chipSaved: false });
  if (filter.chipApplied) add("applied", "applied", { chipApplied: false });
  if (filter.chipClosingSoon) add("closingSoon", "closing soon", { chipClosingSoon: false });
  if (filter.chipHighScore) {
    add("highScore", `score ≥ ${HIGH_SCORE_THRESHOLD}`, { chipHighScore: false });
  }

  const lists: Array<[FacetField, string]> = [
    ["statuses", "status"],
    ["sources", "source"],
    ["categories", "category"],
    ["terms", "term"],
  ];
  for (const [field, name] of lists) {
    if (filter[field].length) {
      add(field, `${name}: ${listLabel(field, filter[field])}`, { [field]: [] });
    }
  }

  if (filter.remoteOnly) add("remote", "remote only", { remoteOnly: false });
  if (filter.usOnly) add("us", "in the US", { usOnly: false });
  if (filter.locationText.trim()) {
    add("locationText", `location: “${filter.locationText.trim()}”`, { locationText: "" });
  }
  if (filter.faangOnly) add("faang", "FAANG+ only", { faangOnly: false });
  if (filter.postedWithinDays !== null) {
    const option = POSTED_WITHIN_OPTIONS.find((o) => o.days === filter.postedWithinDays);
    add("posted", `posted: ${option?.label ?? `last ${filter.postedWithinDays} days`}`, {
      postedWithinDays: null,
    });
  }
  if (filter.minScore !== null || filter.maxScore !== null) {
    const label =
      filter.minScore !== null && filter.maxScore !== null
        ? `score ${Math.min(filter.minScore, filter.maxScore)}–${Math.max(filter.minScore, filter.maxScore)}`
        : filter.minScore !== null
          ? `score ≥ ${filter.minScore}`
          : `score ≤ ${filter.maxScore}`;
    add("score", label, { minScore: null, maxScore: null });
  }
  if (filter.deadline !== "any") {
    add("deadline", `deadline: ${DEADLINE_FILTER_LABELS[filter.deadline]}`, { deadline: "any" });
  }
  if (filter.textOnly) add("text", "has posting text", { textOnly: false });
  if (filter.fetchIssuesOnly) add("fetch", "couldn't fetch", { fetchIssuesOnly: false });
  if (filter.showDisqualified) add("dq", "showing disqualified", { showDisqualified: false });
  if (filter.showDismissed) add("dismissed", "showing dismissed", { showDismissed: false });
  return out;
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

/** Unranked (disqualified) listings sort after every ranked one. */
const rankOrder = (r: number | null) => (r ?? Number.MAX_SAFE_INTEGER);

/** Sorts a copy. Ties always fall back to rank, so the order never wobbles. */
export function sortRows(rows: readonly TableRow[], sort: SortState): TableRow[] {
  const cmp = comparatorFor(sort);
  return [...rows].sort((a, b) => cmp(a, b) || rankOrder(a.rank) - rankOrder(b.rank));
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
// Sort presets — the toolbar's "Sort" menu
// ---------------------------------------------------------------------------

export interface SortPreset {
  label: string;
  sort: SortState;
}

/** Plain-language names for the sorts people actually reach for. Clicking a
 *  column header still works and can produce any key/direction pair. */
export const SORT_PRESETS: SortPreset[] = [
  { label: "Best match (rank)", sort: { key: "rank", dir: "asc" } },
  { label: "Newest first", sort: { key: "age", dir: "asc" } },
  { label: "Oldest first", sort: { key: "age", dir: "desc" } },
  { label: "Highest score", sort: { key: "score", dir: "desc" } },
  { label: "Deadline soonest", sort: { key: "deadline", dir: "asc" } },
  { label: "Company A–Z", sort: { key: "company", dir: "asc" } },
  { label: "Role A–Z", sort: { key: "role", dir: "asc" } },
  { label: "Location A–Z", sort: { key: "location", dir: "asc" } },
  { label: "Status", sort: { key: "status", dir: "asc" } },
  { label: "Source", sort: { key: "source", dir: "asc" } },
];

const SORT_KEY_NAMES: Record<SortKey, string> = {
  rank: "rank",
  score: "score",
  company: "company",
  role: "role",
  location: "location",
  age: "posted",
  deadline: "deadline",
  status: "status",
  source: "source",
};

export function sortLabel(sort: SortState): string {
  const preset = SORT_PRESETS.find((p) => p.sort.key === sort.key && p.sort.dir === sort.dir);
  if (preset) return preset.label;
  return `${SORT_KEY_NAMES[sort.key]} ${sort.dir === "asc" ? "▲" : "▼"}`;
}

// ---------------------------------------------------------------------------
// URL query — the view survives a reload, a bookmark, and a saved view
// ---------------------------------------------------------------------------

export interface TableView {
  filter: FilterState;
  sort: SortState;
}

const SORT_KEYS = new Set<SortKey>(Object.keys(FIRST_DIR) as SortKey[]);
const DEADLINE_FILTERS = new Set<DeadlineFilter>(
  Object.keys(DEADLINE_FILTER_LABELS) as DeadlineFilter[],
);
const STATUSES = new Set<AppStatus>(STATUS_ORDER);

/** One URL parameter per value (`source=a&source=b`), so values may hold commas. */
function list(params: URLSearchParams, key: string): string[] {
  return [...new Set(params.getAll(key).map((v) => v.trim()).filter(Boolean))]
    .map((v) => v.slice(0, 200))
    .slice(0, 50);
}

/** Every parameter `viewFromQuery` reads. Anything else in a URL is not a view. */
export const VIEW_QUERY_KEYS: ReadonlySet<string> = new Set([
  "q", "saved", "applied", "soon", "high", "status", "source", "cat", "term", "remote", "us",
  "loc", "faang", "posted", "min", "max", "deadline", "text", "fetch", "dq", "dismissed",
  "sort", "dir",
]);

function flag(params: URLSearchParams, key: string): boolean {
  return params.get(key) === "1";
}

function score(params: URLSearchParams, key: string): number | null {
  const raw = params.get(key);
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
}

/**
 * Builds a view from a query string. The URL is user-editable, so every value
 * is checked and anything unrecognised falls back to the default rather than
 * throwing.
 */
export function viewFromQuery(query: string | URLSearchParams): TableView {
  const params = typeof query === "string" ? new URLSearchParams(query) : query;
  const posted = Number(params.get("posted"));
  const deadline = params.get("deadline") as DeadlineFilter | null;
  const sortKey = params.get("sort") as SortKey | null;
  const dir = params.get("dir");

  const filter: FilterState = {
    search: (params.get("q") ?? "").slice(0, 200),
    showDisqualified: flag(params, "dq"),
    showDismissed: flag(params, "dismissed"),
    chipSaved: flag(params, "saved"),
    chipApplied: flag(params, "applied"),
    chipClosingSoon: flag(params, "soon"),
    chipHighScore: flag(params, "high"),
    statuses: list(params, "status").filter((s): s is AppStatus => STATUSES.has(s as AppStatus)),
    sources: list(params, "source"),
    categories: list(params, "cat"),
    terms: list(params, "term"),
    remoteOnly: flag(params, "remote"),
    usOnly: flag(params, "us"),
    locationText: (params.get("loc") ?? "").slice(0, 100),
    faangOnly: flag(params, "faang"),
    postedWithinDays:
      Number.isInteger(posted) && posted > 0 && posted <= 365 ? posted : null,
    minScore: score(params, "min"),
    maxScore: score(params, "max"),
    deadline: deadline && DEADLINE_FILTERS.has(deadline) ? deadline : "any",
    textOnly: flag(params, "text"),
    fetchIssuesOnly: flag(params, "fetch"),
  };

  const sort: SortState =
    sortKey && SORT_KEYS.has(sortKey)
      ? { key: sortKey, dir: dir === "asc" || dir === "desc" ? dir : FIRST_DIR[sortKey] }
      : DEFAULT_SORT;

  return { filter, sort };
}

/** The shortest query string for a view: defaults are left out entirely. */
export function viewToQuery({ filter, sort }: TableView): string {
  const params = new URLSearchParams();
  const setList = (key: string, values: readonly string[]) => {
    for (const value of values) params.append(key, value);
  };
  const setFlag = (key: string, on: boolean) => {
    if (on) params.set(key, "1");
  };

  if (filter.search.trim()) params.set("q", filter.search.trim());
  setFlag("saved", filter.chipSaved);
  setFlag("applied", filter.chipApplied);
  setFlag("soon", filter.chipClosingSoon);
  setFlag("high", filter.chipHighScore);
  setList("status", filter.statuses);
  setList("source", filter.sources);
  setList("cat", filter.categories);
  setList("term", filter.terms);
  setFlag("remote", filter.remoteOnly);
  setFlag("us", filter.usOnly);
  if (filter.locationText.trim()) params.set("loc", filter.locationText.trim());
  setFlag("faang", filter.faangOnly);
  if (filter.postedWithinDays !== null) params.set("posted", String(filter.postedWithinDays));
  if (filter.minScore !== null) params.set("min", String(filter.minScore));
  if (filter.maxScore !== null) params.set("max", String(filter.maxScore));
  if (filter.deadline !== "any") params.set("deadline", filter.deadline);
  setFlag("text", filter.textOnly);
  setFlag("fetch", filter.fetchIssuesOnly);
  setFlag("dq", filter.showDisqualified);
  setFlag("dismissed", filter.showDismissed);

  if (sort.key !== DEFAULT_SORT.key || sort.dir !== DEFAULT_SORT.dir) {
    params.set("sort", sort.key);
    params.set("dir", sort.dir);
  }
  return params.toString();
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

// ---------------------------------------------------------------------------
// Rank movement + disqualification badge
// ---------------------------------------------------------------------------

export interface RankMovement {
  /** "↑3" / "↓12" — rendered in the rank cell, not only in a tooltip. */
  text: string;
  direction: "up" | "down";
  /** Plain-language version for the tooltip and screen readers. */
  label: string;
}

/**
 * The rank-cell indicator, rendered from the delta `prepareRows` already
 * decided was worth reporting. Nothing at all for a listing that never moved
 * (0), has no previous rank, has no rank (disqualified), or moved only because
 * other listings did — `prepareRows` nulls that last case out.
 */
export function rankMovement(delta: number | null | undefined): RankMovement | null {
  if (delta === null || delta === undefined || delta === 0 || !Number.isFinite(delta)) {
    return null;
  }
  const n = Math.abs(Math.trunc(delta));
  if (n === 0) return null;
  return delta > 0
    ? { text: `↑${n}`, direction: "up", label: `moved up ${n} when its score last changed` }
    : { text: `↓${n}`, direction: "down", label: `moved down ${n} when its score last changed` };
}

export interface DqBadge {
  text: string;
  /** Every reason, so the tooltip never hides one behind "+1". */
  title: string;
}

/**
 * Badge for a disqualified row. One reason reads in full; several carry a
 * count so a listing excluded on two grounds is visibly different from one
 * excluded on either alone, and the tooltip lists them all.
 */
export function dqBadge(reasons: readonly string[]): DqBadge {
  const clean = reasons.map((r) => r.trim()).filter(Boolean);
  if (clean.length === 0) {
    return { text: "dq", title: "Disqualified by the scoring config" };
  }
  const title = `Disqualified — ${clean.join(" · ")}`;
  if (clean.length === 1) return { text: `dq: ${clean[0]}`, title };
  return { text: `dq ×${clean.length}: ${clean[0]} +${clean.length - 1}`, title };
}
