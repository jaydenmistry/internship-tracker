import "dotenv/config";
import { beforeEach, describe, expect, it } from "vitest";
import fixtures from "../fixtures/split/merged-pair.json";
import { normalizeSimplifyRecord } from "@/lib/ingestion/adapters/simplify";
import { normalizeInternListRecord } from "@/lib/ingestion/adapters/intern-list";
import { sha256 } from "@/lib/ingestion/pipeline";
import type {
  AdapterResult,
  NormalizedListing,
  SourceAdapter,
} from "@/lib/ingestion/adapters/types";

/**
 * Splitting an incorrect merge, end to end against a real database.
 *
 * The merges here are produced by the REAL pipeline from verbatim source
 * records, and the split re-normalizes them through the REAL adapters — the
 * point of the feature is that a listing dedup hid can be recovered exactly,
 * so a test that hand-builds the rows would prove nothing.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

/** Normalize a fixture record the way its adapter would during a run. */
function simplify(record: unknown): NormalizedListing {
  const result = normalizeSimplifyRecord(record);
  if (!result.ok) throw new Error(`fixture is not a valid simplify record: ${result.error}`);
  return result.listing;
}

function internList(record: unknown): NormalizedListing {
  const result = normalizeInternListRecord(record);
  if (!result.ok) throw new Error(`fixture is not a valid intern-list record: ${result.error}`);
  return result.listing;
}

/** An adapter that yields already-normalized records, under a real source id. */
function fakeAdapter(id: string, listings: NormalizedListing[]): SourceAdapter {
  return {
    id,
    displayName: id,
    fetch: async (): Promise<AdapterResult> => ({ listings, rawPayload: `${id}-payload` }),
  };
}

const quiet = () => {};

