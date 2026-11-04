import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  boardFromUrl,
  boardKey,
  feedUrl,
  isWantedInternship,
  normalizeBoardRecord,
  readFeed,
  termsFromTitle,
  type BoardRef,
} from "@/lib/ingestion/boards/feeds";
import { createJobBoardsAdapter, type JobBoardsDeps } from "@/lib/ingestion/adapters/job-boards";
import type { BoardCheck, WatchedBoard } from "@/lib/ingestion/boards/store";
import { extractRequisitionId } from "@/lib/ingestion/normalize";
import type { FetchContext, NormalizedListing } from "@/lib/ingestion/adapters/types";

// Real feed responses (Figma on Greenhouse, Palantir on Lever, Ramp on Ashby,
// captured 2026-11-04), trimmed to a handful of postings each: wanted
// internships next to the look-alikes the filter must drop.
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(`tests/fixtures/job-boards/${name}.json`, "utf8"));

const FIGMA: BoardRef = { ats: "greenhouse", slug: "figma" };
const PALANTIR: BoardRef = { ats: "lever", slug: "palantir" };
const RAMP: BoardRef = { ats: "ashby", slug: "ramp" };

function listingsOf(ref: BoardRef, company: string, name: string): NormalizedListing[] {
  return readFeed(ref, company, fixture(name)).kept.map((record) => {
    const result = normalizeBoardRecord(record);
    if (!result.ok) throw new Error(result.error);
    return result.listing;
  });
}

describe("boardFromUrl", () => {
  it.each([
    ["https://boards.greenhouse.io/stripe/jobs/123", { ats: "greenhouse", slug: "stripe" }],
    ["https://job-boards.greenhouse.io/figma/jobs/6143238004?gh_jid=1", { ats: "greenhouse", slug: "figma" }],
    ["https://boards.greenhouse.io/embed/job_app?for=cloudflare&token=9", { ats: "greenhouse", slug: "cloudflare" }],
    ["https://jobs.lever.co/palantir/3db7e40a-28e0-4ad1-96c5-93de5bc96aa9/apply", { ats: "lever", slug: "palantir" }],
    ["https://jobs.ashbyhq.com/ramp/acf6b28d-767f-483f-8ff2-114620cd7e04/application", { ats: "ashby", slug: "ramp" }],
  ])("reads the board from %s", (url, ref) => {
    expect(boardFromUrl(url)).toEqual(ref);
  });

  it.each([
    // A company careers page embedding Greenhouse names no board.
    "https://www.equipmentshare.com/careers/openings?gh_jid=8188474",
    "https://boards.greenhouse.io/embed/job_app?token=9",
    "https://example.com/jobs/1",
    "https://jobs.lever.co/",
    "https://jobs.lever.co/..%2Fadmin/x",
    "javascript:alert(1)",
    "not a url",
  ])("refuses %s", (url) => {
    expect(boardFromUrl(url)).toBeNull();
  });

  it("keys a board the same however its link is capitalized", () => {
    expect(boardKey({ ats: "lever", slug: "Palantir" })).toBe(boardKey(PALANTIR));
  });

  it("builds each system's public feed URL", () => {
    expect(feedUrl(FIGMA)).toBe("https://boards-api.greenhouse.io/v1/boards/figma/jobs?content=true");
    expect(feedUrl(PALANTIR)).toBe("https://api.lever.co/v0/postings/palantir?mode=json");
    expect(feedUrl(RAMP)).toBe("https://api.ashbyhq.com/posting-api/job-board/ramp?includeCompensation=true");
  });
});

describe("which postings are kept", () => {
  it.each([
    ["Software Engineer Intern (Summer 2027)", true],
    ["Software Engineering Intern, Backend", true],
    ["Data Engineer Intern (2027)", true],
    ["Software Engineer Co-op", true],
    ["Security Engineering Internship", true],
    // Words that merely contain "intern".
    ["Software Engineer, International", false],
    ["AI Engineer, Internal Tools", false],
    // Internships outside tech.
    ["Product Design Intern (2027)", false],
    ["Finance Operator Intern", false],
    // Another term.
    ["Software Engineer Intern (Fall 2026)", false],
    ["Software Engineer Intern, Winter 2027", false],
    ["Software Engineer Intern (2026)", false],
  ])("%s → %s", (title, kept) => {
    expect(isWantedInternship(title)).toBe(kept);
  });

  it("trusts the system's own internship flag when the title has none", () => {
    expect(isWantedInternship("Forward Deployed Software Engineer - AUS Government", true)).toBe(true);
    expect(isWantedInternship("Forward Deployed Software Engineer - AUS Government")).toBe(false);
  });

  it("reads the term from a title", () => {
    expect(termsFromTitle("SWE Intern - Summer '27")).toEqual(["Summer 2027"]);
    expect(termsFromTitle("Intern (Autumn 2026)")).toEqual(["Fall 2026"]);
    expect(termsFromTitle("Software Engineer Intern")).toEqual([]);
  });
});

