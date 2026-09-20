import { describe, expect, it } from "vitest";
import type { ListingRow } from "@/lib/listings/query";
import {
  applyPatches,
  CLOSING_SOON_DAYS,
  daysUntilDeadline,
  deadlineUrgency,
  EMPTY_FILTER,
  fetchBadge,
  filterRows,
  formatCount,
  formatDeadline,
  formatScore,
  isClosingSoon,
  isFilterActive,
  makeRowPredicate,
  matchesSearch,
  nextSort,
  prepareRows,
  relativeAge,
  safeHttpUrl,
  scoreTone,
  sortRows,
  visibleRows,
  type FilterState,
  type TableRow,
} from "@/app/listings/table-state";

/**
 * Pure behaviour of the main table: what is hidden by default, what each chip
 * and column filter means, where nulls sort, and how a failed posting fetch is
 * marked. These are the rules the user works against all day, so they are
 * pinned here rather than left to the rendered component.
 */

// Local-time constructors keep the calendar-day arithmetic timezone-independent.
const NOW = new Date(2026, 2, 10, 12, 0, 0).getTime();
const day = (offset: number, hour = 12) =>
  new Date(2026, 2, 10 + offset, hour, 0, 0).toISOString();

let seq = 0;

function listing(overrides: Partial<ListingRow> = {}): ListingRow {
  seq += 1;
  return {
    id: `listing-${seq}`,
    rank: seq,
    previousRank: null,
    scoreMoved: true,
    mergedCount: 0,
    company: "Acme",
    faangPlus: false,
    title: "Software Engineer Intern",
    location: "Atlanta, GA",
    locationCount: 1,
    allLocations: ["Atlanta, GA"],
    remote: false,
    url: "https://example.com/job",
    score: 50,
    llmAdjustment: null,
    postedAt: day(-3),
    firstSeen: day(-3),
    deadline: null,
    saved: false,
    dismissed: false,
    disqualified: false,
    disqualifyReasons: [],
    likelyClosed: false,
    sources: ["simplify"],
    status: null,
    hasPostingText: true,
    fetchStatus: "ok",
    ...overrides,
  };
}

function prep(...rows: Partial<ListingRow>[]): TableRow[] {
  return prepareRows(rows.map(listing));
}

function withFilter(patch: Partial<FilterState>): FilterState {
  return { ...EMPTY_FILTER, ...patch };
}

const ids = (rows: TableRow[]) => rows.map((r) => r.id);

// ---------------------------------------------------------------------------

