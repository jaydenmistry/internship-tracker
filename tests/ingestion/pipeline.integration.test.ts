import "dotenv/config";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  AdapterResult,
  NormalizedListing,
  SourceAdapter,
} from "@/lib/ingestion/adapters/types";

// These tests need the local dev database (`npx prisma dev` + .env). They are
// integration tests: real Prisma, fake adapters, no network.
const hasDb = Boolean(process.env.DATABASE_URL);

function listing(overrides: Partial<NormalizedListing> = {}): NormalizedListing {
  return {
    source: "fake-a",
    sourceUid: "uid-1",
    company: "Acme Corp",
    title: "Software Engineer Intern",
    url: "https://boards.greenhouse.io/acme/jobs/1111",
    locations: ["Atlanta, GA"],
    remote: false,
    terms: ["Summer 2027"],
    degrees: [],
    active: true,
    companyFaangPlus: false,
    raw: { id: "uid-1" },
    ...overrides,
  };
}

function fakeAdapter(id: string, listings: NormalizedListing[], rawPayload = "raw"): SourceAdapter {
  return {
    id,
    displayName: id,
    fetch: async (): Promise<AdapterResult> => ({ listings, rawPayload }),
  };
}

function failingAdapter(id: string): SourceAdapter {
  return {
    id,
    displayName: id,
    fetch: async () => {
      throw new Error("source exploded");
    },
  };
}

