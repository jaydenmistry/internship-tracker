import { prisma } from "@/lib/db";
import type { AppStatus } from "@/generated/prisma/enums";
import type { ImportRow } from "@/lib/applications/import";
import { normalizeCompany, normalizeTitle } from "@/lib/ingestion/normalize";

/**
 * Finds an existing manual (unlinked) application for the same company+role.
 * Postgres can't index this comparison, but the manual set is small — it's
 * only the roles that matched no listing.
 */
async function findManualApplication(company: string, role: string) {
  const targetCompany = normalizeCompany(company);
  const targetRole = normalizeTitle(role);
  const candidates = await prisma.application.findMany({
    where: { listingId: null, companyName: { not: null } },
    select: { id: true, status: true, notes: true, companyName: true, roleTitle: true },
  });
  return (
    candidates.find(
      (a) =>
        normalizeCompany(a.companyName ?? "") === targetCompany &&
        normalizeTitle(a.roleTitle ?? "") === targetRole,
    ) ?? null
  );
}

/**
 * Writing side of the bulk import. Runs only on rows the user confirmed —
 * `import.ts` never writes, because a wrong auto-match silently marks the
 * wrong role as applied and hides it from the table.
 */

export interface ImportDecision {
  row: ImportRow;
  /** null → record a manual application with no listing attached. */
  listingId: string | null;
  status?: AppStatus;
  appliedAt?: Date | null;
  notes?: string;
}

export interface CommitSummary {
  linked: number;
  manual: number;
  updated: number;
  /** Already tracked at this exact status — nothing to do. Counted so the
   *  summary's numbers add up to the rows submitted. */
  unchanged: number;
  failed: Array<{ lineNumber: number; reason: string }>;
}

/**
 * Sets a status and appends to the timeline in one transaction. A no-op status
 * write records no event, so the timeline stays meaningful.
 */
export async function recordStatus(
  applicationId: string,
  toStatus: AppStatus,
  opts: { note?: string; occurredAt?: Date } = {},
): Promise<void> {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { status: true, appliedAt: true },
  });
  if (!app || app.status === toStatus) return;
  // appliedAt records the FIRST submission. Moving back to APPLIED (say, an
  // accidental OA corrected, or un-apply then re-apply) must not overwrite it.
  const stampApplied = toStatus === "APPLIED" && app.appliedAt === null;
  await prisma.$transaction([
    prisma.application.update({
      where: { id: applicationId },
      data: {
        status: toStatus,
        ...(stampApplied ? { appliedAt: opts.occurredAt ?? new Date() } : {}),
      },
    }),
    prisma.statusEvent.create({
      data: {
        applicationId,
        fromStatus: app.status,
        toStatus,
        occurredAt: opts.occurredAt ?? new Date(),
        note: opts.note,
      },
    }),
  ]);
}

const hasNotes = (v: string | null | undefined) => typeof v === "string" && v.trim() !== "";

/** Removes an application and its timeline together. */
async function dropApplication(applicationId: string): Promise<void> {
  await prisma.$transaction([
    prisma.statusEvent.deleteMany({ where: { applicationId } }),
    prisma.application.delete({ where: { id: applicationId } }),
  ]);
}

export async function commitImport(
  decisions: ImportDecision[],
  opts: { now?: Date } = {},
): Promise<CommitSummary> {
  const now = opts.now ?? new Date();
  const summary: CommitSummary = { linked: 0, manual: 0, updated: 0, unchanged: 0, failed: [] };

  for (const decision of decisions) {
    const { row } = decision;
    // A per-row value from the file wins over the review step's global
    // choice: it is more specific, and it is what makes an exported CSV
    // restore every row exactly as it was.
    const status: AppStatus = row.status ?? decision.status ?? "APPLIED";
    // Only a bare APPLIED row defaults to "now": stamping today onto, say, an
    // Interview row with no date would fabricate when it was submitted.
    const appliedAt = row.appliedAt
      ? new Date(row.appliedAt)
      : decision.appliedAt === undefined
        ? status === "APPLIED"
          ? now
          : null
        : decision.appliedAt;
    const notes = row.notes ?? decision.notes;

    try {
      // NOT_APPLIED exists only to hold notes (see lib/listings/mutations.ts).
      // A row saying "not applied" with nothing written on it records nothing,
      // so importing one must not create an invariant-violating row.
      if (status === "NOT_APPLIED" && !hasNotes(notes)) {
        const existing = decision.listingId
          ? await prisma.application.findUnique({
              where: { listingId: decision.listingId },
              select: { id: true, notes: true },
            })
          : await findManualApplication(row.company, row.role);
        if (existing && !hasNotes(existing.notes)) {
          await dropApplication(existing.id);
          summary.updated += 1;
        } else if (existing) {
          await recordStatus(existing.id, status, { note: "bulk import", occurredAt: now });
          summary.updated += 1;
        } else {
          summary.unchanged += 1;
        }
        continue;
      }

      if (decision.listingId) {
        const existing = await prisma.application.findUnique({
          where: { listingId: decision.listingId },
          select: { id: true, status: true },
        });

        if (existing) {
          // Re-importing the same list must not duplicate or clobber history.
          if (existing.status === status) {
            summary.unchanged += 1;
          } else {
            await recordStatus(existing.id, status, {
              note: "bulk import",
              occurredAt: now,
            });
            summary.updated += 1;
          }
          continue;
        }

        const created = await prisma.application.create({
          data: {
            listingId: decision.listingId,
            status,
            appliedAt,
            requisitionId: row.requisitionId,
            applyUrl: row.url,
            notes,
            // Manual fields are kept even when linked, so unlinking later (or a
            // bad merge upstream) never loses what the user actually typed.
            companyName: row.company,
            roleTitle: row.role,
            location: row.location,
          },
        });
        await prisma.statusEvent.create({
          data: { applicationId: created.id, toStatus: status, occurredAt: now, note: "bulk import" },
        });
        summary.linked += 1;
      } else {
        // Manual rows have no listing to key on, so dedupe on the normalized
        // company + role the user typed. Without this, re-pasting the same
        // list silently doubles every unmatched application.
        const existingManual = await findManualApplication(row.company, row.role);
        if (existingManual) {
          if (existingManual.status === status) {
            summary.unchanged += 1;
          } else {
            await recordStatus(existingManual.id, status, {
              note: "bulk import",
              occurredAt: now,
            });
            summary.updated += 1;
          }
          continue;
        }

        const created = await prisma.application.create({
          data: {
            listingId: null,
            companyName: row.company,
            roleTitle: row.role,
            location: row.location,
            status,
            appliedAt,
            requisitionId: row.requisitionId,
            applyUrl: row.url,
            notes,
          },
        });
        await prisma.statusEvent.create({
          data: { applicationId: created.id, toStatus: status, occurredAt: now, note: "bulk import (manual)" },
        });
        summary.manual += 1;
      }
    } catch (err) {
      summary.failed.push({
        lineNumber: row.lineNumber,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}

/** Listings the matcher should consider, in the shape `matchRows` expects. */
export async function loadMatchableListings() {
  const listings = await prisma.listing.findMany({
    select: {
      id: true,
      title: true,
      locations: true,
      url: true,
      requisitionId: true,
      finalScore: true,
      company: { select: { name: true } },
      application: { select: { id: true } },
    },
  });
  return listings.map((l) => ({
    id: l.id,
    company: l.company.name,
    title: l.title,
    locations: l.locations,
    url: l.url,
    requisitionId: l.requisitionId,
    finalScore: l.finalScore,
    applied: l.application !== null,
  }));
}
