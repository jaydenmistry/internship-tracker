import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { adapters } from "@/lib/ingestion/adapters";
import type { SourceAdapter } from "@/lib/ingestion/adapters/types";
import { buildListingCreateData, sha256, upsertCompany } from "@/lib/ingestion/pipeline";
import { parseMergeAudit } from "@/lib/ingestion/merge-audit";

/**
 * Undo ONE incorrect merge: pull a merged-in source record back out into its
 * own Listing.
 *
 * Dedup biases toward not merging precisely because a wrong merge silently
 * hides a role — but it still happens, and when it does the hidden listing has
 * to be recoverable. The merge kept everything needed: `Listing.mergedFrom`
 * records which source record was folded in, and that record's verbatim
 * payload is still on its `ListingSource.raw`. Splitting re-normalizes that
 * raw record through the SAME adapter mapping that produced it, and creates
 * the listing the pipeline would have created had it never merged.
 *
 * Nothing is deleted: the source row moves, the audit entry moves (as a
 * reverse "split out of" entry on the new listing), and both listings are
 * flagged for rescoring.
 */

// The mergedFrom audit column is parsed in lib/ingestion/merge-audit.ts, which
// the read models import directly — reading the column must not drag the
// adapter registry and the pipeline into the listings page's module graph.
// Re-exported here so the splitter still reads as one subject.
export {
  MergedFromEntrySchema,
  SplitFromEntrySchema,
  parseMergeAudit,
  countMergeEntries,
  type MergedFromEntry,
  type SplitFromEntry,
  type MergeAudit,
} from "@/lib/ingestion/merge-audit";

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export type SplitErrorCode =
  | "listing_not_found"
  | "only_source"
  | "entry_not_found"
  | "source_row_missing"
  | "unknown_source"
  | "renormalize_failed"
  | "conflict";

export type SplitResult =
  | {
      ok: true;
      /** The listing the record now lives on. */
      listingId: string;
      /** True when this exact entry had already been split — nothing changed. */
      alreadySplit: boolean;
      company: string;
      title: string;
    }
  | { ok: false; code: SplitErrorCode; message: string };

export interface SplitMergeInput {
  /** The listing the record was merged INTO (the one showing the entry). */
  listingId: string;
  source: string;
  sourceUid: string;
  /** Injectable clock, so tests assert exact timestamps. */
  now?: Date;
  /** Replace the adapter registry (tests use fake adapters). */
  adapterOverride?: SourceAdapter[];
}

const fail = (code: SplitErrorCode, message: string): SplitResult => ({
  ok: false,
  code,
  message,
});

// ---------------------------------------------------------------------------
// The split
// ---------------------------------------------------------------------------

/**
 * Split one merged-in source record off `listingId` into its own Listing.
 *
 * Idempotent: splitting the same entry twice reports the listing created by
 * the first call and changes nothing. Never throws for an expected refusal —
 * every guard returns a message the UI can show verbatim.
 */