describe("feeds", () => {
  it("Greenhouse: keeps the tech internships, on Greenhouse's own job URL", () => {
    const feed = readFeed(FIGMA, "Figma", fixture("greenhouse-figma"));
    expect(feed.total).toBe(5);
    const listings = listingsOf(FIGMA, "Figma", "greenhouse-figma");
    expect(listings.map((l) => l.title)).toEqual([
      "Data Engineer Intern (2027)",
      "Software Engineer Intern (Summer 2027)",
      "Software Engineer Intern (London, United Kingdom) (Summer 2027)",
    ]);
    const swe = listings[1];
    expect(swe).toMatchObject({
      source: "job-boards",
      sourceUid: "greenhouse:figma:6143238004",
      company: "Figma",
      url: "https://job-boards.greenhouse.io/figma/jobs/6143238004",
      locations: ["San Francisco, CA", "New York, NY"],
      terms: ["Summer 2027"],
      fetchedFromAts: "greenhouse",
      active: true,
    });
    // Entity-escaped HTML is decoded and stripped, not shown as markup.
    expect(swe.postingText!.length).toBeGreaterThan(1000);
    expect(swe.postingText).not.toMatch(/<\/?p>|&lt;/);
    expect(swe.postedAt).toBeInstanceOf(Date);
  });

  it("Lever: uses the commitment field, splits nothing it doesn't need to", () => {
    const listings = listingsOf(PALANTIR, "Palantir", "lever-palantir");
    expect(listings.map((l) => l.title).sort()).toEqual([
      "Forward Deployed Software Engineer - AUS Government",
      "Forward Deployed Software Engineer, Internship - AUS Government",
      "Software Engineer, Internship",
    ]);
    const swe = listings.find((l) => l.title === "Software Engineer, Internship")!;
    expect(swe.url).toMatch(/^https:\/\/jobs\.lever\.co\/palantir\/[0-9a-f-]{36}$/);
    expect(swe.locations).toEqual(["New York, NY"]);
    expect(swe.postingText).toContain("Software Engineer, Internship");
  });

  it("Ashby: keeps the listed internship, and includes its locations", () => {
    const listings = listingsOf(RAMP, "Ramp", "ashby-ramp");
    expect(listings).toHaveLength(1);
    expect(listings[0]).toMatchObject({
      title: "Software Engineering Intern, Backend",
      url: "https://jobs.ashbyhq.com/ramp/acf6b28d-767f-483f-8ff2-114620cd7e04",
      locations: ["New York, NY (HQ)"],
      fetchedFromAts: "ashby",
    });
    expect(listings[0].postingText!.length).toBeGreaterThan(500);
  });

  it("every URL yields the job id, so the same role from another source merges by it", () => {
    for (const l of [
      ...listingsOf(FIGMA, "Figma", "greenhouse-figma"),
      ...listingsOf(PALANTIR, "Palantir", "lever-palantir"),
      ...listingsOf(RAMP, "Ramp", "ashby-ramp"),
    ]) {
      expect(extractRequisitionId(l.url), l.url).toBe(l.sourceUid.split(":")[2]);
    }
  });

  it("a stored record rebuilds the same listing (the merge-split path)", () => {
    const [record] = readFeed(RAMP, "Ramp", fixture("ashby-ramp")).kept;
    const stored = JSON.parse(JSON.stringify(record));
    const again = normalizeBoardRecord(stored);
    expect(again.ok && again.listing.sourceUid).toBe("ashby:ramp:acf6b28d-767f-483f-8ff2-114620cd7e04");
    expect(normalizeBoardRecord({ ats: "workday", slug: "x", company: "X", job: {} }).ok).toBe(false);
  });

  it("one malformed posting is skipped, not fatal", () => {
    const feed = readFeed(FIGMA, "Figma", { jobs: [{ title: "Software Engineer Intern" }, { nonsense: true }] });
    expect(feed).toEqual({ total: 2, kept: [] });
  });
});

