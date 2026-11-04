import { beforeEach, describe, expect, it } from "vitest";
import { hasTestDatabase } from "../db-url";
import type { AdapterResult, NormalizedListing, SourceAdapter } from "@/lib/ingestion/adapters/types";

// Real Prisma, fake adapters, no network: what the pipeline and the watchlist
// do with what the job-boards adapter reports.
const hasDb = hasTestDatabase();

const quiet = () => {};

function simplifyListing(overrides: Partial<NormalizedListing> = {}): NormalizedListing {
  return {
    source: "fake-simplify",
    sourceUid: "s-1",
    company: "Ramp",
    title: "Software Engineering Intern, Backend",
    // The same posting, reached through Ashby's application page.
    url: "https://jobs.ashbyhq.com/ramp/acf6b28d-767f-483f-8ff2-114620cd7e04/application",
    locations: ["New York, NY"],
    remote: false,
    terms: ["Summer 2027"],
    degrees: [],
    active: true,
    companyFaangPlus: false,
    raw: {},
    ...overrides,
  };
}

function boardListing(overrides: Partial<NormalizedListing> = {}): NormalizedListing {
  return {
    source: "job-boards",
    sourceUid: "ashby:ramp:acf6b28d-767f-483f-8ff2-114620cd7e04",
    company: "Ramp",
    title: "Software Engineering Intern, Backend",
    url: "https://jobs.ashbyhq.com/ramp/acf6b28d-767f-483f-8ff2-114620cd7e04",
    locations: ["New York, NY (HQ)"],
    remote: false,
    terms: [],
    degrees: [],
    postingText: "Build backend services in Go and Postgres.",
    fetchedFromAts: "ashby",
    active: true,
    companyFaangPlus: false,
    raw: {},
    ...overrides,
  };
}

function adapter(id: string, result: () => AdapterResult): SourceAdapter {
  return { id, displayName: id, fetch: async () => result() };
}