describe.skipIf(!hasDb)("splitMerge (integration)", () => {
  let prisma: (typeof import("@/lib/db"))["prisma"];
  let runIngestion: (typeof import("@/lib/ingestion/pipeline"))["runIngestion"];
  let splitMerge: (typeof import("@/lib/ingestion/split"))["splitMerge"];

  const T1 = new Date("2026-09-01T06:00:00Z");
  const T2 = new Date("2026-09-08T06:00:00Z");
  const SPLIT_AT = new Date("2026-09-19T09:30:00Z");

  const SIMPLIFY_UID = fixtures.simplify.id;
  const INTERN_UID = fixtures.internList.id;

  beforeEach(async () => {
    ({ prisma } = await import("@/lib/db"));
    ({ runIngestion } = await import("@/lib/ingestion/pipeline"));
    ({ splitMerge } = await import("@/lib/ingestion/split"));
    await prisma.statusEvent.deleteMany();
    await prisma.application.deleteMany();
    await prisma.llmAssessment.deleteMany();
    await prisma.listingSource.deleteMany();
    await prisma.listing.deleteMany();
    await prisma.company.deleteMany();
    await prisma.ingestRun.deleteMany();
  });

  /**
   * Ingests the simplify record, then the intern-list record, which dedup
   * merges into it. Returns the merged listing's id.
   */
  async function ingestMergedPair(): Promise<string> {
    await runIngestion({
      adapterOverride: [fakeAdapter("simplify", [simplify(fixtures.simplify)])],
      skipDetail: true,
      log: quiet,
      now: T1,
    });
    await runIngestion({
      adapterOverride: [fakeAdapter("intern-list", [internList(fixtures.internList)])],
      skipDetail: true,
      log: quiet,
      now: T2,
    });

    const merged = await prisma.listing.findFirstOrThrow({ include: { sources: true } });
    // Guard the premise: if dedup stops merging these, every assertion below
    // would pass vacuously.
    expect(await prisma.listing.count()).toBe(1);
    expect(merged.sources).toHaveLength(2);
    expect(merged.mergedFrom).toHaveLength(1);
    return merged.id;
  }

  it("splits a merged-in record back into its own listing", async () => {
    const parentId = await ingestMergedPair();
    // A scored listing must be flagged stale by the split.
    await prisma.listing.update({
      where: { id: parentId },
      data: { scoringConfigHash: "hash-before-split", finalScore: 71 },
    });

    const result = await splitMerge({
      listingId: parentId,
      source: "intern-list",
      sourceUid: INTERN_UID,
      now: SPLIT_AT,
    });

    expect(result).toMatchObject({ ok: true, alreadySplit: false, company: "Robinhood" });
    if (!result.ok) throw new Error("unreachable");
    expect(result.listingId).not.toBe(parentId);

    // Two listings, one source row each — nothing deleted.
    expect(await prisma.listing.count()).toBe(2);
    expect(await prisma.listingSource.count()).toBe(2);

    const parent = await prisma.listing.findUniqueOrThrow({
      where: { id: parentId },
      include: { sources: true },
    });
    const child = await prisma.listing.findUniqueOrThrow({
      where: { id: result.listingId },
      include: { sources: true, company: true },
    });

    expect(parent.sources.map((s) => s.source)).toEqual(["simplify"]);
    expect(child.sources.map((s) => s.source)).toEqual(["intern-list"]);
    expect(child.sources[0].sourceUid).toBe(INTERN_UID);

    // The entry is gone from the parent and recorded in reverse on the child.
    expect(parent.mergedFrom).toHaveLength(0);
    expect(child.mergedFrom).toHaveLength(1);
    expect(child.mergedFrom[0]).toMatchObject({
      kind: "splitFrom",
      fromListingId: parentId,
      source: "intern-list",
      sourceUid: INTERN_UID,
      splitAt: SPLIT_AT.toISOString(),
    });

    // Both are flagged for the next scoring pass.
    expect(parent.scoringConfigHash).toBeNull();
    expect(child.scoringConfigHash).toBeNull();

    // Rebuilt from the intern-list record, not copied from the parent.
    expect(child.company.normalizedName).toBe("robinhood");
    expect(child.companyId).toBe(parent.companyId);
    expect(child.title).toBe("Software Engineer Intern");
    expect(child.url).toBe("https://jobright.ai/jobs/info/6aad91e7de327d3e210d33d9");
    expect(child.salary).toBe("$50-$60/hr");
    expect(child.postingText).toContain("Python, Go or TypeScript");
    // Its own dedup identity, from the same helpers the pipeline uses.
    expect(child.normalizedTitle).toBe("software engineer intern");
    expect(child.dedupKey).toBe("robinhood|software engineer intern|menlo-park-ca");
    // The source row's own history, not the parent's.
    expect(child.firstSeen.toISOString()).toBe(T2.toISOString());
    expect(child.likelyClosed).toBe(false);
  });

  it("hands back posting text the split-out record had donated", async () => {
    // The merge path adopts an incoming description when it is longer than the
    // parent's, and the detail stage only ever REPLACES posting text with
    // something longer — so a parent left holding the departing record's text
    // would keep describing a role that is no longer part of it, be rescored
    // against it, and keep an LlmAssessment cached under that foreign hash.
    const parentId = await ingestMergedPair();
    const before = await prisma.listing.findUniqueOrThrow({
      where: { id: parentId },
      select: { postingText: true, postingTextHash: true },
    });
    // Guard the premise: the intern-list record is the one carrying a
    // description, so the parent is holding borrowed text.
    expect(before.postingText).not.toBeNull();
    expect(before.postingText).toBe(fixtures.internList.qualifications);

    await prisma.listing.update({
      where: { id: parentId },
      data: { detailFetchedAt: new Date(), detailFetchStatus: "ok" },
    });

    const result = await splitMerge({
      listingId: parentId,
      source: "intern-list",
      sourceUid: INTERN_UID,
    });
    expect(result.ok).toBe(true);

    const parent = await prisma.listing.findUniqueOrThrow({ where: { id: parentId } });
    expect(parent.postingText).toBeNull();
    expect(parent.postingTextHash).toBeNull();
    // Cleared too, or stage 3 would treat the borrowed text as already
    // collected and never fetch the parent's own posting page.
    expect(parent.detailFetchedAt).toBeNull();
    expect(parent.detailFetchStatus).toBeNull();

    // The text left with the record that brought it.
    const child = await prisma.listing.findUniqueOrThrow({
      where: { id: result.ok ? result.listingId : "" },
    });
    expect(child.postingText).toBe(fixtures.internList.qualifications);
  });

  it("keeps posting text the parent fetched for itself", async () => {
    // The mirror case: text the parent collected from its OWN posting page is
    // not the departing record's to take back.
    const parentId = await ingestMergedPair();
    const own = "A description this listing fetched from its own posting page.";
    await prisma.listing.update({
      where: { id: parentId },
      data: {
        postingText: own,
        postingTextHash: sha256(own),
        detailFetchedAt: new Date(),
        detailFetchStatus: "ok",
      },
    });

    await splitMerge({ listingId: parentId, source: "intern-list", sourceUid: INTERN_UID });

    const parent = await prisma.listing.findUniqueOrThrow({ where: { id: parentId } });
    expect(parent.postingText).toBe(own);
    expect(parent.detailFetchStatus).toBe("ok");
  });

  it("leaves the parent's application on the parent", async () => {
    const parentId = await ingestMergedPair();
    await prisma.application.create({
      data: { listingId: parentId, status: "APPLIED", notes: "referred by Dana" },
    });

    const result = await splitMerge({
      listingId: parentId,
      source: "intern-list",
      sourceUid: INTERN_UID,
      now: SPLIT_AT,
    });
    if (!result.ok) throw new Error(result.message);

    expect(await prisma.application.count()).toBe(1);
    const app = await prisma.application.findFirstOrThrow();
    expect(app.listingId).toBe(parentId);
    expect(app.notes).toBe("referred by Dana");
    const child = await prisma.listing.findUniqueOrThrow({
      where: { id: result.listingId },
      include: { application: true },
    });
    expect(child.application).toBeNull();
  });

  it("is idempotent: splitting the same entry twice creates one listing", async () => {
    const parentId = await ingestMergedPair();

    const first = await splitMerge({
      listingId: parentId,
      source: "intern-list",
      sourceUid: INTERN_UID,
      now: SPLIT_AT,
    });
    if (!first.ok) throw new Error(first.message);

    const second = await splitMerge({
      listingId: parentId,
      source: "intern-list",
      sourceUid: INTERN_UID,
      now: new Date("2026-09-19T10:00:00Z"),
    });

    expect(second).toMatchObject({ ok: true, alreadySplit: true, listingId: first.listingId });
    expect(await prisma.listing.count()).toBe(2);
    expect(await prisma.listingSource.count()).toBe(2);
    const child = await prisma.listing.findUniqueOrThrow({ where: { id: first.listingId } });
    // The second call wrote nothing: the audit still shows the first split.
    expect(child.mergedFrom).toHaveLength(1);
    expect(child.mergedFrom[0]).toMatchObject({ splitAt: SPLIT_AT.toISOString() });
  });

  it("survives the next ingestion run without being merged back", async () => {
    const parentId = await ingestMergedPair();
    const split = await splitMerge({
      listingId: parentId,
      source: "intern-list",
      sourceUid: INTERN_UID,
      now: SPLIT_AT,
    });
    if (!split.ok) throw new Error(split.message);

    const summary = await runIngestion({
      adapterOverride: [
        fakeAdapter("simplify", [simplify(fixtures.simplify)]),
        fakeAdapter("intern-list", [internList(fixtures.internList)]),
      ],
      skipDetail: true,
      log: quiet,
      now: new Date("2026-09-20T06:00:00Z"),
    });

    expect(summary.sources.every((s) => s.ok && s.itemsNew === 0)).toBe(true);
    expect(await prisma.listing.count()).toBe(2);
    const parent = await prisma.listing.findUniqueOrThrow({ where: { id: parentId } });
    expect(parent.mergedFrom).toHaveLength(0);
    expect(await prisma.listing.count({ where: { likelyClosed: true } })).toBe(0);
  });

  it("splits a same-source merge (two simplify records on one listing)", async () => {
    await runIngestion({
      adapterOverride: [
        fakeAdapter("simplify", [
          simplify(fixtures.simplify),
          simplify(fixtures.simplifyDuplicate),
        ]),
      ],
      skipDetail: true,
      log: quiet,
      now: T1,
    });
    const merged = await prisma.listing.findFirstOrThrow();
    expect(await prisma.listing.count()).toBe(1);
    expect(merged.mergedFrom).toHaveLength(1);

    const result = await splitMerge({
      listingId: merged.id,
      source: "simplify",
      sourceUid: fixtures.simplifyDuplicate.id,
      now: SPLIT_AT,
    });
    if (!result.ok) throw new Error(result.message);

    const child = await prisma.listing.findUniqueOrThrow({
      where: { id: result.listingId },
      include: { sources: true },
    });
    expect(child.sources.map((s) => s.sourceUid)).toEqual([fixtures.simplifyDuplicate.id]);
    expect(child.url).toBe(fixtures.simplifyDuplicate.url);
    expect(child.sponsorship).toBe("Does Not Offer Sponsorship");
    expect(child.degrees).toEqual(["Bachelor's"]);
  });

  // -------------------------------------------------------------------------
  // Guard rails
  // -------------------------------------------------------------------------

  it("refuses an unknown listing", async () => {
    const result = await splitMerge({
      listingId: "no-such-listing",
      source: "simplify",
      sourceUid: SIMPLIFY_UID,
    });
    expect(result).toMatchObject({ ok: false, code: "listing_not_found" });
  });

  it("refuses an entry that is not in the merge audit", async () => {
    const parentId = await ingestMergedPair();
    const result = await splitMerge({
      listingId: parentId,
      source: "intern-list",
      sourceUid: "not-a-real-uid",
    });
    expect(result).toMatchObject({ ok: false, code: "entry_not_found" });
    expect(await prisma.listing.count()).toBe(1);
  });

  it("refuses when the named source is the listing's only source", async () => {
    await runIngestion({
      adapterOverride: [fakeAdapter("simplify", [simplify(fixtures.simplify)])],
      skipDetail: true,
      log: quiet,
      now: T1,
    });
    const only = await prisma.listing.findFirstOrThrow();
    // A stale audit entry naming the listing's own, only source row.
    await prisma.listing.update({
      where: { id: only.id },
      data: {
        mergedFrom: [
          {
            source: "simplify",
            sourceUid: SIMPLIFY_UID,
            url: fixtures.simplify.url,
            reason: "stale audit entry",
            mergedAt: T1.toISOString(),
          },
        ],
      },
    });

    const result = await splitMerge({
      listingId: only.id,
      source: "simplify",
      sourceUid: SIMPLIFY_UID,
    });
    expect(result).toMatchObject({ ok: false, code: "only_source" });
    expect(await prisma.listing.count()).toBe(1);
    expect(await prisma.listingSource.count()).toBe(1);
  });

  it("refuses a source with no adapter that can rebuild the record", async () => {
    await runIngestion({
      adapterOverride: [fakeAdapter("simplify", [simplify(fixtures.simplify)])],
      skipDetail: true,
      log: quiet,
      now: T1,
    });
    // A source id no registered adapter answers to.
    await runIngestion({
      adapterOverride: [
        fakeAdapter("retired-source", [
          { ...internList(fixtures.internList), source: "retired-source" },
        ]),
      ],
      skipDetail: true,
      log: quiet,
      now: T2,
    });
    const merged = await prisma.listing.findFirstOrThrow();
    expect(merged.mergedFrom).toHaveLength(1);

    const result = await splitMerge({
      listingId: merged.id,
      source: "retired-source",
      sourceUid: INTERN_UID,
    });
    expect(result).toMatchObject({ ok: false, code: "unknown_source" });
    expect(await prisma.listing.count()).toBe(1);
  });

  it("refuses when the stored raw record can no longer be normalized", async () => {
    await runIngestion({
      adapterOverride: [fakeAdapter("simplify", [simplify(fixtures.simplify)])],
      skipDetail: true,
      log: quiet,
      now: T1,
    });
    // Same source, a record whose stored payload is no longer parseable —
    // exactly what a source schema change leaves behind.
    await runIngestion({
      adapterOverride: [
        fakeAdapter("simplify", [
          { ...simplify(fixtures.simplifyDuplicate), raw: { unexpected: "shape" } },
        ]),
      ],
      skipDetail: true,
      log: quiet,
      now: T2,
    });
    const merged = await prisma.listing.findFirstOrThrow();
    expect(merged.mergedFrom).toHaveLength(1);

    const result = await splitMerge({
      listingId: merged.id,
      source: "simplify",
      sourceUid: fixtures.simplifyDuplicate.id,
    });
    expect(result).toMatchObject({ ok: false, code: "renormalize_failed" });
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain("Summer 2027");
    // Nothing was created and nothing was moved.
    expect(await prisma.listing.count()).toBe(1);
    expect(await prisma.listingSource.count()).toBe(2);
  });
});
