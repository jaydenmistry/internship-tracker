import "dotenv/config";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { describeFetchStatus } from "@/lib/listings/detail";

const hasDb = Boolean(process.env.DATABASE_URL);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("describeFetchStatus", () => {
  it("says a failed fetch's score is text-independent and names the cause", () => {
    const info = describeFetchStatus("http_403", false);
    expect(info.failed).toBe(true);
    expect(info.label).toMatch(/403/);
    expect(info.detail).toMatch(/without posting text/);
  });

  it("does not treat 'never attempted' as a failure", () => {
    const info = describeFetchStatus(null, false);
    expect(info.failed).toBe(false);
    expect(info.label).toBe("Not fetched yet");
  });

  it("distinguishes text supplied by the source from a fetched page", () => {
    expect(describeFetchStatus(null, true).label).toBe("Text from source");
    expect(describeFetchStatus("ok", true).failed).toBe(false);
  });

  it("falls back sensibly for an unknown HTTP code", () => {
    const info = describeFetchStatus("http_502", false);
    expect(info.failed).toBe(true);
    expect(info.label).toBe("HTTP 502");
  });
});

describe.skipIf(!hasDb)("loadListingDetail (integration)", () => {
  let prisma: (typeof import("@/lib/db"))["prisma"];
  let loadListingDetail: (typeof import("@/lib/listings/detail"))["loadListingDetail"];
  let rescoreListings: (typeof import("@/lib/scoring/rescore"))["rescoreListings"];

  beforeEach(async () => {
    ({ prisma } = await import("@/lib/db"));
    ({ loadListingDetail } = await import("@/lib/listings/detail"));
    ({ rescoreListings } = await import("@/lib/scoring/rescore"));
    await prisma.statusEvent.deleteMany();
    await prisma.application.deleteMany();
    await prisma.llmAssessment.deleteMany();
    await prisma.listingSource.deleteMany();
    await prisma.listing.deleteMany();
    await prisma.company.deleteMany();
    await prisma.resume.deleteMany();
  });

  async function seed(opts: { postingText?: string | null; locations?: string[]; degrees?: string[] } = {}) {
    const company = await prisma.company.create({
      data: { name: "Stripe", normalizedName: `stripe-${Math.random()}`, faangPlus: true },
    });
    const text = opts.postingText === undefined ? "Build Go services on Kubernetes and AWS." : opts.postingText;
    return prisma.listing.create({
      data: {
        companyId: company.id,
        title: "Backend Software Engineer Intern",
        normalizedTitle: "backend software engineer intern",
        dedupKey: `stripe|backend|${Math.random()}`,
        url: "https://boards.greenhouse.io/stripe/jobs/1",
        locations: opts.locations ?? ["Atlanta, GA"],
        countries: (opts.locations ?? ["Atlanta, GA"]).some((l) => /Toronto/.test(l)) ? ["CA"] : ["US"],
        degrees: opts.degrees ?? [],
        terms: ["Summer 2027"],
        postingText: text,
        postingTextHash: text ? sha(text) : null,
        postedAt: new Date(),
        firstSeen: new Date(),
        lastSeen: new Date(),
      },
    });
  }

  it("returns null for an unknown id", async () => {
    expect(await loadListingDetail("does-not-exist")).toBeNull();
  });

  it("reports every component with contributions that sum to the score", async () => {
    const l = await seed();
    await rescoreListings({ skipLlm: true, log: () => {} });
    const d = (await loadListingDetail(l.id))!;

    expect(d.components.map((c) => c.name)).toEqual([
      "techFit",
      "roleType",
      "companyTier",
      "location",
      "freshness",
      "deadlineUrgency",
    ]);
    const sum = d.components.reduce((s, c) => s + c.contribution, 0);
    // Contributions are shown to 1dp, so allow rounding slack.
    expect(Math.abs(sum - (d.ruleScore ?? 0))).toBeLessThanOrEqual(1);
    expect(d.undisqualifiedScore).toBe(d.ruleScore);
    expect(d.components.find((c) => c.name === "techFit")!.evidence.length).toBeGreaterThan(0);
  });

  it("carries every disqualify reason, not just the first", async () => {
    const l = await seed({ locations: ["Toronto, ON, Canada"], degrees: ["PhD"] });
    await rescoreListings({ skipLlm: true, log: () => {} });
    const d = (await loadListingDetail(l.id))!;

    expect(d.disqualified).toBe(true);
    expect(d.disqualifyReasons.length).toBeGreaterThanOrEqual(2);
    expect(d.score).toBe(0);
    // It would have scored something had it not been disqualified.
    expect(d.undisqualifiedScore).toBeGreaterThan(0);
  });

  it("shows no LLM assessment when none ran, and ignores one for stale text", async () => {
    const l = await seed();
    expect((await loadListingDetail(l.id))!.llm).toBeNull();

    await prisma.llmAssessment.create({
      data: { listingId: l.id, textHash: "an-older-text-hash", adjustment: 9, rationale: "old", model: "m" },
    });
    expect((await loadListingDetail(l.id))!.llm).toBeNull();

    await prisma.llmAssessment.create({
      data: { listingId: l.id, textHash: l.postingTextHash!, adjustment: 4, rationale: "current", model: "m" },
    });
    expect((await loadListingDetail(l.id))!.llm).toMatchObject({ adjustment: 4, rationale: "current" });
  });

  it("resume match: no posting text", async () => {
    const l = await seed({ postingText: null });
    expect((await loadListingDetail(l.id))!.resumeMatch).toEqual({ state: "no-posting-text" });
  });

  it("resume match: no resume yet still lists the posting's keywords", async () => {
    const l = await seed();
    const rm = (await loadListingDetail(l.id))!.resumeMatch;
    expect(rm.state).toBe("no-resume");
    if (rm.state === "no-resume") {
      expect(rm.postingKeywords).toEqual(expect.arrayContaining(["Go", "Kubernetes", "AWS"]));
    }
  });

  it("resume match: hits and misses against the active resume", async () => {
    const l = await seed();
    await prisma.resume.create({ data: { filename: "r.pdf", text: "Built a Go service on Kubernetes." } });
    const rm = (await loadListingDetail(l.id))!.resumeMatch;
    expect(rm.state).toBe("matched");
    if (rm.state === "matched") {
      expect(rm.hits).toEqual(expect.arrayContaining(["Go", "Kubernetes"]));
      expect(rm.misses).toContain("AWS");
    }
  });

  it("includes the application with its chronological timeline", async () => {
    const l = await seed();
    const { setListingStatus, setListingNotes } = await import("@/lib/listings/mutations");
    await setListingStatus(l.id, "APPLIED", { now: new Date("2026-09-10T00:00:00Z") });
    await setListingStatus(l.id, "OA", { now: new Date("2026-09-12T00:00:00Z") });
    await setListingNotes(l.id, "HackerRank, 90 min");

    const d = (await loadListingDetail(l.id))!;
    expect(d.application?.status).toBe("OA");
    expect(d.application?.notes).toBe("HackerRank, 90 min");
    expect(d.application?.timeline.map((e) => e.toStatus)).toEqual(["APPLIED", "OA"]);
  });
});
