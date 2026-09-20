import { describe, expect, it } from "vitest";
import { parseMergeAudit } from "@/lib/ingestion/split";

/**
 * `Listing.mergedFrom` is a `Json[]` column: Postgres hands back whatever was
 * written, including entries from an older shape of the code or from a hand
 * edit. Everything read out of it goes through this parser, so it is the one
 * place that decides what the UI is allowed to offer a split button for.
 */

const merge = (over: Record<string, unknown> = {}) => ({
  source: "intern-list",
  sourceUid: "abc123",
  url: "https://jobright.ai/jobs/info/abc123",
  reason: "single exact dedupKey match, identities inconclusive",
  mergedAt: "2026-09-08T06:00:00.000Z",
  ...over,
});

const split = (over: Record<string, unknown> = {}) => ({
  kind: "splitFrom",
  fromListingId: "parent1",
  source: "intern-list",
  sourceUid: "abc123",
  url: "https://jobright.ai/jobs/info/abc123",
  reason: "single exact dedupKey match, identities inconclusive",
  splitAt: "2026-09-19T09:30:00.000Z",
  ...over,
});

describe("parseMergeAudit", () => {
  it("reads the merge entries the pipeline writes, with their positions", () => {
    const audit = parseMergeAudit([merge(), merge({ sourceUid: "def456" })]);
    expect(audit.merged.map((m) => m.index)).toEqual([0, 1]);
    expect(audit.merged[1].entry.sourceUid).toBe("def456");
    expect(audit.splits).toHaveLength(0);
    expect(audit.unreadable).toBe(0);
  });

  it("keeps the index of each entry in the STORED array, gaps included", () => {
    // The index is what the split writes back, so an unreadable neighbour must
    // not shift it — that would delete the wrong entry.
    const audit = parseMergeAudit(["junk", merge(), null, merge({ sourceUid: "z" })]);
    expect(audit.merged.map((m) => m.index)).toEqual([1, 3]);
    expect(audit.unreadable).toBe(2);
  });

  it("separates split entries from merge entries", () => {
    const audit = parseMergeAudit([merge(), split()]);
    expect(audit.merged).toHaveLength(1);
    expect(audit.splits).toHaveLength(1);
    expect(audit.splits[0].fromListingId).toBe("parent1");
    expect(audit.unreadable).toBe(0);
  });

  it("counts a malformed split entry as unreadable rather than a merge", () => {
    // kind says splitFrom, so it is never offered as something to split again.
    const audit = parseMergeAudit([split({ fromListingId: "" })]);
    expect(audit.merged).toHaveLength(0);
    expect(audit.splits).toHaveLength(0);
    expect(audit.unreadable).toBe(1);
  });

  it("rejects entries missing the fields a split needs", () => {
    const audit = parseMergeAudit([
      merge({ sourceUid: undefined }),
      merge({ source: "" }),
      merge({ mergedAt: 1769182182 }),
      42,
      [],
    ]);
    expect(audit.merged).toHaveLength(0);
    expect(audit.unreadable).toBe(5);
  });

  it("tolerates extra fields a future writer might add", () => {
    const audit = parseMergeAudit([merge({ confidence: 0.91 })]);
    expect(audit.merged).toHaveLength(1);
    expect(audit.merged[0].entry.sourceUid).toBe("abc123");
  });

  it("reads an empty column as nothing merged", () => {
    expect(parseMergeAudit([])).toEqual({ merged: [], splits: [], unreadable: 0 });
  });
});