describe.skipIf(!hasDb)("ingestion pipeline (integration)", () => {
  // Imported lazily so the file can be collected even when sibling modules are
  // being authored in parallel.
  let prisma: (typeof import("@/lib/db"))["prisma"];
  let runIngestion: (typeof import("@/lib/ingestion/pipeline"))["runIngestion"];

  beforeEach(async () => {
    ({ prisma } = await import("@/lib/db"));
    ({ runIngestion } = await import("@/lib/ingestion/pipeline"));
    await prisma.statusEvent.deleteMany();
    await prisma.application.deleteMany();
    await prisma.llmAssessment.deleteMany();
    await prisma.listingSource.deleteMany();
    await prisma.listing.deleteMany();
    await prisma.company.deleteMany();
    await prisma.ingestRun.deleteMany();
  });

  const quiet = () => {};

  it("creates listings, companies, and per-source rows on a fresh run", async () => {
    const summary = await runIngestion({
      adapterOverride: [
        fakeAdapter("fake-a", [
          listing(),
          listing({
            sourceUid: "uid-2",
            company: "Globex",
            title: "Backend Intern",
            url: "https://jobs.lever.co/globex/aaaaaaaa-1111-2222-3333-444444444444",
          }),
        ]),
      ],
      skipDetail: true,
      log: quiet,
    });

    expect(summary.sources).toHaveLength(1);
    expect(summary.sources[0]).toMatchObject({ ok: true, itemsSeen: 2, itemsNew: 2 });
    expect(await prisma.listing.count()).toBe(2);
    expect(await prisma.company.count()).toBe(2);
    expect(await prisma.listingSource.count()).toBe(2);
    const run = await prisma.ingestRun.findFirstOrThrow();
    expect(run.ok).toBe(true);
    expect(run.rawGz).not.toBeNull();
    expect(run.rawSha256).toBeTruthy();
  });

  it("is idempotent: re-running the same payload updates instead of duplicating", async () => {
    const adapter = fakeAdapter("fake-a", [listing()]);
    const t1 = new Date("2026-09-18T06:00:00Z");
    const t2 = new Date("2026-09-19T06:00:00Z");
    await runIngestion({ adapterOverride: [adapter], skipDetail: true, log: quiet, now: t1 });
    const s2 = await runIngestion({ adapterOverride: [adapter], skipDetail: true, log: quiet, now: t2 });

    expect(s2.sources[0]).toMatchObject({ itemsNew: 0, itemsUpdated: 1 });
    expect(await prisma.listing.count()).toBe(1);
    const l = await prisma.listing.findFirstOrThrow();
    expect(l.firstSeen.toISOString()).toBe(t1.toISOString());
    expect(l.lastSeen.toISOString()).toBe(t2.toISOString());
    // Identical raw payload → gzip stored only once.
    const runs = await prisma.ingestRun.findMany({ orderBy: { startedAt: "asc" } });
    expect(runs[0].rawGz).not.toBeNull();
    expect(runs[1].rawGz).toBeNull();
    expect(runs[1].rawSha256).toBe(runs[0].rawSha256);
  });

  it("merges the same posting across sources and records the audit trail", async () => {
    await runIngestion({
      adapterOverride: [
        fakeAdapter("fake-a", [
          listing({ url: "https://boards.greenhouse.io/acme/jobs/1111" }),
        ]),
      ],
      skipDetail: true,
      log: quiet,
    });
    await runIngestion({
      adapterOverride: [
        fakeAdapter("fake-b", [
          listing({
            source: "fake-b",
            sourceUid: "b-77",
            // Aggregator URL: identity inconclusive vs the greenhouse URL.
            url: "https://jobright.ai/jobs/info/abc123",
          }),
        ]),
      ],
      skipDetail: true,
      log: quiet,
    });

    expect(await prisma.listing.count()).toBe(1);
    const l = await prisma.listing.findFirstOrThrow({ include: { sources: true } });
    expect(l.sources).toHaveLength(2);
    expect(l.mergedFrom).toHaveLength(1);
    expect(JSON.stringify(l.mergedFrom[0])).toContain("fake-b");
  });

  it("never merges two requisitions with differing comparable identities", async () => {
    await runIngestion({
      adapterOverride: [
        fakeAdapter("fake-a", [
          listing({ sourceUid: "uid-1", url: "https://careers.amd.com/jobs/91866?icims=1", company: "AMD", title: "Compiler Engineer Intern/Co-op" }),
          listing({ sourceUid: "uid-2", url: "https://careers.amd.com/jobs/91865?icims=1", company: "AMD", title: "Compiler Engineer Intern/Co-op" }),
        ]),
      ],
      skipDetail: true,
      log: quiet,
    });

    expect(await prisma.listing.count()).toBe(2);
    expect(await prisma.company.count()).toBe(1);
  });

  it("flags likely-closed only when every source succeeds", async () => {
    const t1 = new Date("2026-09-18T06:00:00Z");
    const t2 = new Date("2026-09-19T06:00:00Z");
    const t3 = new Date("2026-09-20T06:00:00Z");
    await runIngestion({
      adapterOverride: [fakeAdapter("fake-a", [listing()])],
      skipDetail: true,
      log: quiet,
      now: t1,
    });

    // Listing disappears, but the OTHER adapter failed → no likely-closed pass.
    let s = await runIngestion({
      adapterOverride: [fakeAdapter("fake-a", []), failingAdapter("fake-b")],
      skipDetail: true,
      log: quiet,
      now: t2,
    });
    expect(s.likelyClosed).toBe(0);
    expect((await prisma.listing.findFirstOrThrow()).likelyClosed).toBe(false);

    // All adapters succeed and the listing is still gone → flagged, not deleted.
    s = await runIngestion({
      adapterOverride: [fakeAdapter("fake-a", [])],
      skipDetail: true,
      log: quiet,
      now: t3,
    });
    expect(s.likelyClosed).toBe(1);
    const l = await prisma.listing.findFirstOrThrow();
    expect(l.likelyClosed).toBe(true);

    // …and it comes back when the source lists it again.
    await runIngestion({
      adapterOverride: [fakeAdapter("fake-a", [listing()])],
      skipDetail: true,
      log: quiet,
    });
    expect((await prisma.listing.findFirstOrThrow()).likelyClosed).toBe(false);
  });

  it("persists the raw payload even when the adapter crashes after fetching", async () => {
    const crashingAfterFetch: SourceAdapter = {
      id: "fake-crash",
      displayName: "fake-crash",
      fetch: async (ctx) => {
        await ctx.saveRaw?.("payload-before-parse");
        throw new Error("parser exploded");
      },
    };
    const summary = await runIngestion({
      adapterOverride: [crashingAfterFetch],
      skipDetail: true,
      log: quiet,
    });
    expect(summary.sources[0]).toMatchObject({ ok: false });
    const run = await prisma.ingestRun.findFirstOrThrow({ where: { source: "fake-crash" } });
    expect(run.ok).toBe(false);
    expect(run.error).toContain("parser exploded");
    expect(run.rawGz).not.toBeNull();
    expect(run.rawSha256).toBeTruthy();
  });

  it("records adapter failures on IngestRun and continues with other sources", async () => {
    const summary = await runIngestion({
      adapterOverride: [failingAdapter("fake-bad"), fakeAdapter("fake-a", [listing()])],
      skipDetail: true,
      log: quiet,
    });
    expect(summary.sources.find((s) => s.source === "fake-bad")).toMatchObject({ ok: false });
    expect(summary.sources.find((s) => s.source === "fake-a")).toMatchObject({ ok: true });
    const bad = await prisma.ingestRun.findFirstOrThrow({ where: { source: "fake-bad" } });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("source exploded");
    expect(await prisma.listing.count()).toBe(1);
  });

  it("runs the detail stage and records fetch status", async () => {
    const fetchStub: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (url.includes("boards-api.greenhouse.io")) {
        return new Response(
          JSON.stringify({
            id: 1111,
            title: "Software Engineer Intern",
            content: "&lt;p&gt;Build Go and TypeScript services.&lt;/p&gt;",
            application_deadline: null,
            requisition_id: "SWE-1111",
            location: { name: "Atlanta, GA" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    };

    await runIngestion({
      adapterOverride: [fakeAdapter("fake-a", [listing()])],
      fetchImpl: fetchStub,
      log: quiet,
    });

    const l = await prisma.listing.findFirstOrThrow();
    expect(l.detailFetchedAt).not.toBeNull();
    expect(l.atsKind).toBe("greenhouse");
    expect(l.detailFetchStatus).toBe("ok");
    expect(l.postingText).toContain("Go and TypeScript");
  });
});
