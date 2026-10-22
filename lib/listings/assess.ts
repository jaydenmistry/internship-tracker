import { prisma } from "@/lib/db";
import { fetchDetailForListing } from "@/lib/ingestion/pipeline";
import { assessOneListing, type AssessOneResult } from "@/lib/scoring/rescore";
import { describeFetchStatus } from "@/lib/listings/detail";

/**
 * "Run Claude assessment" from the detail panel: fetch the posting page first
 * when the listing has no text yet (the assessment never runs on a title
 * alone), then run the Claude pass on this one listing, whatever its score.
 *
 * One click costs at most one posting fetch and one Claude call; a listing
 * whose current text was already assessed reuses that result for free.
 */
export type AssessNowResult =
  | (AssessOneResult & { ok: true; fetched: boolean })
  /** `changed`: the listing was still written (fetched text, a fresh rule score). */
  | (Extract<AssessOneResult, { ok: false }> & { changed: boolean });

export async function assessListingNow(listingId: string): Promise<AssessNowResult> {
  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    select: { postingTextHash: true },
  });
  if (!listing) return { ok: false, reason: "not_found", message: "That listing no longer exists.", changed: false };

  let fetched = false;
  if (listing.postingTextHash === null) {
    const result = await fetchDetailForListing(listingId);
    if (!result?.hasText) {
      const label = describeFetchStatus(result?.status ?? null, false).label;
      return {
        ok: false,
        reason: "no_text",
        message: `Couldn't get the posting text (${label.toLowerCase()}), and Claude never judges a role from its title alone.`,
        // The attempt itself is recorded (status, time), which the panel shows.
        changed: result !== null,
      };
    }
    fetched = true;
  }

  const result = await assessOneListing(listingId);
  if (result.ok) return { ...result, fetched };
  // Past the early exits, assessOneListing has already rescored stage 1.
  return { ...result, changed: fetched || (result.reason !== "not_found" && result.reason !== "disabled") };
}
