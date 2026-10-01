import { prisma } from "@/lib/db";
import type { AppStatus } from "@/generated/prisma/enums";
import { followUpContext, storeFollowUpState } from "@/lib/networking/followups";
import { normalizeCompany } from "@/lib/ingestion/normalize";

/**
 * Who referred you, per application (`Application.referredByContactId`).
 *
 * Recording a referral also marks the contact REFERRED (a manual status,
 * dated now — see rule 2 in docs/NETWORKING_PLAN.md) and recomputes their
 * follow-up state in the same transaction, so the contact page, the Due list
 * and the tracker agree. Clearing a referral leaves the contact's status
 * alone: they may have referred you elsewhere, and you set it by hand anyway.
 */

export interface ReferralApplication {
  applicationId: string;
  company: string;
  role: string;
  status: AppStatus;
  /** Lowercased normalized company, to sort the contact's own company first. */
  companyKey: string | null;
  referredBy: { id: string; name: string } | null;
}

const appSelect = {
  id: true,
  status: true,
  companyName: true,
  roleTitle: true,
  referredBy: { select: { id: true, name: true } },
  listing: { select: { title: true, company: { select: { name: true, normalizedName: true } } } },
} as const;

type AppRecord = {
  id: string;
  status: AppStatus;
  companyName: string | null;
  roleTitle: string | null;
  referredBy: { id: string; name: string } | null;
  listing: { title: string; company: { name: string; normalizedName: string } } | null;
};

function toReferralApp(a: AppRecord): ReferralApplication {
  const company = a.listing?.company.name ?? a.companyName ?? "(unknown company)";
  return {
    applicationId: a.id,
    company,
    role: a.listing?.title ?? a.roleTitle ?? "(unknown role)",
    status: a.status,
    companyKey: a.listing?.company.normalizedName ?? (a.companyName ? normalizeCompany(a.companyName) : null),
    referredBy: a.referredBy,
  };
}

/** Applications (submitted or in progress — not NOT_APPLIED notes rows) a referral can be recorded on. */
export async function loadReferrableApplications(): Promise<ReferralApplication[]> {
  const apps = await prisma.application.findMany({
    where: { status: { not: "NOT_APPLIED" } },
    select: appSelect,
    orderBy: { updatedAt: "desc" },
  });
  return apps.map(toReferralApp);
}

/** The applications one contact referred you for. */
export async function loadContactReferrals(contactId: string): Promise<ReferralApplication[]> {
  const apps = await prisma.application.findMany({
    where: { referredByContactId: contactId },
    select: appSelect,
    orderBy: { updatedAt: "desc" },
  });
  return apps.map(toReferralApp);
}

/** Record (or, with null, clear) who referred you for an application. */
export async function setReferral(applicationId: string, contactId: string | null, now = new Date()): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const app = await tx.application.findUnique({ where: { id: applicationId }, select: { status: true } });
    if (!app) throw new Error(`no such application: ${applicationId}`);
    if (app.status === "NOT_APPLIED") {
      throw new Error("that's a notes-only row, not an application — mark it applied first");
    }
    if (contactId !== null) {
      const contact = await tx.contact.findUnique({
        where: { id: contactId },
        select: { manualStatus: true, status: true },
      });
      if (!contact) throw new Error(`no such contact: ${contactId}`);
      // Re-date unless they're ALREADY effectively REFERRED. A manual REFERRED
      // that a later opener (a new referral ask) has superseded doesn't count:
      // keeping its old date would leave them stuck in AWAITING_REPLY.
      if (contact.manualStatus !== "REFERRED" || contact.status !== "REFERRED") {
        await tx.contact.update({ where: { id: contactId }, data: { manualStatus: "REFERRED", manualStatusAt: now } });
      }
    }
    await tx.application.update({ where: { id: applicationId }, data: { referredByContactId: contactId } });
    if (contactId !== null) await storeFollowUpState(tx, contactId, await followUpContext(tx, now));
  });
}
