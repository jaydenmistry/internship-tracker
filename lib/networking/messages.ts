import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import type {
  ContactStatus,
  OutreachChannel,
  OutreachDirection,
  OutreachType,
} from "@/generated/prisma/enums";
import { followUpContext, storeFollowUpState } from "@/lib/networking/followups";
import type { FollowUpState } from "@/lib/networking/followup";
import type { MessageEdit, MessageInput } from "@/lib/networking/schema";

/**
 * Outreach-message mutations and the contact-page reads that go with them.
 *
 * Every write here runs in ONE transaction with the follow-up recompute, so a
 * contact's stored status can never disagree with its messages — not even
 * briefly, and not when the second statement fails.
 *
 * Message text is typed (or pasted) by the user and rendered as text only.
 */

export interface TimelineMessage {
  id: string;
  direction: OutreachDirection;
  channel: OutreachChannel;
  type: OutreachType;
  subject: string | null;
  body: string;
  sentAt: string;
  listing: { id: string; title: string } | null;
  /** True when this was a Claude draft you then sent (phase 3). */
  drafted: boolean;
}

export async function loadTimeline(contactId: string): Promise<TimelineMessage[]> {
  const rows = await prisma.outreachMessage.findMany({
    where: { contactId },
    orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      direction: true,
      channel: true,
      type: true,
      subject: true,
      body: true,
      sentAt: true,
      draftBody: true,
      listing: { select: { id: true, title: true } },
    },
  });
  return rows.map((m) => ({
    id: m.id,
    direction: m.direction,
    channel: m.channel,
    type: m.type,
    subject: m.subject,
    body: m.body,
    sentAt: m.sentAt.toISOString(),
    listing: m.listing,
    drafted: m.draftBody !== null,
  }));
}

export interface CompanyListingOption {
  id: string;
  title: string;
}

/** Listings at a company a message can be "about", best-ranked first. */
export async function loadCompanyListings(companyId: string | null): Promise<CompanyListingOption[]> {
  if (!companyId) return [];
  return prisma.listing.findMany({
    where: { companyId, dismissed: false },
    select: { id: true, title: true },
    orderBy: [{ rank: { sort: "asc", nulls: "last" } }, { firstSeen: "desc" }],
    take: 100,
  });
}

async function ensureListingAtCompany(
  tx: Prisma.TransactionClient,
  contactId: string,
  listingId: string | null,
): Promise<void> {
  if (listingId === null) return;
  // Sequential: one transaction is one connection, and concurrent statements
  // through the `prisma dev` proxy have failed with "bind message" errors.
  const contact = await tx.contact.findUniqueOrThrow({ where: { id: contactId }, select: { companyId: true } });
  const listing = await tx.listing.findUnique({ where: { id: listingId }, select: { companyId: true } });
  // A message is only ever "about" a role at the contact's own company.
  if (!listing || listing.companyId !== contact.companyId) {
    throw new Error("that listing isn't at this contact's company");
  }
}

export async function logMessage(contactId: string, input: MessageInput, now = new Date()): Promise<FollowUpState> {
  return prisma.$transaction(async (tx) => {
    const ctx = await followUpContext(tx, now);
    const exists = await tx.contact.findUnique({ where: { id: contactId }, select: { id: true } });
    if (!exists) throw new Error(`no such contact: ${contactId}`);
    await ensureListingAtCompany(tx, contactId, input.listingId);
    await tx.outreachMessage.create({
      data: {
        contactId,
        direction: input.direction,
        channel: input.channel,
        type: input.type,
        subject: input.subject,
        body: input.body,
        sentAt: input.sentAt,
        listingId: input.listingId,
      },
    });
    // Logging anything ends a snooze: the thing you were waiting on happened.
    await tx.contact.update({ where: { id: contactId }, data: { followUpOverrideAt: null } });
    return storeFollowUpState(tx, contactId, ctx);
  });
}

export async function editMessage(messageId: string, edit: MessageEdit, now = new Date()): Promise<FollowUpState> {
  return prisma.$transaction(async (tx) => {
    const ctx = await followUpContext(tx, now);
    const m = await tx.outreachMessage.findUnique({ where: { id: messageId }, select: { contactId: true } });
    if (!m) throw new Error(`no such message: ${messageId}`);
    await tx.outreachMessage.update({
      where: { id: messageId },
      data: { subject: edit.subject, body: edit.body, sentAt: edit.sentAt },
    });
    return storeFollowUpState(tx, m.contactId, ctx);
  });
}

export async function deleteMessage(messageId: string, now = new Date()): Promise<FollowUpState> {
  return prisma.$transaction(async (tx) => {
    const ctx = await followUpContext(tx, now);
    const m = await tx.outreachMessage.findUnique({ where: { id: messageId }, select: { contactId: true } });
    if (!m) throw new Error(`no such message: ${messageId}`);
    await tx.outreachMessage.delete({ where: { id: messageId } });
    return storeFollowUpState(tx, m.contactId, ctx);
  });
}

/** CHATTED / REFERRED by hand, or null to clear. Dated now, for rule 2. */
export async function setManualStatus(
  contactId: string,
  status: Extract<ContactStatus, "CHATTED" | "REFERRED"> | null,
  now = new Date(),
): Promise<FollowUpState> {
  return prisma.$transaction(async (tx) => {
    const ctx = await followUpContext(tx, now);
    await tx.contact.update({
      where: { id: contactId },
      data: { manualStatus: status, manualStatusAt: status ? now : null },
    });
    return storeFollowUpState(tx, contactId, ctx);
  });
}

/** Snooze to a date (local midnight, computed by the caller), or null to clear. */
export async function setSnooze(contactId: string, until: Date | null, now = new Date()): Promise<FollowUpState> {
  return prisma.$transaction(async (tx) => {
    const ctx = await followUpContext(tx, now);
    await tx.contact.update({ where: { id: contactId }, data: { followUpOverrideAt: until } });
    return storeFollowUpState(tx, contactId, ctx);
  });
}
