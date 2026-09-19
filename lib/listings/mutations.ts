import { prisma } from "@/lib/db";
import type { AppStatus } from "@/generated/prisma/enums";
import { recordStatus } from "@/lib/applications/commit";

/**
 * Row-level actions from the main table. "Not Applied" is the absence of an
 * Application row, so the first status change creates one — carrying the
 * listing's own company/role text so the record survives an unlink later.
 */
export async function setListingStatus(
  listingId: string,
  status: AppStatus,
  opts: { now?: Date } = {},
): Promise<{ status: AppStatus | null }> {
  const now = opts.now ?? new Date();
  const existing = await prisma.application.findUnique({
    where: { listingId },
    select: { id: true, status: true },
  });

  // Setting a listing back to NOT_APPLIED removes the tracking row entirely,
  // so the table's "not applied" state stays a single, unambiguous thing.
  if (status === "NOT_APPLIED") {
    if (existing) {
      await prisma.$transaction([
        prisma.statusEvent.deleteMany({ where: { applicationId: existing.id } }),
        prisma.application.delete({ where: { id: existing.id } }),
      ]);
    }
    return { status: null };
  }

  if (existing) {
    await recordStatus(existing.id, status, { occurredAt: now });
    return { status };
  }

  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    select: { title: true, url: true, requisitionId: true, locations: true, company: { select: { name: true } } },
  });
  if (!listing) throw new Error(`no such listing: ${listingId}`);

  const created = await prisma.application.create({
    data: {
      listingId,
      status,
      appliedAt: status === "APPLIED" ? now : null,
      companyName: listing.company.name,
      roleTitle: listing.title,
      location: listing.locations[0],
      applyUrl: listing.url,
      requisitionId: listing.requisitionId,
    },
  });
  await prisma.statusEvent.create({
    data: { applicationId: created.id, toStatus: status, occurredAt: now },
  });
  return { status };
}

export async function setListingSaved(listingId: string, saved: boolean): Promise<void> {
  await prisma.listing.update({ where: { id: listingId }, data: { saved } });
}

export async function setListingDismissed(listingId: string, dismissed: boolean): Promise<void> {
  await prisma.listing.update({ where: { id: listingId }, data: { dismissed } });
}
