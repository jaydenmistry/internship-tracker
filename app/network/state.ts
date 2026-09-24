import type { ContactKind, ContactStatus } from "@/generated/prisma/enums";
import type { ContactDetail, ContactRow } from "@/lib/networking/contacts";
import { parseLinkedinUrl, type ContactInputRaw } from "@/lib/networking/schema";

/**
 * Pure presentation logic for /network. No React, no DOM, no I/O. Imports only
 * TYPES from lib/networking/contacts (which pulls in Prisma and must never
 * reach the client bundle).
 */

export { absoluteDate, relativeAge } from "@/app/tracker/state";

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

export interface ContactFilters {
  query: string;
  /** Exact Company.normalizedName, from a tracker badge. Null = any company. */
  companyKey: string | null;
  kinds: ReadonlySet<ContactKind>;
  statuses: ReadonlySet<ContactStatus>;
}

export const EMPTY_FILTERS: ContactFilters = {
  query: "",
  companyKey: null,
  kinds: new Set(),
  statuses: new Set(),
};

/**
 * Case-insensitive substring match over name, company, title and email; every
 * whitespace-separated term must match somewhere ("stripe recruiter" works).
 * An empty kind/status set means "any".
 */
export function filterContacts(rows: readonly ContactRow[], f: ContactFilters): ContactRow[] {
  const terms = f.query.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((r) => {
    if (f.companyKey !== null && r.companyKey !== f.companyKey) return false;
    if (f.kinds.size > 0 && !f.kinds.has(r.kind)) return false;
    if (f.statuses.size > 0 && !f.statuses.has(r.status)) return false;
    if (terms.length === 0) return true;
    const haystack = [r.name, r.company, r.title, r.email].filter(Boolean).join(" ").toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
}

export interface CompanyOption {
  key: string;
  name: string;
  count: number;
}

/**
 * The company filter's options: every company that has a contact, A→Z, with
 * its count. A key selected via URL that no contact has (e.g. the last person
 * there was deleted) is kept as an option so the select can show it.
 */
export function companiesOf(rows: readonly ContactRow[], selected: string | null = null): CompanyOption[] {
  const byKey = new Map<string, CompanyOption>();
  for (const r of rows) {
    if (r.companyKey === null || r.company === null) continue;
    const o = byKey.get(r.companyKey);
    if (o) o.count += 1;
    else byKey.set(r.companyKey, { key: r.companyKey, name: r.company, count: 1 });
  }
  if (selected !== null && !byKey.has(selected)) byKey.set(selected, { key: selected, name: selected, count: 0 });
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
}

/** Toggle one member of a filter set, returning a new set. */
export function toggle<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

/** Every field as the form edits it: strings, never null. */
export interface ContactForm {
  name: string;
  company: string;
  title: string;
  kind: ContactKind;
  email: string;
  linkedinUrl: string;
  howMet: string;
  notes: string;
  doNotContact: boolean;
}

export function emptyForm(company = ""): ContactForm {
  return {
    name: "",
    company,
    title: "",
    kind: "OTHER",
    email: "",
    linkedinUrl: "",
    howMet: "",
    notes: "",
    doNotContact: false,
  };
}

export function formFromContact(c: ContactDetail): ContactForm {
  return {
    name: c.name,
    company: c.company ?? "",
    title: c.title ?? "",
    kind: c.kind,
    email: c.email ?? "",
    linkedinUrl: c.linkedinUrl ?? "",
    howMet: c.howMet ?? "",
    notes: c.notes ?? "",
    doNotContact: c.doNotContact,
  };
}

/** The Server Action payload. Validation happens there, not here. */
export function formToPayload(f: ContactForm): ContactInputRaw {
  return { ...f };
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/**
 * Re-checked on render even though it was checked on write: an `href` is the
 * one place React does not escape, so the render path never trusts storage.
 */
export function linkedinHref(url: string | null): string | null {
  return url ? parseLinkedinUrl(url) : null;
}

/** A mailto: for a plain address, or null if it contains anything odd. */
export function mailtoHref(email: string | null): string | null {
  if (!email) return null;
  const trimmed = email.trim();
  // No whitespace, no header-injection characters, exactly one @.
  if (!/^[^\s@?&#<>"]+@[^\s@?&#<>"]+$/.test(trimmed)) return null;
  return `mailto:${trimmed}`;
}

/** Where the listing panel's "add contact" link goes, company prefilled. */
export function addContactHref(company: string): string {
  return `/network?add=1&company=${encodeURIComponent(company)}`;
}
