import { prisma } from "@/lib/db";
import type { AppStatus } from "@/generated/prisma/enums";
import { recordStatus } from "@/lib/applications/commit";
import { dropApplicationIfEmpty, holdsUserContent, USER_CONTENT_SELECT } from "@/lib/applications/keep";
import { canonicalizeUrl, extractRequisitionId, isJobrightUrl } from "@/lib/ingestion/normalize";

/**
 * Row-level actions from the main table and detail panel, keyed by listing.
 *
 * "Not applied" has two representations: no Application row at all, or a row
 * with status NOT_APPLIED. The second exists ONLY to hold notes or a cover
 * letter written before applying — user content is never deleted as a side
 * effect of a status change. Readers must treat both the same (the table folds null into
 * NOT_APPLIED; the tracker excludes NOT_APPLIED rows).
 */

/** Creates the tracking row for a listing, carrying its own company/role text so
 *  the record survives an unlink later. */
export async function createApplicationFor(listingId: string, status: AppStatus, now: Date) {
  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    select: {
      title: true,
      url: true,
      requisitionId: true,
      locations: true,
      company: { select: { name: true } },
    },
  });
  if (!listing) throw new Error(`no such listing: ${listingId}`);

  return prisma.application.create({
    data: {
      listingId,
      status,
      appliedAt: status === "APPLIED" ? now : null,
      companyName: listing.company.name,
      roleTitle: listing.title,
      location: listing.locations[0],
      applyUrl: listing.url,
      requisitionId: listing.requisitionId,
      events: { create: { toStatus: status, occurredAt: now } },
    },
    select: { id: true },
  });
}

export async function setListingStatus(
  listingId: string,
  status: AppStatus,
  opts: { now?: Date } = {},
): Promise<{ status: AppStatus | null }> {
  const now = opts.now ?? new Date();
  const existing = await prisma.application.findUnique({
    where: { listingId },
    select: { id: true, status: true, ...USER_CONTENT_SELECT },
  });

  if (status === "NOT_APPLIED") {
    if (!existing) return { status: null };
    // Nothing worth keeping — back to the canonical "no row" state. Otherwise
    // keep the row: deleting it would silently destroy the user's notes or letter.
    if (!holdsUserContent(existing) && (await dropApplicationIfEmpty(existing.id))) {
      return { status: null };
    }
    await recordStatus(existing.id, "NOT_APPLIED", { occurredAt: now });
    return { status: "NOT_APPLIED" };
  }

  if (existing) {
    await recordStatus(existing.id, status, { occurredAt: now });
    return { status };
  }

  await createApplicationFor(listingId, status, now);
  return { status };
}

/**
 * Notes are stored on the Application. A listing with no row yet gets one with
 * status NOT_APPLIED, so notes can be written before applying without implying
 * the user applied. Clearing notes on such a row drops the row again.
 */
export async function setListingNotes(
  listingId: string,
  notes: string,
  opts: { now?: Date } = {},
): Promise<void> {
  const now = opts.now ?? new Date();
  const trimmed = notes.trim() === "" ? null : notes;
  const existing = await prisma.application.findUnique({
    where: { listingId },
    select: { id: true, status: true },
  });

  if (!existing) {
    if (trimmed === null) return;
    const created = await createApplicationFor(listingId, "NOT_APPLIED", now);
    await prisma.application.update({ where: { id: created.id }, data: { notes: trimmed } });
    return;
  }

  if (trimmed === null && existing.status === "NOT_APPLIED") {
    // The row existed only to hold notes; with none left (and no letter), remove it.
    if (await dropApplicationIfEmpty(existing.id, { ignoreNotes: true, requireStatus: "NOT_APPLIED" })) return;
  }

  await prisma.application.update({ where: { id: existing.id }, data: { notes: trimmed } });
}

export async function setListingSaved(listingId: string, saved: boolean): Promise<void> {
  await prisma.listing.update({ where: { id: listingId }, data: { saved } });
}

export async function setListingDismissed(listingId: string, dismissed: boolean): Promise<void> {
  await prisma.listing.update({ where: { id: listingId }, data: { dismissed } });
}

export type ApplyLinkResult = { ok: true; url: string } | { ok: false; message: string };

/**
 * The employer's link for a listing that only has jobright's page, pasted by
 * hand: jobright shows it only after you sign in there, so the app can't look
 * it up itself. Tracking (jr_id, utm_*) is stripped. The listing is queued for
 * a detail fetch from the real posting, and an application that still points
 * at jobright follows. A listing that already has a direct link is left alone,
 * since its link is part of its merge identity.
 */
export async function setListingApplyUrl(listingId: string, pasted: string): Promise<ApplyLinkResult> {
  let parsed: URL;
  try {
    parsed = new URL(pasted.trim());
  } catch {
    return { ok: false, message: "That isn't a link." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, message: "Only http and https links work here." };
  }
  if (isJobrightUrl(parsed.href)) {
    return { ok: false, message: "That's still jobright's page. Paste the employer's page it sends you to." };
  }
  const url = canonicalizeUrl(parsed.href);

  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    select: { url: true, requisitionId: true },
  });
  if (!listing) return { ok: false, message: "This listing no longer exists." };
  if (!isJobrightUrl(listing.url)) {
    return { ok: false, message: "This listing already has a direct apply link." };
  }

  await prisma.$transaction([
    prisma.listing.update({
      where: { id: listingId },
      data: {
        url,
        requisitionId: listing.requisitionId ?? extractRequisitionId(url),
        detailFetchedAt: null,
      },
    }),
    prisma.application.updateMany({
      where: { listingId, applyUrl: listing.url },
      data: { applyUrl: url },
    }),
  ]);
  return { ok: true, url };
}
