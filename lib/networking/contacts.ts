import { prisma } from "@/lib/db";
import type { ContactKind, ContactStatus } from "@/generated/prisma/enums";
import { normalizeCompany } from "@/lib/ingestion/normalize";
import type { ContactInput } from "@/lib/networking/schema";

/**
 * Read/write model for networking contacts.
 *
 * The derived follow-up fields (`status`, `nextFollowUpAt`, `followUpsSent`)
 * are NOT written here — only by computeFollowUpState() once messages exist
 * (phase 2). A contact's details never change its follow-up state.
 *
 * Every string on a contact is user-typed and rendered as plain text only.
 */

export interface ContactRow {
  id: string;
  name: string;
  companyId: string | null;
  company: string | null;
  /** Company.normalizedName — what /network?companyKey= filters on exactly. */
  companyKey: string | null;
  title: string | null;
  kind: ContactKind;
  email: string | null;
  linkedinUrl: string | null;
  status: ContactStatus;
  doNotContact: boolean;
  nextFollowUpAt: string | null;
  /** When the latest message in either direction was sent, if any. */
  lastMessageAt: string | null;
  updatedAt: string;
}

export interface ContactDetail extends ContactRow {
  howMet: string | null;
  notes: string | null;
  followUpsSent: number;
  createdAt: string;
  /** Listings at this contact's company, for context on the contact page. */
  companyListingCount: number;
}

