import { describe, expect, it } from "vitest";
import type { ListingRow } from "@/lib/listings/query";
import { categoryGroup, cleanTerms, compareTerms } from "@/lib/listings/facets";
import {
  MAX_VIEWS,
  parseSavedViews,
  ViewLimitError,
  withDefaultView,
  withViewDeleted,
  withViewSaved,
  type SavedView,
} from "@/lib/listings/views";
import {
  DEFAULT_SORT,
  describeFilters,
  EMPTY_FILTER,
  facetOptions,
  filterRows,
  isFilterActive,
  matchesSearch,
  NO_TERM,
  prepareRows,
  sortLabel,
  viewFromQuery,
  viewToQuery,
  type FilterState,
  type TableRow,
} from "@/app/listings/table-state";

/**
 * The richer listings filters: multi-select facets with live counts, location,
 * posted-within, deadline windows, search exclusions, the URL round trip that
 * lets a view survive a reload, and saved-view parsing.
 */

const NOW = new Date(2026, 2, 10, 12, 0, 0).getTime();
const day = (offset: number) => new Date(2026, 2, 10 + offset, 12, 0, 0).toISOString();

let seq = 0;
function row(overrides: Partial<ListingRow> = {}): ListingRow {
  seq += 1;
  return {
    id: `r${seq}`,
    rank: seq,
    previousRank: null,
    scoreMoved: false,
    mergedCount: 0,
    company: "Acme",
    faangPlus: false,
    title: "Software Engineer Intern",
    location: "Atlanta, GA",
    locationCount: 1,
    allLocations: ["Atlanta, GA"],
    locationSearch: "atlanta, ga",
    remote: false,
    inUS: true,
    category: "Software",
    terms: ["Summer 2027"],
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

const prep = (...rows: Partial<ListingRow>[]): TableRow[] => prepareRows(rows.map(row));
const f = (patch: Partial<FilterState>): FilterState => ({ ...EMPTY_FILTER, ...patch });
const ids = (rows: TableRow[]) => rows.map((r) => r.id);

describe("combining filters", () => {
  const rows = prep(
    { id: "simplify-new", sources: ["simplify"], postedAt: day(-1) },
    { id: "simplify-old", sources: ["simplify"], postedAt: day(-20) },
    { id: "internlist-new", sources: ["intern-list"], postedAt: day(-1) },
  );

  it("ANDs different filters: source = simplify AND posted in the last week", () => {
    expect(ids(filterRows(rows, f({ sources: ["simplify"], postedWithinDays: 7 }), NOW))).toEqual([
      "simplify-new",
    ]);
  });

  it("ORs the options ticked inside one filter", () => {
    expect(ids(filterRows(rows, f({ sources: ["simplify", "intern-list"] }), NOW))).toHaveLength(3);
  });

  it("falls back to firstSeen when a listing has no posted date", () => {
    const r = prep({ id: "x", postedAt: null, firstSeen: day(-2) });
    expect(filterRows(r, f({ postedWithinDays: 3 }), NOW)).toHaveLength(1);
    expect(filterRows(r, f({ postedWithinDays: 1 }), NOW)).toHaveLength(0);
  });
});

describe("category, term and location filters", () => {
  const rows = prep(
    { id: "swe", category: "Software", terms: ["Summer 2027"], allLocations: ["Atlanta, GA"], location: "Atlanta, GA" },
    { id: "ml", category: "AI/ML/Data", terms: ["Fall 2026", "Spring 2027"], allLocations: ["New York, NY"], locationSearch: "new york, ny", location: "New York, NY" },
    { id: "remote", category: null, terms: [], remote: true, location: "Remote", allLocations: [], locationSearch: "" },
    { id: "toronto", inUS: false, allLocations: ["Toronto, ON"], locationSearch: "toronto, on", location: "Toronto, ON" },
  );

  it("matches a category, never an uncategorised listing", () => {
    expect(ids(filterRows(rows, f({ categories: ["AI/ML/Data"] }), NOW))).toEqual(["ml"]);
  });

  it("matches any of a listing's terms, and NO_TERM matches listings with none", () => {
    expect(ids(filterRows(rows, f({ terms: ["Spring 2027"] }), NOW))).toEqual(["ml"]);
    expect(ids(filterRows(rows, f({ terms: [NO_TERM] }), NOW))).toEqual(["remote"]);
  });

  it("filters to remote and to US listings", () => {
    expect(ids(filterRows(rows, f({ remoteOnly: true }), NOW))).toEqual(["remote"]);
    expect(ids(filterRows(rows, f({ usOnly: true }), NOW))).not.toContain("toronto");
  });

  it("treats a reversed score range as the same range", () => {
    const r = prep({ id: "s70", score: 70 }, { id: "s40", score: 40 });
    expect(ids(filterRows(r, f({ minScore: 80, maxScore: 50 }), NOW))).toEqual(["s70"]);
    expect(describeFilters(f({ minScore: 80, maxScore: 50 }))[0].label).toBe("score 50–80");
  });

  it("matches location text against every location, case-insensitively", () => {
    expect(ids(filterRows(rows, f({ locationText: "new york" }), NOW))).toEqual(["ml"]);
    expect(ids(filterRows(rows, f({ locationText: " ga " }), NOW))).toEqual(["swe"]);
  });

  it("searches past the 8 locations the cell displays", () => {
    const many = Array.from({ length: 11 }, (_, i) => `City ${i}, TX`).concat("Atlanta, GA");
    const r = prep({ id: "big", allLocations: many.slice(0, 8), locationSearch: many.join(" | ").toLowerCase() });
    expect(filterRows(r, f({ locationText: "atlanta" }), NOW)).toHaveLength(1);
  });

  it("filters to FAANG+ companies", () => {
    const r = prep({ id: "big", faangPlus: true }, { id: "small" });
    expect(ids(filterRows(r, f({ faangOnly: true }), NOW))).toEqual(["big"]);
  });

  it("filters to listings with posting text", () => {
    const r = prep({ id: "text" }, { id: "none", hasPostingText: false });
    expect(ids(filterRows(r, f({ textOnly: true }), NOW))).toEqual(["text"]);
  });
});

describe("deadline windows", () => {
  const rows = prep(
    { id: "d3", deadline: day(3) },
    { id: "d10", deadline: day(10) },
    { id: "d25", deadline: day(25) },
    { id: "past", deadline: day(-1) },
    { id: "none", deadline: null },
  );

  it("includes deadlines inside the window and never past ones", () => {
    expect(ids(filterRows(rows, f({ deadline: "week" }), NOW))).toEqual(["d3"]);
    expect(ids(filterRows(rows, f({ deadline: "twoWeeks" }), NOW))).toEqual(["d3", "d10"]);
    expect(ids(filterRows(rows, f({ deadline: "month" }), NOW))).toEqual(["d3", "d10", "d25"]);
  });
});

describe("search exclusions", () => {
  const [amazon, stripe] = prep(
    { company: "Amazon", title: "Backend Intern" },
    { company: "Stripe", title: "Backend Intern" },
  );

  it("drops rows containing a -word", () => {
    expect(matchesSearch(amazon, "backend -amazon")).toBe(false);
    expect(matchesSearch(stripe, "backend -amazon")).toBe(true);
  });

  it("ignores a lone dash", () => {
    expect(matchesSearch(stripe, "backend -")).toBe(true);
  });
});

describe("facetOptions", () => {
  const rows = prep(
    { sources: ["simplify"], category: "Software" },
    { sources: ["simplify"], category: "Hardware" },
    { sources: ["intern-list"], category: "Software" },
    { sources: ["simplify"], category: "Software", disqualified: true },
  );

  it("counts each option against every OTHER active filter", () => {
    const options = facetOptions(rows, f({ categories: ["Software"], sources: ["simplify"] }), "sources", NOW);
    // Ignoring the source filter itself: Software rows are 1 simplify + 1 intern-list.
    expect(options).toEqual([
      { value: "intern-list", label: "intern-list", count: 1 },
      { value: "simplify", label: "simplify", count: 1 },
    ]);
  });

  it("respects the hidden piles, like the table does", () => {
    const options = facetOptions(rows, EMPTY_FILTER, "sources", NOW);
    expect(options.find((o) => o.value === "simplify")?.count).toBe(2);
  });

  it("keeps a selected value the catalog no longer has, so it can be unticked", () => {
    const options = facetOptions(rows, f({ sources: ["gone"] }), "sources", NOW);
    expect(options.map((o) => o.value)).toContain("gone");
  });

  it("orders terms by season and year, with 'no term' last", () => {
    const r = prep({ terms: ["Summer 2027"] }, { terms: ["Fall 2026"] }, { terms: [] }, { terms: ["Spring 2027"] });
    expect(facetOptions(r, EMPTY_FILTER, "terms", NOW).map((o) => o.value)).toEqual([
      "Fall 2026",
      "Spring 2027",
      "Summer 2027",
      NO_TERM,
    ]);
  });

  it("labels statuses in plain words", () => {
    const r = prep({ status: null }, { status: "OA" });
    expect(facetOptions(r, EMPTY_FILTER, "statuses", NOW).map((o) => o.label)).toEqual([
      "not applied",
      "OA",
    ]);
  });
});

describe("describeFilters", () => {
  it("is empty for the default view", () => {
    expect(describeFilters(EMPTY_FILTER)).toEqual([]);
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
  });

  it("names each condition and clears only that one", () => {
    const filter = f({ sources: ["simplify"], postedWithinDays: 7, minScore: 60 });
    const active = describeFilters(filter);
    expect(active.map((a) => a.label)).toEqual(["source: simplify", "posted: last week", "score ≥ 60"]);
    const cleared = active[0].clear(filter);
    expect(cleared.sources).toEqual([]);
    expect(cleared.postedWithinDays).toBe(7);
  });

  it("summarises long multi-selects", () => {
    const [item] = describeFilters(f({ terms: ["Summer 2027", "Fall 2026", "Spring 2027"] }));
    expect(item.label).toBe("term: Summer 2027 +2 more");
  });
});

describe("URL query round trip", () => {
  it("writes nothing for the default view", () => {
    expect(viewToQuery({ filter: EMPTY_FILTER, sort: DEFAULT_SORT })).toBe("");
    expect(viewFromQuery("")).toEqual({ filter: EMPTY_FILTER, sort: DEFAULT_SORT });
  });

  it("round-trips every field", () => {
    const filter: FilterState = {
      search: "backend -amazon",
      showDisqualified: true,
      showDismissed: true,
      chipSaved: true,
      chipApplied: true,
      chipClosingSoon: true,
      chipHighScore: true,
      statuses: ["NOT_APPLIED", "OA"],
      sources: ["simplify", "intern-list"],
      categories: ["AI/ML/Data"],
      terms: ["Summer 2027", NO_TERM],
      remoteOnly: true,
      usOnly: true,
      locationText: "GA",
      faangOnly: true,
      postedWithinDays: 7,
      minScore: 40,
      maxScore: 90,
      deadline: "twoWeeks",
      textOnly: true,
      fetchIssuesOnly: true,
    };
    const sort = { key: "age" as const, dir: "asc" as const };
    expect(viewFromQuery(viewToQuery({ filter, sort }))).toEqual({ filter, sort });
  });

  it("reads 'source = simplify, newest first' from a readable URL", () => {
    const { filter, sort } = viewFromQuery("source=simplify&sort=age&dir=asc");
    expect(filter.sources).toEqual(["simplify"]);
    expect(sort).toEqual({ key: "age", dir: "asc" });
    expect(sortLabel(sort)).toBe("Newest first");
  });

  it("ignores junk instead of throwing", () => {
    const { filter, sort } = viewFromQuery(
      "status=NOPE&status=OA&posted=-4&min=abc&max=500&deadline=soonish&sort=evil&dir=sideways",
    );
    expect(filter.statuses).toEqual(["OA"]);
    expect(filter.postedWithinDays).toBeNull();
    expect(filter.minScore).toBeNull();
    expect(filter.maxScore).toBe(100);
    expect(filter.deadline).toBe("any");
    expect(sort).toEqual(DEFAULT_SORT);
  });

  it("keeps a value containing a comma intact", () => {
    const view = { filter: f({ categories: ["Data Science, AI & ML"] }), sort: DEFAULT_SORT };
    expect(viewFromQuery(viewToQuery(view)).filter.categories).toEqual(["Data Science, AI & ML"]);
  });

  it("uses a column's natural direction when the URL omits it", () => {
    expect(viewFromQuery("sort=score").sort).toEqual({ key: "score", dir: "desc" });
  });
});

describe("facet helpers", () => {
  it("folds category spellings from different sources into one group", () => {
    expect(categoryGroup("Software Engineering")).toBe("Software");
    expect(categoryGroup("Software")).toBe("Software");
    expect(categoryGroup("Data Science, AI & Machine Learning")).toBe("AI/ML/Data");
    expect(categoryGroup("AI/ML/Data")).toBe("AI/ML/Data");
    expect(categoryGroup("Hardware Engineering")).toBe("Hardware");
    expect(categoryGroup("Product Management")).toBe("Product");
    expect(categoryGroup("Quantitative Finance")).toBe("Quant");
    expect(categoryGroup("Marketing")).toBe("Marketing");
    expect(categoryGroup("  ")).toBeNull();
    expect(categoryGroup(null)).toBeNull();
  });

  it("drops N/A and duplicate terms", () => {
    expect(cleanTerms(["N/A", "Summer 2027", " Summer 2027 ", "n/a", ""])).toEqual(["Summer 2027"]);
  });

  it("sorts terms chronologically", () => {
    expect(["Summer 2027", "Winter 2027", "Fall 2026", "Spring 2027"].sort(compareTerms)).toEqual([
      "Fall 2026",
      "Winter 2027",
      "Spring 2027",
      "Summer 2027",
    ]);
  });
});

describe("parseSavedViews", () => {
  it("keeps valid views, drops broken ones, and allows one default", () => {
    const views = parseSavedViews([
      { id: "a", name: "Backend", query: "cat=Software", isDefault: true },
      { id: "b", name: "", query: "", isDefault: false },
      { id: "c", name: "Fresh", query: "posted=1", isDefault: true },
      "nonsense",
    ]);
    expect(views.map((v) => [v.id, v.isDefault])).toEqual([
      ["a", true],
      ["c", false],
    ]);
  });

  it("treats a non-array as no views", () => {
    expect(parseSavedViews(null)).toEqual([]);
    expect(parseSavedViews({ a: 1 })).toEqual([]);
  });
});

describe("saved-view updates", () => {
  const v = (id: string, name: string, isDefault = false): SavedView => ({ id, name, query: "", isDefault });
  let n = 0;
  const newId = () => `new${++n}`;

  it("adds a new view", () => {
    expect(withViewSaved([v("a", "A")], { name: "B", query: "posted=1", isDefault: false }, newId)).toEqual([
      v("a", "A"),
      { id: "new1", name: "B", query: "posted=1", isDefault: false },
    ]);
  });

  it("overwrites a view of the same name, ignoring case, in place", () => {
    const out = withViewSaved([v("a", "Backend"), v("b", "Other")], { name: "backend", query: "cat=Software", isDefault: false }, newId);
    expect(out.map((x) => [x.id, x.name, x.query])).toEqual([
      ["a", "backend", "cat=Software"],
      ["b", "Other", ""],
    ]);
  });

  it("keeps the default when the default view is re-saved without the box ticked", () => {
    const out = withViewSaved([v("a", "Main", true)], { name: "Main", query: "q=x", isDefault: false }, newId);
    expect(out[0].isDefault).toBe(true);
  });

  it("allows only one default", () => {
    const out = withViewSaved([v("a", "A", true), v("b", "B")], { name: "B", query: "", isDefault: true }, newId);
    expect(out.map((x) => x.isDefault)).toEqual([false, true]);
    expect(withDefaultView(out, "a").map((x) => x.isDefault)).toEqual([true, false]);
    expect(withDefaultView(out, null).some((x) => x.isDefault)).toBe(false);
  });

  it("refuses a new view past the limit, but still updates an existing one", () => {
    const full = Array.from({ length: MAX_VIEWS }, (_, i) => v(`id${i}`, `View ${i}`));
    expect(() => withViewSaved(full, { name: "One more", query: "", isDefault: false }, newId)).toThrow(ViewLimitError);
    expect(withViewSaved(full, { name: "View 3", query: "q=y", isDefault: false }, newId)).toHaveLength(MAX_VIEWS);
  });

  it("deletes by id", () => {
    expect(withViewDeleted([v("a", "A"), v("b", "B")], "a").map((x) => x.id)).toEqual(["b"]);
  });
});
