import { beforeEach, describe, expect, it } from "vitest";
import { hasTestDatabase } from "../db-url";
import type { AdapterResult, NormalizedListing, SourceAdapter } from "@/lib/ingestion/adapters/types";

// Real Prisma, fake adapters, no network: where a jobright listing's Apply
// link points, and how the employer's link replaces jobright's.
const hasDb = hasTestDatabase();

const quiet = () => {};

const JOBRIGHT = "https://jobright.ai/jobs/info/6aad91e7de327d3e210d33d9";

function jobrightListing(overrides: Partial<NormalizedListing> = {}): NormalizedListing {
  return {
    source: "fake-intern-list",
    sourceUid: "6aad91e7de327d3e210d33d9",
    company: "Together AI",
    title: "Research Intern, Frontier Agents",
    url: JOBRIGHT,
    locations: ["San Francisco, CA"],
    remote: false,
    terms: ["Summer 2027"],
    degrees: [],
    active: true,
    companyFaangPlus: false,
    raw: {},
    ...overrides,
  };
}

function atsListing(overrides: Partial<NormalizedListing> = {}): NormalizedListing {
  return jobrightListing({
    source: "fake-simplify",
    sourceUid: "s-1",
    url: "https://job-boards.greenhouse.io/togetherai/jobs/4977391007?utm_source=Simplify",
    ...overrides,
  });
}

function adapter(id: string, result: () => AdapterResult): SourceAdapter {
  return { id, displayName: id, fetch: async () => result() };
}

describe.skipIf(!hasDb)("apply links for jobright listings (integration)", () => {
  let prisma: (typeof import("@/lib/db"))["prisma"];
  let runIngestion: (typeof import("@/lib/ingestion/pipeline"))["runIngestion"];
  let mutations: typeof import("@/lib/listings/mutations");
  let loadListingRows: (typeof import("@/lib/listings/query"))["loadListingRows"];

  const ingest = (...listings: NormalizedListing[]) =>
    runIngestion({
      adapterOverride: [...new Set(listings.map((l) => l.source))].map((source) =>
        adapter(source, () => ({ listings: listings.filter((l) => l.source === source), rawPayload: "" })),
      ),
      skipDetail: true,
      log: quiet,
    });

  beforeEach(async () => {
    ({ prisma } = await import("@/lib/db"));
    ({ runIngestion } = await import("@/lib/ingestion/pipeline"));
    mutations = await import("@/lib/listings/mutations");
    ({ loadListingRows } = await import("@/lib/listings/query"));
    await prisma.statusEvent.deleteMany();
    await prisma.application.deleteMany();
    await prisma.llmAssessment.deleteMany();
    await prisma.listingSource.deleteMany();
    await prisma.listing.deleteMany();
    await prisma.company.deleteMany();
    await prisma.ingestRun.deleteMany();
  });

  it("a jobright listing takes the employer's link when another source merges in", async () => {
    await ingest(jobrightListing());
    await ingest(atsListing());

    const [listing] = await prisma.listing.findMany();
    expect(listing).toMatchObject({
      url: "https://job-boards.greenhouse.io/togetherai/jobs/4977391007",
      requisitionId: "4977391007",
      detailFetchedAt: null,
    });
    const [row] = await loadListingRows();
    expect(row.url).toBe("https://job-boards.greenhouse.io/togetherai/jobs/4977391007");
    expect(row.jobrightUrl).toBe(JOBRIGHT);
  });

  it("a listing merged before this change picks the link up on its next refresh", async () => {
    await ingest(jobrightListing());
    await ingest(atsListing());
    // Put it back the way the old pipeline left it.
    await prisma.listing.updateMany({ data: { url: JOBRIGHT, requisitionId: null } });

    await ingest(atsListing());
    expect((await prisma.listing.findFirstOrThrow()).url).toBe(
      "https://job-boards.greenhouse.io/togetherai/jobs/4977391007",
    );
  });

  it("keeps the employer's link when jobright's record comes second", async () => {
    await ingest(atsListing());
    await ingest(jobrightListing());
    const [row] = await loadListingRows();
    expect(row.url).toBe("https://job-boards.greenhouse.io/togetherai/jobs/4977391007");
    expect(row.jobrightUrl).toBe(JOBRIGHT);
  });

  it("a listing with no jobright source has no jobright link", async () => {
    await ingest(atsListing());
    expect((await loadListingRows())[0].jobrightUrl).toBeNull();
  });

  it("a pasted employer link replaces jobright's, without jobright's jr_id", async () => {
    await ingest(jobrightListing());
    const listing = await prisma.listing.findFirstOrThrow();
    await mutations.setListingStatus(listing.id, "APPLIED");

    const result = await mutations.setListingApplyUrl(
      listing.id,
      "  https://jobs.lever.co/together/0b7c6f1e-1111-4a2b-9c3d-2e5f6a7b8c9d/apply?lever-origin=applied&jr_id=6aeb7e4765311d97105b936f ",
    );
    const clean = "https://jobs.lever.co/together/0b7c6f1e-1111-4a2b-9c3d-2e5f6a7b8c9d/apply?lever-origin=applied";
    expect(result).toEqual({ ok: true, url: clean });
    expect(await prisma.listing.findFirstOrThrow()).toMatchObject({ url: clean, detailFetchedAt: null });
    // The application that pointed at jobright follows.
    expect((await prisma.application.findFirstOrThrow()).applyUrl).toBe(clean);
    expect((await loadListingRows())[0].jobrightUrl).toBe(JOBRIGHT);
  });

  it("refuses a jobright link, a non-link, and a listing that already has a direct link", async () => {
    await ingest(jobrightListing());
    const { id } = await prisma.listing.findFirstOrThrow();
    expect((await mutations.setListingApplyUrl(id, `${JOBRIGHT}?jr_id=1`)).ok).toBe(false);
    expect((await mutations.setListingApplyUrl(id, "not a link")).ok).toBe(false);
    expect((await mutations.setListingApplyUrl(id, "javascript:alert(1)")).ok).toBe(false);

    await mutations.setListingApplyUrl(id, "https://together.ai/careers/123");
    expect((await mutations.setListingApplyUrl(id, "https://together.ai/careers/456")).ok).toBe(false);
    expect((await prisma.listing.findFirstOrThrow()).url).toBe("https://together.ai/careers/123");
  });
});