describe("job-boards adapter", () => {
  const boards: WatchedBoard[] = [
    { ats: "greenhouse", slug: "figma", key: "greenhouse:figma", companyName: "Figma" },
    { ats: "lever", slug: "palantir", key: "lever:palantir", companyName: "Palantir" },
    { ats: "ashby", slug: "ramp", key: "ashby:ramp", companyName: "Ramp" },
    { ats: "greenhouse", slug: "down", key: "greenhouse:down", companyName: "Down Co" },
    { ats: "greenhouse", slug: "moved", key: "greenhouse:moved", companyName: "Moved Co" },
  ];

  function json(body: unknown): Response {
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }

  function run(
    respond: (url: string) => Response | Promise<Response>,
    over: Partial<JobBoardsDeps> = {},
  ) {
    const recorded: BoardCheck[] = [];
    const fetched: string[] = [];
    const adapter = createJobBoardsAdapter({
      discover: async () => 0,
      loadBoards: async () => boards,
      leftAsIs: async () => ["lever:muted"],
      record: async (checks) => void recorded.push(...checks),
      sleep: async () => {},
      ...over,
    });
    const ctx: FetchContext = {
      fetch: (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
        fetched.push(url);
        return respond(url);
      }) as typeof fetch,
      userAgent: "test",
      now: new Date("2026-11-04T12:00:00Z"),
      log: () => {},
    };
    return { result: adapter.fetch(ctx), recorded, fetched };
  }

  const healthy = (url: string): Response => {
    if (url.includes("/boards/figma/")) return json(fixture("greenhouse-figma"));
    if (url.includes("/postings/palantir")) return json(fixture("lever-palantir"));
    if (url.includes("/job-board/ramp")) return json(fixture("ashby-ramp"));
    if (url.includes("/boards/down/")) return new Response("oops", { status: 503 });
    return new Response("{}", { status: 404 });
  };

  it("reads every board, records each check, and keeps failed boards' postings alive", async () => {
    const { result, recorded, fetched } = run(healthy);
    const { listings, unverified } = await result;
    expect(fetched).toHaveLength(5);
    expect(listings).toHaveLength(3 + 3 + 1);
    expect(recorded).toEqual(
      expect.arrayContaining([
        { key: "greenhouse:figma", status: "ok", total: 5, kept: 3 },
        { key: "ashby:ramp", status: "ok", total: 3, kept: 1 },
        { key: "greenhouse:down", status: "http_503" },
        { key: "greenhouse:moved", status: "http_404" },
      ]),
    );
    // Down for now: its postings stay. A board that no longer exists (404)
    // gives no such cover, so its postings can close. Muted boards stay too.
    expect(unverified).toEqual(["greenhouse:down:", "lever:muted:"]);
  });

  it("treats an HTML answer to a JSON request as a failed check", async () => {
    const { result, recorded } = run((url) =>
      url.includes("palantir")
        ? new Response("<html>busy</html>", { headers: { "content-type": "text/html" } })
        : healthy(url),
    );
    const { unverified } = await result;
    expect(recorded).toContainEqual({ key: "lever:palantir", status: "parse_failed" });
    expect(unverified).toContain("lever:palantir:");
  });

  it("fails the whole run when every board fails, so nothing is marked closed", async () => {
    const { result } = run(() => new Response("", { status: 503 }));
    await expect(result).rejects.toThrow(/all 5 board\(s\) failed/);
  });

  it("an empty watchlist is a quiet, successful run", async () => {
    const { result } = run(healthy, { loadBoards: async () => [] });
    await expect(result).resolves.toMatchObject({ listings: [], unverified: ["lever:muted:"] });
  });
});

describe("job-boards adapter: what must never fail the run", () => {
  function json(body: unknown): Response {
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }
  const ctxFor = (respond: (url: string) => Response): FetchContext => ({
    fetch: (async (input: string | URL | Request) =>
      String(input).endsWith("/robots.txt") ? new Response("", { status: 404 }) : respond(String(input))) as typeof fetch,
    userAgent: "test",
    now: new Date("2026-11-04T12:00:00Z"),
    log: () => {},
  });

  it("a malformed %-escape in a link is ignored, not thrown", () => {
    expect(boardFromUrl("https://jobs.ashbyhq.com/%E0%A4%A/x")).toBeNull();
  });

  it("a Lever posting with a null text field is skipped and kept alive, not fatal", async () => {
    const [good] = fixture("lever-palantir") as Array<Record<string, unknown>>;
    const weird = { ...good, id: "11111111-2222-3333-4444-555555555555", text: "Software Engineer Intern", additionalPlain: null, lists: [{ text: "x", content: 5 }] };
    const adapter = createJobBoardsAdapter({
      discover: async () => 0,
      loadBoards: async () => [{ ats: "lever", slug: "palantir", key: "lever:palantir", companyName: "Palantir" }],
      leftAsIs: async () => [],
      record: async () => {},
      sleep: async () => {},
    });
    const { unverified } = await adapter.fetch(ctxFor(() => json([weird])));
    expect(unverified).toEqual(["lever:palantir:11111111-2222-3333-4444-555555555555"]);
  });

  it("boards that all 404 are gone, not an outage: the run succeeds", async () => {
    const counted: boolean[] = [];
    const adapter = createJobBoardsAdapter({
      discover: async () => 0,
      loadBoards: async () => [{ ats: "greenhouse", slug: "typo", key: "greenhouse:typo", companyName: "Typo" }],
      leftAsIs: async () => [],
      record: async (_checks, _now, opts) => void counted.push(opts.countFailures),
      sleep: async () => {},
    });
    await expect(adapter.fetch(ctxFor(() => new Response("{}", { status: 404 })))).resolves.toMatchObject({ listings: [] });
    expect(counted).toEqual([true]);
  });

  it("an outage fails the run without moving any board toward a pause", async () => {
    const counted: boolean[] = [];
    const adapter = createJobBoardsAdapter({
      discover: async () => 0,
      loadBoards: async () => [{ ats: "greenhouse", slug: "figma", key: "greenhouse:figma", companyName: "Figma" }],
      leftAsIs: async () => [],
      record: async (_checks, _now, opts) => void counted.push(opts.countFailures),
      sleep: async () => {},
    });
    await expect(adapter.fetch(ctxFor(() => new Response("", { status: 502 })))).rejects.toThrow(/failed/);
    expect(counted).toEqual([false]);
  });
});
