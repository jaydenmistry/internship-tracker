import "dotenv/config";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  AdapterResult,
  NormalizedListing,
  SourceAdapter,
} from "@/lib/ingestion/adapters/types";

/**
 * End-to-end coverage of the cycle contract: ingest → provisional score →
 * detail fetch → final score → stage 2, and the `scoringConfigHash = null`
 * self-invalidation that ties those stages together.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

function listing(overrides: Partial<NormalizedListing> = {}): NormalizedListing {
  return {
    source: "fake",
    sourceUid: "uid-1",
    company: "Stripe",
    title: "Backend Software Engineer Intern",
    url: "https://boards.greenhouse.io/acme/jobs/4242",
    locations: ["Atlanta, GA"],
    remote: false,
    terms: ["Summer 2027"],
    degrees: [],
    active: true,
    companyFaangPlus: true,
    postedAt: new Date("2026-09-15T00:00:00Z"),
    raw: { id: "uid-1" },
    ...overrides,
  };
}

function fakeAdapter(listings: NormalizedListing[], id = "fake"): SourceAdapter {
  return {
    id,
    displayName: id,
    fetch: async (): Promise<AdapterResult> => ({ listings, rawPayload: "raw" }),
  };
}

/** Serves robots.txt + a Greenhouse posting with rich, skill-dense text. */
function detailFetchStub(postingText: string): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
    if (url.includes("boards-api.greenhouse.io")) {
      return new Response(
        JSON.stringify({
          id: 4242,
          title: "Backend Software Engineer Intern",
          content: postingText,
          application_deadline: null,
          requisition_id: "REQ-4242",
          location: { name: "Atlanta, GA" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe.skipIf(!hasDb)("full cycle (integration)", () => {
  let prisma: (typeof import("@/lib/db"))["prisma"];
  let runFullCycle: (typeof import("@/lib/cycle"))["runFullCycle"];

  beforeEach(async () => {
    ({ prisma } = await import("@/lib/db"));
    ({ runFullCycle } = await import("@/lib/cycle"));
    await prisma.statusEvent.deleteMany();
    await prisma.application.deleteMany();
    await prisma.llmAssessment.deleteMany();
    await prisma.listingSource.deleteMany();
    await prisma.listing.deleteMany();
    await prisma.company.deleteMany();
    await prisma.ingestRun.deleteMany();
  });

  const quiet = () => {};
  const now = new Date("2026-09-18T12:00:00Z");

  it("runs the stages in order and rescores what the detail fetch enriched", async () => {
    const richText =
      "&lt;p&gt;Work on distributed systems in Go and Python. You will use Docker, " +
      "Kubernetes and AWS to run backend infrastructure on Linux.&lt;/p&gt;";

    const summary = await runFullCycle({
      now,
      log: quiet,
      skipLlm: true,
      adapterOverride: [fakeAdapter([listing()])],
      fetchImpl: detailFetchStub(richText),
    });

    // The provisional pass scored it; the detail fetch enriched it; the final
    // pass picked it back up precisely because the fetch cleared the hash.
    expect(summary.provisional.scored).toBe(1);
    expect(summary.detail.fetched).toBe(1);
    expect(summary.final.scored).toBe(1);

    const l = await prisma.listing.findFirstOrThrow();
    expect(l.postingText).toContain("Kubernetes");
    expect(l.detailFetchStatus).toBe("ok");
    expect(l.scoringConfigHash).toBe(summary.final.configHash);

    // Tech-fit evidence now comes from real posting text, not just the title.
    const breakdown = l.scoreBreakdown as unknown as {
      techFit: { points: number; evidence: string[] };
    };
    expect(breakdown.techFit.points).toBeGreaterThan(0);
    expect(breakdown.techFit.evidence.join(" ")).not.toContain("title only");
  });

  it("re-runs cleanly: a second identical cycle leaves one listing and no duplicate work", async () => {
    const adapter = fakeAdapter([listing()]);
    const fetchImpl = detailFetchStub("&lt;p&gt;Go and Kubernetes backend work.&lt;/p&gt;");
    await runFullCycle({ now, log: quiet, skipLlm: true, adapterOverride: [adapter], fetchImpl });

    const second = await runFullCycle({
      now,
      log: quiet,
      skipLlm: true,
      adapterOverride: [adapter],
      fetchImpl,
    });

    expect(await prisma.listing.count()).toBe(1);
    // Nothing changed and the config is the same, so nothing needs rescoring.
    expect(second.provisional.scored).toBe(0);
    expect(second.final.scored).toBe(0);
  });

  it("disqualifies a listing that closes after it was already scored", async () => {
    const fetchImpl = detailFetchStub("&lt;p&gt;Go backend work.&lt;/p&gt;");
    await runFullCycle({
      now,
      log: quiet,
      skipLlm: true,
      adapterOverride: [fakeAdapter([listing()])],
      fetchImpl,
    });
    const before = await prisma.listing.findFirstOrThrow();
    expect(before.disqualified).toBe(false);
    expect(before.finalScore).toBeGreaterThan(0);

    // Next day the source no longer lists it → likelyClosed → must be DQ'd.
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    await runFullCycle({
      now: tomorrow,
      log: quiet,
      skipLlm: true,
      adapterOverride: [fakeAdapter([])],
      fetchImpl,
    });

    const after = await prisma.listing.findFirstOrThrow();
    expect(after.likelyClosed).toBe(true);
    expect(after.disqualified).toBe(true);
    expect(after.finalScore).toBe(0);
    expect(after.disqualifyReasons.join(" ")).toMatch(/clos/i);
  });

  it("lets freshness decay over time even when nothing about the listing changes", async () => {
    const adapter = fakeAdapter([listing()]);
    const fetchImpl = detailFetchStub("&lt;p&gt;Go backend work.&lt;/p&gt;");
    await runFullCycle({ now, log: quiet, skipLlm: true, adapterOverride: [adapter], fetchImpl });
    const fresh = await prisma.listing.findFirstOrThrow();

    // 60 days later the posting is much staler; the score must reflect that.
    const later = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
    const summary = await runFullCycle({
      now: later,
      log: quiet,
      skipLlm: true,
      adapterOverride: [adapter],
      fetchImpl,
    });

    expect(summary.provisional.scored).toBe(1);
    const stale = await prisma.listing.findFirstOrThrow();
    const freshBd = fresh.scoreBreakdown as unknown as { freshness: { points: number } };
    const staleBd = stale.scoreBreakdown as unknown as { freshness: { points: number } };
    expect(staleBd.freshness.points).toBeLessThan(freshBd.freshness.points);
    expect(stale.finalScore!).toBeLessThan(fresh.finalScore!);
  });

  it("keeps a source outage from mass-closing listings", async () => {
    const fetchImpl = detailFetchStub("&lt;p&gt;Go backend work.&lt;/p&gt;");
    await runFullCycle({
      now,
      log: quiet,
      skipLlm: true,
      adapterOverride: [fakeAdapter([listing()])],
      fetchImpl,
    });

    const failing: SourceAdapter = {
      id: "fake",
      displayName: "fake",
      fetch: async () => {
        throw new Error("source down");
      },
    };
    await runFullCycle({
      now: new Date(now.getTime() + 86400000),
      log: quiet,
      skipLlm: true,
      adapterOverride: [failing],
      fetchImpl,
    });

    const l = await prisma.listing.findFirstOrThrow();
    expect(l.likelyClosed).toBe(false);
    expect(l.disqualified).toBe(false);
  });
});