/** Compact form for the listing detail panel's "People at {Company}". */
export interface CompanyPerson {
  id: string;
  name: string;
  title: string | null;
  kind: ContactKind;
  status: ContactStatus;
  doNotContact: boolean;
  lastMessageAt: string | null;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

const rowSelect = {
  id: true,
  name: true,
  companyId: true,
  company: { select: { name: true, normalizedName: true } },
  title: true,
  kind: true,
  email: true,
  linkedinUrl: true,
  status: true,
  doNotContact: true,
  nextFollowUpAt: true,
  updatedAt: true,
  messages: { orderBy: { sentAt: "desc" }, take: 1, select: { sentAt: true } },
} as const;

type RowRecord = {
  id: string;
  name: string;
  companyId: string | null;
  company: { name: string; normalizedName: string } | null;
  title: string | null;
  kind: ContactKind;
  email: string | null;
  linkedinUrl: string | null;
  status: ContactStatus;
  doNotContact: boolean;
  nextFollowUpAt: Date | null;
  updatedAt: Date;
  messages: Array<{ sentAt: Date }>;
};

function toRow(c: RowRecord): ContactRow {
  return {
    id: c.id,
    name: c.name,
    companyId: c.companyId,
    company: c.company?.name ?? null,
    companyKey: c.company?.normalizedName ?? null,
    title: c.title,
    kind: c.kind,
    email: c.email,
    linkedinUrl: c.linkedinUrl,
    status: c.status,
    doNotContact: c.doNotContact,
    nextFollowUpAt: iso(c.nextFollowUpAt),
    lastMessageAt: iso(c.messages[0]?.sentAt),
    updatedAt: c.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Company resolution
// ---------------------------------------------------------------------------

/**
 * The Company row for a typed name, created if the app has never seen it.
 *
 * Uses the SAME normalizer as ingestion, so a listing ingested later for
 * "Stripe, Inc." attaches to the row a contact created as "Stripe" — which is
 * how "People at {Company}" appears on a listing without any linking step.
 * An upsert with an empty update: never renames or re-flags an existing row.
 *
 * Throws for a name that normalizes to nothing — punctuation only, or a
 * non-Latin script the normalizer strips entirely. Saving the contact with no
 * company would silently drop what the user typed.
 */
export class UnmatchableCompanyError extends Error {
  constructor(name: string) {
    super(
      `"${name}" has no Latin letters or digits to match listings on; ` +
        `type the company's English name (or leave Company blank).`,
    );
    this.name = "UnmatchableCompanyError";
  }
}

export async function resolveCompany(name: string | null): Promise<string | null> {
  if (name === null) return null;
  const normalizedName = normalizeCompany(name);
  if (normalizedName === "") throw new UnmatchableCompanyError(name);
  const company = await prisma.company.upsert({
    where: { normalizedName },
    create: { name, normalizedName },
    update: {},
    select: { id: true },
  });
  return company.id;
}

/**
 * Company names for the Add Contact autocomplete, A→Z: only companies with at
 * least one listing or contact, so a row left behind when its last contact
 * moved or was deleted doesn't linger in the suggestions.
 */
export async function loadCompanyNames(): Promise<string[]> {
  const rows = await prisma.company.findMany({
    where: { OR: [{ listings: { some: {} } }, { contacts: { some: {} } }] },
    select: { name: true },
    orderBy: { name: "asc" },
  });
  return rows.map((r) => r.name);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function loadContacts(): Promise<ContactRow[]> {
  const rows = await prisma.contact.findMany({ select: rowSelect, orderBy: { updatedAt: "desc" } });
  return rows.map(toRow);
}

export async function loadContact(id: string): Promise<ContactDetail | null> {
  const c = await prisma.contact.findUnique({
    where: { id },
    select: {
      ...rowSelect,
      howMet: true,
      notes: true,
      followUpsSent: true,
      createdAt: true,
      company: { select: { name: true, normalizedName: true, _count: { select: { listings: true } } } },
    },
  });
  if (!c) return null;
  return {
    ...toRow(c),
    howMet: c.howMet,
    notes: c.notes,
    followUpsSent: c.followUpsSent,
    createdAt: c.createdAt.toISOString(),
    companyListingCount: c.company?._count.listings ?? 0,
  };
}

/** Everyone at one company, most recently in touch first, then by name. */
export async function loadCompanyPeople(companyId: string): Promise<CompanyPerson[]> {
  const rows = await prisma.contact.findMany({
    where: { companyId },
    select: {
      id: true,
      name: true,
      title: true,
      kind: true,
      status: true,
      doNotContact: true,
      messages: { orderBy: { sentAt: "desc" }, take: 1, select: { sentAt: true } },
    },
    orderBy: { name: "asc" },
  });
  return rows
    .map((c) => ({
      id: c.id,
      name: c.name,
      title: c.title,
      kind: c.kind,
      status: c.status,
      doNotContact: c.doNotContact,
      lastMessageAt: iso(c.messages[0]?.sentAt),
    }))
    .sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
}

/**
 * Contact counts keyed by Company.normalizedName, for the tracker cards.
 * Keyed by normalized name rather than id so a MANUAL application — which has
 * only a typed company name, no listing — still finds the people there.
 */
export async function loadContactCountsByCompany(): Promise<Map<string, number>> {
  // Keys are Company.normalizedName; the tracker badge links with the same key
  // (/network?companyKey=), so the count and the filtered page always agree.
  const groups = await prisma.contact.groupBy({
    by: ["companyId"],
    where: { companyId: { not: null } },
    _count: { _all: true },
  });
  if (groups.length === 0) return new Map();
  const companies = await prisma.company.findMany({
    where: { id: { in: groups.map((g) => g.companyId as string) } },
    select: { id: true, normalizedName: true },
  });
  const nameById = new Map(companies.map((c) => [c.id, c.normalizedName]));
  const counts = new Map<string, number>();
  for (const g of groups) {
    const key = nameById.get(g.companyId as string);
    if (key) counts.set(key, g._count._all);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function fields(input: ContactInput, companyId: string | null) {
  return {
    name: input.name,
    companyId,
    title: input.title,
    kind: input.kind,
    email: input.email,
    linkedinUrl: input.linkedinUrl,
    howMet: input.howMet,
    notes: input.notes,
    doNotContact: input.doNotContact,
  };
}

export async function createContact(input: ContactInput): Promise<{ id: string }> {
  const companyId = await resolveCompany(input.company);
  return prisma.contact.create({ data: fields(input, companyId), select: { id: true } });
}

export async function updateContact(id: string, input: ContactInput): Promise<void> {
  const companyId = await resolveCompany(input.company);
  const { count } = await prisma.contact.updateMany({ where: { id }, data: fields(input, companyId) });
  if (count === 0) throw new Error(`no such contact: ${id}`);
}

/**
 * A REAL delete — deliberate for third-party personal data. Messages cascade;
 * an application this person referred keeps existing, with the referral
 * cleared (onDelete: SetNull). `doNotContact` is the "stop, but keep the
 * record" option.
 */
export async function deleteContact(id: string): Promise<void> {
  const { count } = await prisma.contact.deleteMany({ where: { id } });
  if (count === 0) throw new Error(`no such contact: ${id}`);
}
