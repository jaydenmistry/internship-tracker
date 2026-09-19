import "dotenv/config";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmClient } from "@/lib/scoring/llm";

// Integration tests for the scoring orchestration layer: real Prisma, real
// config file, mocked Anthropic client. Needs the local dev database.
const hasDb = Boolean(process.env.DATABASE_URL);

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** A client that returns a fixed adjustment and counts calls. */
function mockClient(adjustment: number, rationale = "Strong backend and infrastructure focus.") {
  const create = vi.fn(async () => ({
    content: [{ type: "text", text: JSON.stringify({ adjustment, rationale }) }],
    model: "mock-model",
  }));
  return { client: { messages: { create } } as unknown as LlmClient, create };
}

function failingClient() {
  const create = vi.fn(async () => {
    throw new Error("api exploded");
  });
  return { client: { messages: { create } } as unknown as LlmClient, create };
}

describe.skipIf(!hasDb)("scoring orchestration (integration)", () => {
  let prisma: (typeof import("@/lib/db"))["prisma"];
  let rescoreListings: (typeof import("@/lib/scoring/rescore"))["rescoreListings"];
  let orchestrationSettings: (typeof import("@/lib/scoring/rescore"))["orchestrationSettings"];
  let loadScoringConfig: (typeof import("@/lib/scoring/config"))["loadScoringConfig"];

  beforeEach(async () => {
    ({ prisma } = await import("@/lib/db"));
    ({ rescoreListings, orchestrationSettings } = await import("@/lib/scoring/rescore"));
    ({ loadScoringConfig } = await import("@/lib/scoring/config"));
    await prisma.statusEvent.deleteMany();
    await prisma.application.deleteMany();
    await prisma.llmAssessment.deleteMany();
    await prisma.listingSource.deleteMany();
    await prisma.listing.deleteMany();
    await prisma.company.deleteMany();
    await prisma.ingestRun.deleteMany();
  });

  const quiet = () => {};

  async function makeListing(
    opts: {
      title?: string;
      company?: string;
      faangPlus?: boolean;
      postingText?: string | null;
      locations?: string[];
      countries?: string[];
      remote?: boolean;
      degrees?: string[];
      likelyClosed?: boolean;
      postedAt?: Date | null;
      // Pre-set scoring state, to isolate stage 2 from stage 1.
      ruleScore?: number;
      scoringConfigHash?: string;
      disqualified?: boolean;
    } = {},
  ) {
    const name = opts.company ?? "Acme Corp";
    const normalizedName = name.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
    const company = await prisma.company.upsert({
      where: { normalizedName },
      create: { name, normalizedName, faangPlus: opts.faangPlus ?? false },
      update: {},
    });
    const title = opts.title ?? "Software Engineer Intern";
    const text = opts.postingText === undefined ? "Build Go services on Kubernetes." : opts.postingText;
    return prisma.listing.create({
      data: {
        companyId: company.id,
        title,
        normalizedTitle: title.toLowerCase(),
        dedupKey: `${normalizedName}|${title.toLowerCase()}|${Math.random()}`,
        locations: opts.locations ?? ["Atlanta, GA"],
        countries: opts.countries ?? ["US"],
        remote: opts.remote ?? false,
        url: `https://boards.greenhouse.io/acme/jobs/${Math.floor(Math.random() * 1e9)}`,
        terms: ["Summer 2027"],
        degrees: opts.degrees ?? [],
        postingText: text,
        postingTextHash: text ? sha256(text) : null,
        postedAt: opts.postedAt === undefined ? new Date() : opts.postedAt,
        firstSeen: new Date(),
        lastSeen: new Date(),
        likelyClosed: opts.likelyClosed ?? false,
        ...(opts.ruleScore !== undefined ? { ruleScore: opts.ruleScore, finalScore: opts.ruleScore } : {}),
        // A pre-stamped hash AND a fresh scoredAt are both needed to keep
        // stage 1 away: it also reclaims rows whose scores have aged out.
        ...(opts.scoringConfigHash
          ? { scoringConfigHash: opts.scoringConfigHash, scoredAt: new Date() }
          : {}),
        ...(opts.disqualified !== undefined ? { disqualified: opts.disqualified } : {}),
      },
    });
  }

  it("stage 1 scores every listing and stamps the config hash", async () => {
    await makeListing();
    await makeListing({ title: "Backend Infrastructure Intern" });

    const summary = await rescoreListings({ skipLlm: true, log: quiet });

    expect(summary.scored).toBe(2);
    const listings = await prisma.listing.findMany();
    for (const l of listings) {
      expect(l.ruleScore).not.toBeNull();
      expect(l.finalScore).toBe(l.ruleScore);
      expect(l.scoringConfigHash).toBe(summary.configHash);
      expect(l.scoredAt).not.toBeNull();
      expect(l.scoreBreakdown).toBeTruthy();
    }
  });

  it("skips listings already scored with the current config, and rescores when the hash changes", async () => {
    await makeListing();
    const first = await rescoreListings({ skipLlm: true, log: quiet });
    expect(first.scored).toBe(1);

    // Same config → nothing to do.
    const second = await rescoreListings({ skipLlm: true, log: quiet });
    expect(second.scored).toBe(0);

    // Simulating an edited config file: a different stored hash means stale.
    await prisma.listing.updateMany({ data: { scoringConfigHash: "stale-hash" } });
    const third = await rescoreListings({ skipLlm: true, log: quiet });
    expect(third.scored).toBe(1);
    expect(third.configHash).toBe(first.configHash);
  });

  it("scores every row when paginating, even though writes remove rows from the query", async () => {
    // Regression: Prisma's `cursor` cannot position itself once the cursor row
    // stops matching the filter, which silently skipped whole batches.
    for (let i = 0; i < 7; i += 1) await makeListing({ title: `Backend Intern ${i}` });

    const first = await rescoreListings({ skipLlm: true, batchSize: 2, log: quiet });
    expect(first.scored).toBe(7);
    expect(await prisma.listing.count({ where: { scoringConfigHash: null } })).toBe(0);

    const second = await rescoreListings({ skipLlm: true, batchSize: 2, log: quiet });
    expect(second.scored).toBe(0);
  });

  it("force rescores everything regardless of stored hash", async () => {
    await makeListing();
    await rescoreListings({ skipLlm: true, log: quiet });
    const forced = await rescoreListings({ skipLlm: true, force: true, log: quiet });
    expect(forced.scored).toBe(1);
  });

  it("disqualifies closed listings and zeroes their score while keeping the breakdown", async () => {
    await makeListing({ likelyClosed: true });
    await rescoreListings({ skipLlm: true, log: quiet });
    const l = await prisma.listing.findFirstOrThrow();
    expect(l.disqualified).toBe(true);
    expect(l.ruleScore).toBe(0);
    expect(l.finalScore).toBe(0);
    expect(l.disqualifyReasons.length).toBeGreaterThan(0);
    expect(l.scoreBreakdown).toBeTruthy();
  });

  it("stage 2 calls Claude for high scorers, caches by text hash, and applies the adjustment", async () => {
    const { config } = loadScoringConfig();
    const { llmMin } = orchestrationSettings(config);
    const hash = (await rescoreListings({ skipLlm: true, log: quiet })).configHash;

    // Pre-stamped so stage 1 leaves it alone: isolates stage-2 behavior.
    const listing = await makeListing({ ruleScore: llmMin + 1, scoringConfigHash: hash });

    const { client, create } = mockClient(10);
    const first = await rescoreListings({ llmClient: client, log: quiet });
    expect(create).toHaveBeenCalledTimes(1);
    expect(first.llmCalls).toBe(1);

    const scored = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(scored.llmAdjustment).toBe(10);
    expect(scored.finalScore).toBe(llmMin + 1 + 10);
    expect(await prisma.llmAssessment.count()).toBe(1);

    // Second run: unchanged text → cache hit, no new API call.
    const second = await rescoreListings({ llmClient: client, log: quiet });
    expect(create).toHaveBeenCalledTimes(1);
    expect(second.llmCacheHits).toBe(1);
    expect(second.llmCalls).toBe(0);
  });

  it("stage 2 skips listings with no posting text", async () => {
    const { config } = loadScoringConfig();
    const { llmMin } = orchestrationSettings(config);
    const hash = (await rescoreListings({ skipLlm: true, log: quiet })).configHash;
    await makeListing({ ruleScore: llmMin + 1, scoringConfigHash: hash, postingText: null });

    const { client, create } = mockClient(10);
    const summary = await rescoreListings({ llmClient: client, log: quiet });
    expect(create).not.toHaveBeenCalled();
    expect(summary.llmCalls).toBe(0);
  });

  it("stage 2 skips listings below the threshold and disqualified ones", async () => {
    const { config } = loadScoringConfig();
    const { llmMin } = orchestrationSettings(config);
    const hash = (await rescoreListings({ skipLlm: true, log: quiet })).configHash;
    await makeListing({ ruleScore: Math.max(0, llmMin - 5), scoringConfigHash: hash });
    await makeListing({ ruleScore: llmMin + 1, scoringConfigHash: hash, disqualified: true });

    const { client, create } = mockClient(10);
    await rescoreListings({ llmClient: client, log: quiet });
    expect(create).not.toHaveBeenCalled();
  });

  it("an LLM failure leaves the stage-1 score standing", async () => {
    const { config } = loadScoringConfig();
    const { llmMin } = orchestrationSettings(config);
    const hash = (await rescoreListings({ skipLlm: true, log: quiet })).configHash;
    const listing = await makeListing({ ruleScore: llmMin + 1, scoringConfigHash: hash });

    const { client } = failingClient();
    const summary = await rescoreListings({ llmClient: client, log: quiet });

    expect(summary.llmFailures).toBe(1);
    const l = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(l.llmAdjustment).toBeNull();
    expect(l.finalScore).toBe(llmMin + 1);
    expect(await prisma.llmAssessment.count()).toBe(0);
  });

  it("respects the per-run API call cap", async () => {
    const { config } = loadScoringConfig();
    const { llmMin } = orchestrationSettings(config);
    const hash = (await rescoreListings({ skipLlm: true, log: quiet })).configHash;
    for (let i = 0; i < 3; i += 1) {
      await makeListing({
        title: `Backend Intern ${i}`,
        ruleScore: llmMin + 1,
        scoringConfigHash: hash,
        postingText: `Distinct posting text ${i} about Go and Kubernetes.`,
      });
    }

    const { client, create } = mockClient(5);
    const summary = await rescoreListings({ llmClient: client, maxLlmCalls: 2, log: quiet });
    expect(create).toHaveBeenCalledTimes(2);
    expect(summary.llmCalls).toBe(2);
  });

  it("clamps the adjusted final score into 0–100", async () => {
    const { config } = loadScoringConfig();
    const { llmMin } = orchestrationSettings(config);
    const hash = (await rescoreListings({ skipLlm: true, log: quiet })).configHash;
    const listing = await makeListing({ ruleScore: 98, scoringConfigHash: hash });
    void llmMin;

    const { client } = mockClient(15);
    await rescoreListings({ llmClient: client, log: quiet });
    const l = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(l.finalScore).toBe(100);
  });
});
