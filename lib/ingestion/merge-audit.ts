import { z } from "zod";

/**
 * Reading `Listing.mergedFrom`.
 *
 * Separate from `lib/ingestion/split.ts` on purpose: the listings table and the
 * detail panel both need to read this column, and importing the splitter to do
 * it would pull the adapter registry and the whole ingestion pipeline into the
 * read path for `/`.
 *
 * The column is `Json[]`, so Postgres will hand back whatever was written,
 * including rows written by an older shape of this code. Everything read out of
 * it is validated here and nothing else parses it.
 *
 * Two entry shapes share the column, discriminated by `kind`:
 *  - a MERGE entry (no `kind`, the shape lib/ingestion/pipeline.ts pushes)
 *  - a SPLIT entry (`kind: "splitFrom"`), written onto the listing that was
 *    split back out, so the history survives the split.
 */

export const MergedFromEntrySchema = z.looseObject({
  source: z.string().min(1),
  sourceUid: z.string().min(1),
  url: z.string(),
  reason: z.string(),
  mergedAt: z.string(),
});

export const SplitFromEntrySchema = z.looseObject({
  kind: z.literal("splitFrom"),
  /** The listing this one was split back out of. */
  fromListingId: z.string().min(1),
  source: z.string().min(1),
  sourceUid: z.string().min(1),
  url: z.string(),
  reason: z.string(),
  splitAt: z.string(),
});

export type MergedFromEntry = z.infer<typeof MergedFromEntrySchema>;
export type SplitFromEntry = z.infer<typeof SplitFromEntrySchema>;

export interface MergeAudit {
  /** Merge entries, each with its index in the stored array. */
  merged: Array<{ index: number; entry: MergedFromEntry }>;
  /** "Split out of <listing>" entries. */
  splits: SplitFromEntry[];
  /** Entries matching neither shape. Kept in the column, never acted on. */
  unreadable: number;
}

/** True for an entry written by the split path rather than the merge path. */
function isSplitEntry(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).kind === "splitFrom"
  );
}

/** Read `Listing.mergedFrom` (untrusted JSON) into the two entry shapes. */
export function parseMergeAudit(raw: readonly unknown[]): MergeAudit {
  const merged: MergeAudit["merged"] = [];
  const splits: SplitFromEntry[] = [];
  let unreadable = 0;

  raw.forEach((value, index) => {
    if (isSplitEntry(value)) {
      const parsed = SplitFromEntrySchema.safeParse(value);
      if (parsed.success) splits.push(parsed.data);
      else unreadable += 1;
      return;
    }
    const parsed = MergedFromEntrySchema.safeParse(value);
    if (parsed.success) merged.push({ index, entry: parsed.data });
    else unreadable += 1;
  });

  return { merged, splits, unreadable };
}

/**
 * How many splittable merge entries the column holds.
 *
 * The table asks this for every row in the catalog just to decide whether to
 * offer "Split merged listing…", so it skips the full Zod parse and checks only
 * what that decision needs. The panel still parses properly before showing or
 * acting on any entry.
 */
export function countMergeEntries(raw: readonly unknown[]): number {
  let n = 0;
  for (const value of raw) {
    if (isSplitEntry(value)) continue;
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry.source === "string" && typeof entry.sourceUid === "string") n += 1;
  }
  return n;
}
