import { prisma } from "@/lib/db";
import type { AppStatus } from "@/generated/prisma/enums";
import { recordStatus } from "@/lib/applications/commit";

/**
 * Row-level actions from the main table and detail panel, keyed by listing.
 *
 * "Not applied" has two representations: no Application row at all, or a row
 * with status NOT_APPLIED. The second exists ONLY to hold notes written before
 * applying — user-written notes are never deleted as a side effect of a status
 * change. Readers must treat both the same (the table folds null into
 * NOT_APPLIED; the tracker excludes NOT_APPLIED rows).
 */

const hasText = (s: string | null | undefined) => typeof s === "string" && s.trim() !== "";

/** Creates the tracking row for a listing, carrying its own company/role text so
 *  the record survives an unlink later. */
async function createApplicationFor(listingId: string, status: AppStatus, now: Date) {
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
    select: { id: true, status: true, notes: true },
  });

  if (status === "NOT_APPLIED") {
    if (!existing) return { status: null };
    if (hasText(existing.notes)) {
      // Keep the row: deleting it would silently destroy the user's notes.
      await recordStatus(existing.id, "NOT_APPLIED", { occurredAt: now });
      return { status: "NOT_APPLIED" };
    }
    // Nothing worth keeping — back to the canonical "no row" state.
    await prisma.$transaction([
      prisma.statusEvent.deleteMany({ where: { applicationId: existing.id } }),
      prisma.application.delete({ where: { id: existing.id } }),
    ]);
    return { status: null };
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
    // The row existed only to hold notes; with none left, remove it.
    await prisma.$transaction([
      prisma.statusEvent.deleteMany({ where: { applicationId: existing.id } }),
      prisma.application.delete({ where: { id: existing.id } }),
    ]);
    return;
  }

  await prisma.application.update({ where: { id: existing.id }, data: { notes: trimmed } });
}

export async function setListingSaved(listingId: string, saved: boolean): Promise<void> {
  await prisma.listing.update({ where: { id: listingId }, data: { saved } });
}

export async function setListingDismissed(listingId: string, dismissed: boolean): Promise<void> {
  await prisma.listing.update({ where: { id: listingId }, data: { dismissed } });
}