export async function splitMerge(input: SplitMergeInput): Promise<SplitResult> {
  const { listingId, source, sourceUid } = input;
  const now = input.now ?? new Date();
  const registry = input.adapterOverride ?? adapters;

  const parent = await prisma.listing.findUnique({
    where: { id: listingId },
    include: { sources: true, company: { select: { name: true } } },
  });
  if (!parent) {
    return fail("listing_not_found", `No listing with id ${listingId}.`);
  }

  const audit = parseMergeAudit(parent.mergedFrom);
  const match = audit.merged.find(
    (m) => m.entry.source === source && m.entry.sourceUid === sourceUid,
  );

  // No entry: either it was already split (report that listing — splitting
  // twice must not create a second copy), or it was never there.
  if (!match) {
    const already = await findAlreadySplit(listingId, source, sourceUid);
    if (already) return already;
    return fail(
      "entry_not_found",
      `This listing has no merged-in record from ${source} (${sourceUid}).`,
    );
  }

  if (parent.sources.length < 2) {
    return fail(
      "only_source",
      `${source} is this listing's only source — there is nothing to split off. ` +
        "The merge audit entry is stale.",
    );
  }

  const sourceRow = parent.sources.find(
    (s) => s.source === source && s.sourceUid === sourceUid,
  );
  if (!sourceRow) {
    return fail(
      "source_row_missing",
      `The ${source} record ${sourceUid} is recorded as merged in, but no source row for it is attached to this listing.`,
    );
  }

  const adapter = registry.find((a) => a.id === source);
  if (!adapter?.normalizeRecord) {
    return fail(
      "unknown_source",
      `No adapter registered for source "${source}" can rebuild a listing from its stored record.`,
    );
  }

  const normalized = adapter.normalizeRecord(sourceRow.raw);
  if (!normalized.ok) {
    return fail(
      "renormalize_failed",
      `The stored ${source} record could not be re-normalized: ${normalized.error}`,
    );
  }
  const item = normalized.listing;

  // The rebuilt record may name the company slightly differently; resolving it
  // the way ingestion does keeps both listings on one Company row.
  const company = await upsertCompany(item.company, item.companyFaangPlus);

  const splitEntry = {
    kind: "splitFrom" as const,
    fromListingId: parent.id,
    source,
    sourceUid,
    url: match.entry.url,
    reason: match.entry.reason,
    splitAt: now.toISOString(),
  };

  try {
    const created = await prisma.$transaction(async (tx) => {
      const listing = await tx.listing.create({
        data: {
          ...buildListingCreateData(item, company.id, now),
          // The record's own history, not the parent's: it has been seen by
          // this source since it was merged in, and the parent's earlier
          // firstSeen belongs to the parent's own record.
          firstSeen: sourceRow.firstSeen,
          lastSeen: sourceRow.lastSeen,
          // A source row that is no longer active means the posting is gone;
          // the run-path create can assume active, this path cannot.
          likelyClosed: !sourceRow.active,
          mergedFrom: [splitEntry],
          // Explicit, though it is also the column default: a brand new
          // listing has no score and must be picked up by the next pass.
          scoringConfigHash: null,
        },
        select: { id: true },
      });

      // Claim the source row CONDITIONALLY — the move is the point of no
      // return, so it doubles as the lock. A plain read-then-update would let
      // two concurrent splits both see the row on the parent, both create a
      // listing, and leave the loser's listing behind with no sources at all
      // (rows are never deleted, so it would sit there forever). A zero count
      // means someone else moved it first; throwing rolls this create back.
      const claimed = await tx.listingSource.updateMany({
        where: { id: sourceRow.id, listingId: parent.id },
        data: { listingId: listing.id },
      });
      if (claimed.count === 0) {
        throw new SplitConflict(
          `The ${source} record ${sourceUid} is no longer attached to this listing — reload and try again.`,
        );
      }

      // Re-read mergedFrom INSIDE the transaction and filter by identity, not
      // by the index read earlier. An ingestion run merging another record
      // into this same parent between the two reads does `push`; writing back
      // a list computed before that push would erase the new entry, stranding
      // that record on the parent with no audit trail and no way to split it.
      const fresh = await tx.listing.findUniqueOrThrow({
        where: { id: parent.id },
        select: { mergedFrom: true, postingText: true, postingTextHash: true },
      });
      const dropIndex = parseMergeAudit(fresh.mergedFrom).merged.find(
        (m) => m.entry.source === source && m.entry.sourceUid === sourceUid,
      )?.index;
      // Drop exactly the one entry, by position, leaving the rest in their
      // stored order — including reverse split entries and any entry this
      // module cannot parse, which are preserved verbatim rather than dropped.
      const remaining = fresh.mergedFrom.filter(
        (_, i) => i !== dropIndex,
      ) as Prisma.InputJsonValue[];

      // If the parent is holding the posting text this record donated, give it
      // back. The merge path adopts an incoming description when it is longer
      // than the parent's, and the detail stage only ever replaces posting text
      // with something LONGER — so without this the parent keeps describing the
      // role that just left, is rescored against it, and its cached
      // LlmAssessment (keyed on that foreign text hash) still applies.
      const donated =
        item.postingText !== undefined &&
        fresh.postingTextHash !== null &&
        fresh.postingTextHash === sha256(item.postingText);

      await tx.listing.update({
        where: { id: parent.id },
        data: {
          mergedFrom: { set: remaining },
          // Self-invalidation: the parent lost a source (and possibly the
          // reason it looked richer), so its score is stale.
          scoringConfigHash: null,
          ...(donated
            ? {
                postingText: null,
                postingTextHash: null,
                // Clear the fetch stamps too, so stage 3 fetches the parent's
                // OWN posting page on the next cycle instead of treating the
                // borrowed text as already collected.
                detailFetchedAt: null,
                detailFetchStatus: null,
              }
            : {}),
        },
      });

      return listing;
    });

    return {
      ok: true,
      listingId: created.id,
      alreadySplit: false,
      company: item.company,
      title: item.title,
    };
  } catch (err) {
    if (err instanceof SplitConflict) return fail("conflict", err.message);
    throw err;
  }
}

class SplitConflict extends Error {}

/**
 * Was this exact entry already split off? The source row is unique on
 * (source, sourceUid), so its current listing is the only place to look: if
 * that listing carries the matching "split out of <parent>" entry, the first
 * call did the work and this one is a repeat.
 */
async function findAlreadySplit(
  parentId: string,
  source: string,
  sourceUid: string,
): Promise<SplitResult | null> {
  const row = await prisma.listingSource.findUnique({
    where: { source_sourceUid: { source, sourceUid } },
    select: {
      listingId: true,
      listing: {
        select: { id: true, title: true, mergedFrom: true, company: { select: { name: true } } },
      },
    },
  });
  if (!row || row.listingId === parentId) return null;

  const { splits } = parseMergeAudit(row.listing.mergedFrom);
  const hit = splits.some(
    (s) => s.fromListingId === parentId && s.source === source && s.sourceUid === sourceUid,
  );
  if (!hit) return null;

  return {
    ok: true,
    listingId: row.listing.id,
    alreadySplit: true,
    company: row.listing.company.name,
    title: row.listing.title,
  };
}