describe.skipIf(!hasDb)("job boards (integration)", () => {
  let prisma: (typeof import("@/lib/db"))["prisma"];
  let runIngestion: (typeof import("@/lib/ingestion/pipeline"))["runIngestion"];
  let store: typeof import("@/lib/ingestion/boards/store");

  beforeEach(async () => {
    ({ prisma } = await import("@/lib/db"));
    ({ runIngestion } = await import("@/lib/ingestion/pipeline"));
    store = await import("@/lib/ingestion/boards/store");
    await prisma.statusEvent.deleteMany();
    await prisma.application.deleteMany();
    await prisma.llmAssessment.deleteMany();
    await prisma.listingSource.deleteMany();
    await prisma.listing.deleteMany();
    await prisma.company.deleteMany();
    await prisma.ingestRun.deleteMany();
    await prisma.jobBoard.deleteMany();
  });

  it("merges a board's posting with the same role from a curated list, by job id", async () => {
    await runIngestion({
      adapterOverride: [
        adapter("fake-simplify", () => ({ listings: [simplifyListing()], rawPayload: "" })),
        adapter("job-boards", () => ({ listings: [boardListing()], rawPayload: "" })),
      ],
      skipDetail: true,
      log: quiet,
    });
    const listings = await prisma.listing.findMany({ include: { sources: true } });
    expect(listings).toHaveLength(1);
    expect(listings[0].sources.map((s) => s.source).sort()).toEqual(["fake-simplify", "job-boards"]);
    // The board's description was adopted.
    expect(listings[0].postingText).toContain("backend services");
  });

  it("a listing first found on a board is created already detail-fetched", async () => {
    const now = new Date("2026-11-04T12:00:00Z");
    await runIngestion({
      adapterOverride: [adapter("job-boards", () => ({ listings: [boardListing()], rawPayload: "" }))],
      skipDetail: true,
      now,
      log: quiet,
    });
    const listing = await prisma.listing.findFirstOrThrow();
    expect(listing).toMatchObject({ atsKind: "ashby", detailFetchStatus: "ok", detailFetchedAt: now });
  });

  it("keeps an unchecked board's postings open, and closes a checked board's vanished ones", async () => {
    const day1 = new Date("2026-11-03T12:00:00Z");
    const day2 = new Date("2026-11-04T12:00:00Z");
    const down = boardListing({
      sourceUid: "greenhouse:down:111",
      company: "Down Co",
      title: "Software Engineer Intern",
      url: "https://job-boards.greenhouse.io/down/jobs/111",
    });
    const gone = boardListing({
      sourceUid: "greenhouse:fine:222",
      company: "Fine Co",
      title: "Software Engineer Intern",
      url: "https://job-boards.greenhouse.io/fine/jobs/222",
    });
    await runIngestion({
      adapterOverride: [adapter("job-boards", () => ({ listings: [down, gone], rawPayload: "" }))],
      skipDetail: true,
      now: day1,
      log: quiet,
    });
    // Day 2: "down" failed to load; "fine" loaded and no longer lists 222.
    await runIngestion({
      adapterOverride: [
        adapter("job-boards", () => ({ listings: [], rawPayload: "", unverified: ["greenhouse:down:"] })),
      ],
      skipDetail: true,
      now: day2,
      log: quiet,
    });
    const byCompany = Object.fromEntries(
      (await prisma.listing.findMany({ include: { company: true } })).map((l) => [l.company.name, l.likelyClosed]),
    );
    expect(byCompany).toEqual({ "Down Co": false, "Fine Co": true });
  });

  it("discovers boards from apply links, once each, and never renames a watched one", async () => {
    await runIngestion({
      adapterOverride: [
        adapter("fake-simplify", () => ({
          listings: [
            simplifyListing(),
            simplifyListing({
              sourceUid: "s-2",
              company: "Figma",
              url: "https://boards.greenhouse.io/figma/jobs/6143238004",
            }),
            simplifyListing({
              sourceUid: "s-3",
              company: "Figma",
              title: "Data Engineer Intern",
              url: "https://job-boards.greenhouse.io/Figma/jobs/6178851004",
            }),
            simplifyListing({ sourceUid: "s-4", company: "Elsewhere", url: "https://elsewhere.com/careers/1" }),
          ],
          rawPayload: "",
        })),
      ],
      skipDetail: true,
      log: quiet,
    });
    expect(await store.discoverBoards()).toBe(2);
    expect(await store.discoverBoards()).toBe(0);
    const boards = await store.loadBoardsToCheck();
    expect(boards.map((b) => [b.key, b.companyName])).toEqual([
      ["ashby:ramp", "Ramp"],
      ["greenhouse:figma", "Figma"],
    ]);
  });

  it("a board added by hand takes the name its company already has in the catalog", async () => {
    await runIngestion({
      adapterOverride: [
        adapter("fake-simplify", () => ({
          listings: [simplifyListing({ company: "Scale AI", url: "https://job-boards.greenhouse.io/scaleai/jobs/4242" })],
          rawPayload: "",
        })),
      ],
      skipDetail: true,
      log: quiet,
    });
    expect(await store.addBoard("https://boards.greenhouse.io/ScaleAI", "Scaleai")).toEqual({
      ok: true,
      created: true,
      companyName: "Scale AI",
    });
  });

  it("a \"_\" in a board's name matches only itself when keeping postings alive", async () => {
    const day1 = new Date("2026-11-03T12:00:00Z");
    const mk = (slug: string, id: string) =>
      boardListing({
        sourceUid: `greenhouse:${slug}:${id}`,
        company: slug,
        title: "Software Engineer Intern",
        url: `https://job-boards.greenhouse.io/${slug}/jobs/${id}`,
      });
    await runIngestion({
      adapterOverride: [adapter("job-boards", () => ({ listings: [mk("a_b", "1"), mk("axb", "2")], rawPayload: "" }))],
      skipDetail: true,
      now: day1,
      log: quiet,
    });
    await runIngestion({
      adapterOverride: [adapter("job-boards", () => ({ listings: [], rawPayload: "", unverified: ["greenhouse:a_b:"] }))],
      skipDetail: true,
      now: new Date("2026-11-04T12:00:00Z"),
      log: quiet,
    });
    const closed = Object.fromEntries(
      (await prisma.listing.findMany({ include: { company: true } })).map((l) => [l.company.name, l.likelyClosed]),
    );
    expect(closed).toEqual({ a_b: false, axb: true });
  });

  it("adding by hand, muting, pausing after repeated failures, and retrying", async () => {
    const added = await store.addBoard("https://jobs.lever.co/scale-ai/abc", undefined);
    expect(added).toEqual({ ok: true, created: true, companyName: "Scale Ai" });
    expect(await store.addBoard("https://jobs.lever.co/Scale-AI", "Scale AI")).toEqual({
      ok: true,
      created: false,
      companyName: "Scale AI",
    });
    expect((await store.addBoard("https://example.com/jobs", undefined)).ok).toBe(false);

    const [row] = await store.listBoards();
    expect(row).toMatchObject({ key: "lever:scale-ai", companyName: "Scale AI", manual: true, muted: false });

    await store.setBoardMuted(row.id, true);
    expect(await store.loadBoardsToCheck()).toEqual([]);
    expect(await store.boardsLeftAsIs()).toEqual(["lever:scale-ai"]);
    await store.setBoardMuted(row.id, false);

    const now = new Date("2026-11-04T12:00:00Z");
    for (let i = 0; i < store.PAUSE_AFTER_FAILURES; i++) {
      await store.recordBoardChecks([{ key: row.key, status: "http_503" }], now);
    }
    expect(await store.loadBoardsToCheck()).toEqual([]);
    expect((await store.listBoards())[0]).toMatchObject({ paused: true, lastStatus: "http_503" });
    // Paused for being down, not gone: its postings are left as they are.
    expect(await store.boardsLeftAsIs()).toEqual(["lever:scale-ai"]);

    // An outage is recorded without counting toward the pause.
    await store.retryBoard(row.id);
    await store.recordBoardChecks([{ key: row.key, status: "fetch_failed" }], now, { countFailures: false });
    expect((await store.listBoards())[0]).toMatchObject({ paused: false, lastStatus: "fetch_failed" });
    await store.recordBoardChecks([{ key: row.key, status: "http_503" }], now);
    expect(await store.retryAllPaused()).toBe(0);
    expect(await store.loadBoardsToCheck()).toHaveLength(1);
    await store.recordBoardChecks([{ key: row.key, status: "ok", total: 40, kept: 3 }], now);
    expect((await store.listBoards())[0]).toMatchObject({
      paused: false,
      lastStatus: "ok",
      lastJobCount: 40,
      lastInternCount: 3,
    });
  });
});
