import type {
  ContactKind,
  ContactStatus,
  OutreachChannel,
  OutreachDirection,
  OutreachType,
} from "@/generated/prisma/enums";
import type { ContactDetail, ContactRow } from "@/lib/networking/contacts";
import { MESSAGE_RULES, parseLinkedinUrl, type ContactInputRaw, type MessageInputRaw } from "@/lib/networking/schema";

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

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

export type ContactSort = "recent" | "next" | "pending";

export const SORT_LABELS: Record<ContactSort, string> = {
  recent: "recently updated",
  next: "next due",
  pending: "pending longest",
};

const time = (iso: string | null) => (iso ? Date.parse(iso) : null);

/** Returns a new array. Nulls sort last for "next" and "pending". */
export function sortContacts(rows: readonly ContactRow[], sort: ContactSort): ContactRow[] {
  const out = [...rows];
  const nullsLast = (a: number | null, b: number | null) =>
    a === null ? (b === null ? 0 : 1) : b === null ? -1 : a - b;
  if (sort === "next") out.sort((a, b) => nullsLast(time(a.nextFollowUpAt), time(b.nextFollowUpAt)));
  else if (sort === "pending") out.sort((a, b) => nullsLast(time(a.pendingSince), time(b.pendingSince)));
  else out.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return out;
}

// ---------------------------------------------------------------------------
// Due dates — always shown in the SERVER's follow-up zone, so a due day
// stored as local midnight never renders as "the evening before" in a
// browser west of it (and server and client render the same text).
// ---------------------------------------------------------------------------

export type DueKindLabel = "FOLLOW_UP" | "THANK_YOU" | "SEND_OPENER" | "CHECK_IN";

export const DUE_LABELS: Record<DueKindLabel, string> = {
  FOLLOW_UP: "follow up",
  THANK_YOU: "send a thank-you",
  SEND_OPENER: "send an opener",
  CHECK_IN: "check in",
};

/** "Fri, Oct 2" in `timeZone`. */
export function formatDueDay(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(
    new Date(iso),
  );
}

/** Whole calendar days from today to the due day, in `timeZone` (negative = overdue). */
export function daysUntil(iso: string, nowMs: number, timeZone: string): number {
  const day = (ms: number) =>
    Date.parse(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms));
  return Math.round((day(Date.parse(iso)) - day(nowMs)) / 86_400_000);
}

export function dueWhen(iso: string, nowMs: number, timeZone: string): { text: string; overdue: boolean } {
  const d = daysUntil(iso, nowMs, timeZone);
  if (d < 0) return { text: `overdue ${-d}d (${formatDueDay(iso, timeZone)})`, overdue: true };
  if (d === 0) return { text: "due today", overdue: false };
  if (d === 1) return { text: "due tomorrow", overdue: false };
  return { text: `due ${formatDueDay(iso, timeZone)}`, overdue: false };
}

// ---------------------------------------------------------------------------
// Log message form
// ---------------------------------------------------------------------------


export interface EventOption {
  value: string;
  direction: OutreachDirection;
  type: OutreachType;
  label: string;
}

/** The "what happened" picker, in the order you'd reach for them. */
export const EVENT_OPTIONS: EventOption[] = [
  { value: "OUT:COLD", direction: "OUT", type: "COLD", label: "I sent an opener (cold email / message)" },
  { value: "OUT:CONNECT_NOTE", direction: "OUT", type: "CONNECT_NOTE", label: "I sent a LinkedIn connection note" },
  { value: "IN:ACCEPTED", direction: "IN", type: "ACCEPTED", label: "They accepted my connection" },
  { value: "IN:REPLY", direction: "IN", type: "REPLY", label: "They replied" },
  { value: "OUT:REPLY", direction: "OUT", type: "REPLY", label: "I replied" },
  { value: "OUT:FOLLOW_UP", direction: "OUT", type: "FOLLOW_UP", label: "I followed up" },
  { value: "OUT:REFERRAL_ASK", direction: "OUT", type: "REFERRAL_ASK", label: "I asked for a referral" },
  { value: "OUT:MEETING", direction: "OUT", type: "MEETING", label: "We met (career fair, coffee chat, call)" },
  { value: "OUT:THANK_YOU", direction: "OUT", type: "THANK_YOU", label: "I sent a thank-you" },
];

export function channelsFor(direction: OutreachDirection, type: OutreachType): readonly OutreachChannel[] {
  return MESSAGE_RULES[direction][type] ?? [];
}

export interface MessageForm {
  event: string;
  channel: OutreachChannel;
  /** `datetime-local` value, in the browser's zone. */
  sentAtLocal: string;
  subject: string;
  body: string;
  listingId: string;
}

/** `YYYY-MM-DDTHH:mm` for a datetime-local input, in the browser's zone. */
export function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function emptyMessageForm(event = "OUT:COLD", now = new Date()): MessageForm {
  const opt = EVENT_OPTIONS.find((o) => o.value === event) ?? EVENT_OPTIONS[0];
  return {
    event: opt.value,
    channel: channelsFor(opt.direction, opt.type)[0],
    sentAtLocal: toLocalInput(now),
    subject: "",
    body: "",
    listingId: "",
  };
}

/** Switching the event keeps the channel when it's still allowed. */
export function withEvent(form: MessageForm, event: string): MessageForm {
  const opt = EVENT_OPTIONS.find((o) => o.value === event);
  if (!opt) return form;
  const allowed = channelsFor(opt.direction, opt.type);
  return { ...form, event, channel: allowed.includes(form.channel) ? form.channel : allowed[0] };
}

/** Subjects only mean something for email. */
export const showsSubject = (channel: OutreachChannel) => channel === "EMAIL";

export function messageFormToPayload(f: MessageForm): MessageInputRaw | { error: string } {
  const opt = EVENT_OPTIONS.find((o) => o.value === f.event);
  if (!opt) return { error: "pick what happened" };
  const sentAt = new Date(f.sentAtLocal);
  if (Number.isNaN(sentAt.getTime())) return { error: "pick when it happened" };
  return {
    direction: opt.direction,
    type: opt.type,
    channel: f.channel,
    subject: showsSubject(f.channel) ? f.subject : "",
    body: f.body,
    sentAt: sentAt.toISOString(),
    listingId: f.listingId || null,
  };
}