describe("prepareRows", () => {
  it("carries the persisted rank instead of renumbering by load order", () => {
    // Rank is assigned by the scoring run and stored, so a client that loads a
    // filtered or differently-ordered slice still reports the same positions.
    const rows = prep(
      { score: 90, rank: 7 },
      { score: 80, rank: 12 },
      { score: 70, rank: 3 },
    );
    expect(rows.map((r) => r.rank)).toEqual([7, 12, 3]);
  });

  it("leaves a disqualified listing unranked", () => {
    const [row] = prep({ disqualified: true, rank: null, previousRank: 40 });
    expect(row.rank).toBeNull();
  });

  it("computes movement from previousRank, positive when the listing rose", () => {
    const [up, down, unmoved, fresh] = prep(
      { rank: 10, previousRank: 25 },
      { rank: 30, previousRank: 12 },
      { rank: 5, previousRank: 5 },
      { rank: 8, previousRank: null },
    );
    expect(up.rankDelta).toBe(15);
    expect(down.rankDelta).toBe(-18);
    expect(unmoved.rankDelta).toBe(0);
    expect(fresh.rankDelta).toBeNull();
  });

  it("folds a missing Application row into NOT_APPLIED", () => {
    const [a, b] = prep({ status: null }, { status: "OA" });
    expect(a.statusKey).toBe("NOT_APPLIED");
    expect(a.status).toBeNull();
    expect(b.statusKey).toBe("OA");
  });

  it("falls back to firstSeen when a posting has no posted date", () => {
    const [row] = prep({ postedAt: null, firstSeen: day(-5) });
    expect(row.ageTs).toBe(new Date(day(-5)).getTime());
  });

  it("builds a lowercase haystack from company, role and location", () => {
    const [row] = prep({ company: "Stripe", title: "Backend Intern", location: "NYC" });
    expect(row.haystack).toBe("stripe backend intern nyc");
  });

  it("leaves deadlineTs null when there is no deadline", () => {
    const [row] = prep({ deadline: null });
    expect(row.deadlineTs).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("sorting", () => {
  it("sorts by score descending, highest first", () => {
    const rows = prep({ score: 10 }, { score: 90 }, { score: 50 });
    expect(sortRows(rows, { key: "score", dir: "desc" }).map((r) => r.score)).toEqual([
      90, 50, 10,
    ]);
  });

  it("keeps null scores last in BOTH directions", () => {
    const rows = prep({ score: 10 }, { score: null }, { score: 90 });
    expect(sortRows(rows, { key: "score", dir: "desc" }).map((r) => r.score)).toEqual([
      90, 10, null,
    ]);
    expect(sortRows(rows, { key: "score", dir: "asc" }).map((r) => r.score)).toEqual([
      10, 90, null,
    ]);
  });

  it("keeps rows with no deadline last in BOTH directions", () => {
    const rows = prep(
      { deadline: day(20) },
      { deadline: null },
      { deadline: day(2) },
    );
    const asc = sortRows(rows, { key: "deadline", dir: "asc" });
    expect(asc.map((r) => r.deadlineTs === null)).toEqual([false, false, true]);
    expect(asc[0].deadlineTs).toBeLessThan(asc[1].deadlineTs!);

    const desc = sortRows(rows, { key: "deadline", dir: "desc" });
    expect(desc.map((r) => r.deadlineTs === null)).toEqual([false, false, true]);
    expect(desc[0].deadlineTs).toBeGreaterThan(desc[1].deadlineTs!);
  });

  it("sorts age ascending as newest-first, because age is a duration", () => {
    const rows = prep(
      { postedAt: day(-30) },
      { postedAt: day(-1) },
      { postedAt: day(-7) },
    );
    const asc = sortRows(rows, { key: "age", dir: "asc" });
    expect(asc.map((r) => r.ageTs)).toEqual(
      [...asc.map((r) => r.ageTs)].sort((a, b) => b - a),
    );
    const desc = sortRows(rows, { key: "age", dir: "desc" });
    expect(desc[0].ageTs).toBeLessThan(desc[2].ageTs);
  });

  it("sorts text columns case-insensitively", () => {
    const rows = prep({ company: "zeta" }, { company: "Alpha" }, { company: "middle" });
    expect(
      sortRows(rows, { key: "company", dir: "asc" }).map((r) => r.company),
    ).toEqual(["Alpha", "middle", "zeta"]);
  });

  it("sorts status along the application pipeline, not alphabetically", () => {
    const rows = prep(
      { status: "OFFER" },
      { status: null },
      { status: "APPLIED" },
      { status: "INTERVIEW" },
    );
    expect(
      sortRows(rows, { key: "status", dir: "asc" }).map((r) => r.statusKey),
    ).toEqual(["NOT_APPLIED", "APPLIED", "INTERVIEW", "OFFER"]);
  });

  it("sorts by the joined source list", () => {
    const rows = prep(
      { sources: ["simplify"] },
      { sources: ["intern-list"] },
      { sources: ["intern-list", "simplify"] },
    );
    expect(
      sortRows(rows, { key: "source", dir: "asc" }).map((r) => r.sources.join(",")),
    ).toEqual(["intern-list", "intern-list,simplify", "simplify"]);
  });

  it("breaks ties by rank so the order never wobbles", () => {
    const rows = prep({ score: 50, rank: 3 }, { score: 50, rank: 1 }, { score: 50, rank: 2 });
    const sorted = sortRows(rows, { key: "score", dir: "desc" });
    expect(sorted.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("sorts unranked listings after every ranked one on a tie", () => {
    const rows = prep(
      { score: 50, rank: null },
      { score: 50, rank: 2 },
      { score: 50, rank: 1 },
    );
    const sorted = sortRows(rows, { key: "score", dir: "desc" });
    expect(sorted.map((r) => r.rank)).toEqual([1, 2, null]);
  });

  it("does not mutate the input array", () => {
    const rows = prep({ score: 10 }, { score: 90 });
    const before = ids(rows);
    sortRows(rows, { key: "score", dir: "desc" });
    expect(ids(rows)).toEqual(before);
  });
});

describe("nextSort", () => {
  it("picks a sensible first direction per column", () => {
    expect(nextSort({ key: "rank", dir: "asc" }, "score")).toEqual({
      key: "score",
      dir: "desc",
    });
    expect(nextSort({ key: "rank", dir: "asc" }, "company")).toEqual({
      key: "company",
      dir: "asc",
    });
  });

  it("flips direction when the same column is clicked again", () => {
    expect(nextSort({ key: "score", dir: "desc" }, "score")).toEqual({
      key: "score",
      dir: "asc",
    });
    expect(nextSort({ key: "score", dir: "asc" }, "score")).toEqual({
      key: "score",
      dir: "desc",
    });
  });
});

// ---------------------------------------------------------------------------

describe("default view", () => {
  it("hides disqualified and dismissed listings", () => {
    const rows = prep(
      { id: "plain" },
      { disqualified: true, disqualifyReasons: ["requires PhD"] },
      { dismissed: true },
    );
    const shown = filterRows(rows, EMPTY_FILTER, NOW);
    expect(shown).toHaveLength(1);
    expect(shown[0].disqualified).toBe(false);
    expect(shown[0].dismissed).toBe(false);
  });

  it("reveals each pile only through its own toggle", () => {
    const rows = prep({}, { disqualified: true }, { dismissed: true });
    expect(filterRows(rows, withFilter({ showDisqualified: true }), NOW)).toHaveLength(2);
    expect(filterRows(rows, withFilter({ showDismissed: true }), NOW)).toHaveLength(2);
    expect(
      filterRows(rows, withFilter({ showDisqualified: true, showDismissed: true }), NOW),
    ).toHaveLength(3);
  });

  it("still hides a dismissed row when only disqualified are shown", () => {
    const rows = prep({ dismissed: true, disqualified: true });
    expect(filterRows(rows, withFilter({ showDisqualified: true }), NOW)).toHaveLength(0);
  });

  it("reports whether anything narrows the view", () => {
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
    expect(isFilterActive(withFilter({ search: "  " }))).toBe(false);
    expect(isFilterActive(withFilter({ chipSaved: true }))).toBe(true);
    expect(isFilterActive(withFilter({ minScore: 0 }))).toBe(true);
    expect(isFilterActive(withFilter({ deadline: "has" }))).toBe(true);
  });
});

describe("search", () => {
  const rows = prep(
    { company: "Stripe", title: "Backend Intern", location: "New York, NY" },
    { company: "Datadog", title: "Frontend Intern", location: "Boston, MA" },
    { company: "Acme", title: "Data Engineering Intern", location: "Remote" },
  );

  it("matches on company, role or location, case-insensitively", () => {
    expect(filterRows(rows, withFilter({ search: "STRIPE" }), NOW)).toHaveLength(1);
    expect(filterRows(rows, withFilter({ search: "frontend" }), NOW)).toHaveLength(1);
    expect(filterRows(rows, withFilter({ search: "boston" }), NOW)).toHaveLength(1);
  });

  it("requires every whitespace-separated token to match", () => {
    expect(filterRows(rows, withFilter({ search: "stripe backend" }), NOW)).toHaveLength(1);
    expect(filterRows(rows, withFilter({ search: "stripe boston" }), NOW)).toHaveLength(0);
  });

  it("treats an empty or whitespace-only query as no filter", () => {
    expect(filterRows(rows, withFilter({ search: "" }), NOW)).toHaveLength(3);
    expect(filterRows(rows, withFilter({ search: "   " }), NOW)).toHaveLength(3);
  });

  it("matches substrings, not just whole words", () => {
    expect(matchesSearch(rows[0], "trip")).toBe(true);
    expect(matchesSearch(rows[0], "zzz")).toBe(false);
  });
});

describe("chips", () => {
  const rows = prep(
    { id: "a", saved: true, score: 80 },
    { id: "b", status: "APPLIED", score: 30 },
    { id: "c", deadline: day(3), score: 70 },
    { id: "d", score: 20 },
    { id: "e", status: "REJECTED", score: 65 },
  );

  it("saved keeps only saved rows", () => {
    expect(filterRows(rows, withFilter({ chipSaved: true }), NOW).map((r) => r.saved)).toEqual([
      true,
    ]);
  });

  it("applied keeps live applications and excludes rejected/closed", () => {
    const shown = filterRows(rows, withFilter({ chipApplied: true }), NOW);
    expect(shown.map((r) => r.statusKey)).toEqual(["APPLIED"]);
  });

  it("closing soon keeps only deadlines inside the window", () => {
    const shown = filterRows(rows, withFilter({ chipClosingSoon: true }), NOW);
    expect(shown).toHaveLength(1);
    expect(shown[0].deadlineTs).not.toBeNull();
  });

  it("high score keeps 60 and above", () => {
    const shown = filterRows(rows, withFilter({ chipHighScore: true }), NOW);
    expect(shown.map((r) => r.score)).toEqual([80, 70, 65]);
  });

  it("combines chips with each other", () => {
    const shown = filterRows(
      rows,
      withFilter({ chipHighScore: true, chipSaved: true }),
      NOW,
    );
    expect(shown.map((r) => r.score)).toEqual([80]);
  });

  it("combines chips with the search box", () => {
    const mixed = prep(
      { company: "Stripe", saved: true, score: 90 },
      { company: "Stripe", saved: false, score: 90 },
      { company: "Datadog", saved: true, score: 90 },
    );
    const shown = filterRows(
      mixed,
      withFilter({ chipSaved: true, search: "stripe" }),
      NOW,
    );
    expect(shown).toHaveLength(1);
    expect(shown[0].company).toBe("Stripe");
    expect(shown[0].saved).toBe(true);
  });

  it("never resurrects a dismissed row just because a chip matches", () => {
    const hidden = prep({ saved: true, dismissed: true });
    expect(filterRows(hidden, withFilter({ chipSaved: true }), NOW)).toHaveLength(0);
  });
});

describe("column filters", () => {
  const rows = prep(
    { id: "a", status: "OA", sources: ["simplify"], score: 80, deadline: day(30) },
    { id: "b", status: null, sources: ["intern-list"], score: null, deadline: null },
    { id: "c", status: "OA", sources: ["simplify", "intern-list"], score: 40, deadline: null },
  );

  it("filters by status, with NOT_APPLIED meaning 'no Application row'", () => {
    expect(ids(filterRows(rows, withFilter({ statuses: ["OA"] }), NOW))).toEqual(["a", "c"]);
    expect(ids(filterRows(rows, withFilter({ statuses: ["NOT_APPLIED"] }), NOW))).toEqual([
      "b",
    ]);
  });

  it("filters by source, matching any of a listing's sources", () => {
    expect(ids(filterRows(rows, withFilter({ sources: ["intern-list"] }), NOW))).toEqual([
      "b",
      "c",
    ]);
  });

  it("applies a score minimum, with unscored rows failing it", () => {
    expect(ids(filterRows(rows, withFilter({ minScore: 50 }), NOW))).toEqual(["a"]);
  });

  it("applies a score maximum without discarding unscored rows", () => {
    expect(ids(filterRows(rows, withFilter({ maxScore: 50 }), NOW))).toEqual(["b", "c"]);
  });

  it("filters on deadline presence", () => {
    expect(ids(filterRows(rows, withFilter({ deadline: "has" }), NOW))).toEqual(["a"]);
    expect(ids(filterRows(rows, withFilter({ deadline: "none" }), NOW))).toEqual(["b", "c"]);
    expect(filterRows(rows, withFilter({ deadline: "any" }), NOW)).toHaveLength(3);
  });

  it("filters to listings whose posting text could not be fetched", () => {
    const mixed = prep(
      { id: "ok", fetchStatus: "ok" },
      { id: "never", fetchStatus: null },
      { id: "blocked", fetchStatus: "http_403" },
    );
    expect(ids(filterRows(mixed, withFilter({ fetchIssuesOnly: true }), NOW))).toEqual([
      "blocked",
    ]);
  });
});

describe("makeRowPredicate", () => {
  it("is a reusable predicate over single rows", () => {
    const [row] = prep({ saved: false });
    expect(makeRowPredicate(EMPTY_FILTER, NOW)(row)).toBe(true);
    expect(makeRowPredicate(withFilter({ chipSaved: true }), NOW)(row)).toBe(false);
  });
});

describe("visibleRows", () => {
  it("filters and then sorts in one pass", () => {
    const rows = prep(
      { id: "low", score: 10 },
      { id: "hidden", score: 99, dismissed: true },
      { id: "high", score: 90 },
    );
    expect(ids(visibleRows(rows, EMPTY_FILTER, { key: "score", dir: "desc" }, NOW))).toEqual(
      ["high", "low"],
    );
  });
});

// ---------------------------------------------------------------------------

describe("closing soon boundary", () => {
  const at = (offset: number, hour = 12) =>
    new Date(2026, 2, 10 + offset, hour, 0, 0).getTime();

  it("counts whole calendar days", () => {
    expect(daysUntilDeadline(at(0), NOW)).toBe(0);
    expect(daysUntilDeadline(at(7), NOW)).toBe(7);
  });

  it("includes today and day 7, and excludes day 8", () => {
    expect(isClosingSoon(at(0), NOW)).toBe(true);
    expect(isClosingSoon(at(CLOSING_SOON_DAYS), NOW)).toBe(true);
    expect(isClosingSoon(at(CLOSING_SOON_DAYS + 1), NOW)).toBe(false);
  });

  it("counts a deadline later today, and one earlier today, as today", () => {
    expect(isClosingSoon(at(0, 23), NOW)).toBe(true);
    expect(isClosingSoon(at(0, 1), NOW)).toBe(true);
  });

  it("treats a passed deadline as past, not urgent", () => {
    expect(isClosingSoon(at(-1), NOW)).toBe(false);
    expect(deadlineUrgency(at(-1), NOW)).toBe("past");
    expect(deadlineUrgency(at(3), NOW)).toBe("soon");
    expect(deadlineUrgency(at(90), NOW)).toBe("none");
    expect(deadlineUrgency(null, NOW)).toBe("none");
  });

  it("formats the deadline cell by urgency", () => {
    expect(formatDeadline(null, NOW)).toBe("—");
    expect(formatDeadline(at(0), NOW)).toBe("today");
    expect(formatDeadline(at(5), NOW)).toBe("5d");
    expect(formatDeadline(at(-2), NOW)).toBe("passed");
    expect(formatDeadline(at(40), NOW)).toMatch(/^\d+ [A-Z][a-z]{2}$/);
  });
});

describe("relativeAge", () => {
  const ago = (ms: number) => NOW - ms;

  it("compacts minutes, hours, days, months and years", () => {
    expect(relativeAge(ago(30_000), NOW)).toBe("now");
    expect(relativeAge(ago(5 * 60_000), NOW)).toBe("5m");
    expect(relativeAge(ago(3 * 3_600_000), NOW)).toBe("3h");
    expect(relativeAge(new Date(2026, 2, 7, 12).getTime(), NOW)).toBe("3d");
    expect(relativeAge(new Date(2025, 11, 10, 12).getTime(), NOW)).toBe("3mo");
    expect(relativeAge(new Date(2024, 2, 10, 12).getTime(), NOW)).toBe("2y");
  });
});

// ---------------------------------------------------------------------------

describe("fetchStatus badges", () => {
  it("shows nothing for a successful fetch", () => {
    expect(fetchBadge("ok")).toBeNull();
  });

  it("shows nothing when a fetch was never attempted", () => {
    // null is the quiet state — it must not read the same as a failure.
    expect(fetchBadge(null)).toBeNull();
    expect(fetchBadge(undefined)).toBeNull();
    expect(fetchBadge("")).toBeNull();
  });

  it("marks a bot-protected Workday posting loudly", () => {
    const badge = fetchBadge("http_403");
    expect(badge).not.toBeNull();
    expect(badge!.label).toContain("403");
    expect(badge!.tone).toBe("bad");
    expect(badge!.title).toMatch(/403/);
    expect(badge!.title.toLowerCase()).toContain("couldn't fetch");
  });

  it("marks robots and parse failures", () => {
    expect(fetchBadge("robots_denied")!.label).toContain("robots");
    expect(fetchBadge("parse_failed")!.label).toContain("parse");
  });

  it("names an unrecognised HTTP status rather than swallowing it", () => {
    const badge = fetchBadge("http_502");
    expect(badge!.label).toContain("502");
  });

  it("falls back to a generic badge that still names the raw status", () => {
    const badge = fetchBadge("some_new_failure");
    expect(badge).not.toBeNull();
    expect(badge!.title).toContain("some_new_failure");
  });
});

// ---------------------------------------------------------------------------

describe("safeHttpUrl", () => {
  it("passes http and https through", () => {
    expect(safeHttpUrl("https://jobs.example.com/x")).toBe("https://jobs.example.com/x");
    expect(safeHttpUrl("  http://example.com/y  ")).toBe("http://example.com/y");
  });

  it("rejects javascript:, data: and other non-http schemes", () => {
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("  JaVaScRiPt:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,<script>x</script>")).toBeNull();
    expect(safeHttpUrl("file:///etc/passwd")).toBeNull();
  });

  it("rejects relative and empty values", () => {
    expect(safeHttpUrl("/careers/123")).toBeNull();
    expect(safeHttpUrl("")).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("optimistic patches", () => {
  it("returns the same array when there is nothing pending", () => {
    const rows = prep({}, {});
    expect(applyPatches(rows, {})).toBe(rows);
  });

  it("applies saved and dismissed flags to the right row only", () => {
    const rows = prep({ id: "a" }, { id: "b" });
    const patched = applyPatches(rows, { a: { saved: true, dismissed: true } });
    expect(patched[0].saved).toBe(true);
    expect(patched[0].dismissed).toBe(true);
    expect(patched[1].saved).toBe(false);
  });

  it("keeps statusKey in step with an optimistic status change", () => {
    const rows = prep({ id: "a", status: null });
    const applied = applyPatches(rows, { a: { status: "APPLIED" } });
    expect(applied[0].statusKey).toBe("APPLIED");

    const undone = applyPatches(applied, { a: { status: null } });
    expect(undone[0].status).toBeNull();
    expect(undone[0].statusKey).toBe("NOT_APPLIED");
  });

  it("leaves untouched fields alone", () => {
    const rows = prep({ id: "a", status: "OA", saved: true });
    const patched = applyPatches(rows, { a: { dismissed: true } });
    expect(patched[0].statusKey).toBe("OA");
    expect(patched[0].saved).toBe(true);
  });

  it("patched rows are still filterable, so a dismiss hides the row at once", () => {
    const rows = prep({ id: "a" });
    const patched = applyPatches(rows, { a: { dismissed: true } });
    expect(filterRows(patched, EMPTY_FILTER, NOW)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("presentation helpers", () => {
  it("bands the score colour", () => {
    expect(scoreTone(null)).toBe("none");
    expect(scoreTone(85)).toBe("high");
    expect(scoreTone(50)).toBe("mid");
    expect(scoreTone(10)).toBe("low");
  });

  it("renders a missing score as an em dash and rounds the rest", () => {
    expect(formatScore(null)).toBe("—");
    expect(formatScore(72.4)).toBe("72");
  });

  it("formats the result count with thousands separators", () => {
    expect(formatCount(312, 2893)).toBe("312 of 2,893");
  });
});
