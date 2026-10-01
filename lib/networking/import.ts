import { detectDelimiter, splitRecords, splitWith, type Delimiter } from "@/lib/applications/import";
import { normalizeCompany } from "@/lib/ingestion/normalize";
import type { ContactKind } from "@/generated/prisma/enums";
import { contactInputSchema, parseLinkedinUrl, type ContactInput } from "@/lib/networking/schema";

/**
 * Bulk import of contacts from pasted text or a CSV — including LinkedIn's
 * own "Connections.csv" export (Settings → Data privacy → Get a copy of your
 * data → Connections), which starts with a few lines of notes before its
 * header and splits names into First Name / Last Name.
 *
 * Pure: no I/O. Every row goes through the SAME contactInputSchema the Add
 * Contact form uses, so an import can't store anything the form couldn't.
 * Duplicates (of each other, or of contacts already saved) are flagged, not
 * dropped: the review step decides.
 */

/** Keep a paste reasonable: one Server Action body, one review screen. */
export const IMPORT_MAX_ROWS = 2000;
export const IMPORT_MAX_CHARS = 1_000_000;

type Field = "name" | "firstName" | "lastName" | "company" | "title" | "kind" | "email" | "linkedinUrl" | "howMet" | "notes" | "connectedOn";

const HEADER_ALIASES: Record<string, Field> = {
  name: "name",
  "full name": "name",
  contact: "name",
  "first name": "firstName",
  first: "firstName",
  "given name": "firstName",
  "last name": "lastName",
  last: "lastName",
  surname: "lastName",
  "family name": "lastName",
  company: "company",
  employer: "company",
  organization: "company",
  org: "company",
  title: "title",
  position: "title",
  role: "title",
  "job title": "title",
  kind: "kind",
  type: "kind",
  relationship: "kind",
  email: "email",
  "email address": "email",
  "e-mail": "email",
  linkedin: "linkedinUrl",
  "linkedin url": "linkedinUrl",
  "profile url": "linkedinUrl",
  url: "linkedinUrl",
  "how met": "howMet",
  "how we met": "howMet",
  "how you met": "howMet",
  "met at": "howMet",
  source: "howMet",
  notes: "notes",
  note: "notes",
  comments: "notes",
  "connected on": "connectedOn",
};

const KIND_ALIASES: Record<string, ContactKind> = {
  recruiter: "RECRUITER",
  "university recruiter": "RECRUITER",
  "talent acquisition": "RECRUITER",
  engineer: "ENGINEER",
  swe: "ENGINEER",
  developer: "ENGINEER",
  "hiring manager": "HIRING_MANAGER",
  manager: "HIRING_MANAGER",
  hiring_manager: "HIRING_MANAGER",
  alumni: "ALUMNI",
  alum: "ALUMNI",
  alumnus: "ALUMNI",
  alumna: "ALUMNI",
  other: "OTHER",
};

/**
 * The kind from an explicit column if there is one, else a guess from the
 * title ("University Recruiter" → recruiter). A guess never overrides what the
 * file says, and an unrecognized explicit value is an error, not a default.
 */
function kindFor(explicit: string | undefined, title: string | undefined): ContactKind | null {
  if (explicit) return KIND_ALIASES[explicit.trim().toLowerCase()] ?? null;
  const t = (title ?? "").toLowerCase();
  if (/recruit|talent|sourcer/.test(t)) return "RECRUITER";
  // Only management of ENGINEERS: "Product Manager", "Account Manager" and
  // "Tech Lead" aren't the people who hire interns. A wrong guess here can't
  // be edited on the review screen, so guess narrowly.
  if (/(engineering|software|development) manager|hiring manager|director of engineering|head of engineering|\bcto\b/.test(t)) {
    return "HIRING_MANAGER";
  }
  if (/engineer|developer|swe\b|programmer/.test(t)) return "ENGINEER";
  return "OTHER";
}

export interface ParsedContactRow {
  lineNumber: number;
  /** Validated, exactly what createContact would store. */
  contact: ContactInput;
}

export interface ContactParseResult {
  rows: ParsedContactRow[];
  errors: Array<{ lineNumber: number; raw: string; reason: string }>;
  /** True when the input was recognized as LinkedIn's Connections export. */
  linkedInExport: boolean;
}

/**
 * Undo only this app's own CSV formula guard (an apostrophe in front of
 * = + - @). A third-party file — LinkedIn's export, a hand-made sheet — can
 * hold a real leading apostrophe, which must survive.
 */
function restoreGuardedFormula(value: string): string {
  return /^'[=+\-@]/.test(value) ? value.slice(1) : value;
}

function fieldsOf(line: string, delimiter: Delimiter): string[] {
  return splitWith(delimiter, line).map((f) => restoreGuardedFormula(f.replace(/^"([\s\S]*)"$/, "$1").trim()));
}

function headerColumns(fields: string[]): Array<Field | null> | null {
  const cols = fields.map((f) => HEADER_ALIASES[f.toLowerCase().trim()] ?? null);
  const has = (k: Field) => cols.includes(k);
  // A header must name the person — a full name, or a first/last pair.
  return has("name") || has("firstName") || has("lastName") ? cols : null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "12 Jan 2024" (LinkedIn's format) → "Connected on LinkedIn, Jan 2024".
 * Parsed by hand: `new Date("1 Jan 2024")` is LOCAL midnight, which a UTC
 * formatter east of UTC would turn into "Dec 2023". Anything else is kept as
 * written.
 */
function connectedPhrase(raw: string): string {
  const m = /^\s*\d{1,2}\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})\s*$/.exec(raw);
  const month = m ? MONTHS.find((x) => x.toLowerCase() === m[1].toLowerCase()) : undefined;
  return m && month ? `Connected on LinkedIn, ${month} ${m[2]}` : `Connected on LinkedIn (${raw.trim()})`;
}

/**
 * Header row required (in any column order), anywhere in the first lines —
 * lines before it (LinkedIn's "Notes:" preamble) are skipped. Without a
 * header there is no safe way to tell a title from a company.
 */
export function parseContactImport(text: string): ContactParseResult {
  const rows: ParsedContactRow[] = [];
  const errors: ContactParseResult["errors"] = [];
  let columns: Array<Field | null> | null = null;
  let delimiter: Delimiter | null = null;
  let linkedInExport = false;

  if (text.length > IMPORT_MAX_CHARS) {
    return {
      rows,
      errors: [{ lineNumber: 0, raw: "", reason: `too large — at most ${IMPORT_MAX_CHARS.toLocaleString()} characters` }],
      linkedInExport,
    };
  }

  for (const record of splitRecords(text)) {
    const trimmed = record.text.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // Split the record with only CR/LF and spaces stripped — NOT tabs: a
    // spreadsheet paste whose first cell is blank starts with a tab, and
    // trimming it would shift every column left by one.
    const line = record.text.replace(/^[ \r\n]+|[ \r\n]+$/g, "");

    if (columns === null) {
      const d = detectDelimiter(line);
      const cols = headerColumns(fieldsOf(line, d));
      if (cols) {
        columns = cols;
        delimiter = d;
        linkedInExport = cols.includes("connectedOn") && cols.includes("firstName");
      }
      // Anything before the header (a preamble) is skipped silently.
      continue;
    }

    if (rows.length + errors.length >= IMPORT_MAX_ROWS) {
      errors.push({ lineNumber: record.lineNumber, raw: "", reason: `stopped at ${IMPORT_MAX_ROWS} rows — split the file` });
      break;
    }

    const fields = fieldsOf(line, delimiter!);
    const v: Partial<Record<Field, string>> = {};
    columns.forEach((key, i) => {
      if (key && fields[i]) v[key] = fields[i];
    });

    const name = v.name ?? [v.firstName, v.lastName].filter(Boolean).join(" ");
    const kind = kindFor(v.kind, v.title);
    if (kind === null) {
      errors.push({ lineNumber: record.lineNumber, raw: line, reason: `unknown kind "${v.kind}"` });
      continue;
    }

    // LinkedIn's URL column is the profile; anything that isn't a linkedin.com
    // URL is left out rather than failing the whole row.
    const linkedinUrl = v.linkedinUrl && parseLinkedinUrl(v.linkedinUrl) ? v.linkedinUrl : null;
    const howMet = v.howMet ?? (v.connectedOn ? connectedPhrase(v.connectedOn) : null);

    const parsed = contactInputSchema.safeParse({
      name,
      company: v.company ?? null,
      title: v.title ?? null,
      kind,
      email: v.email ?? null,
      linkedinUrl,
      howMet,
      notes: v.notes ?? null,
      doNotContact: false,
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      errors.push({
        lineNumber: record.lineNumber,
        raw: line,
        reason: issue ? `${issue.path.join(".") || "row"}: ${issue.message}` : "invalid row",
      });
      continue;
    }
    if (parsed.data.company !== null && normalizeCompany(parsed.data.company) === "") {
      errors.push({
        lineNumber: record.lineNumber,
        raw: line,
        reason: `company "${parsed.data.company}" has no Latin letters or digits to match listings on`,
      });
      continue;
    }
    rows.push({ lineNumber: record.lineNumber, contact: parsed.data });
  }

  if (columns === null && text.trim() !== "") {
    errors.push({
      lineNumber: 1,
      raw: "",
      reason: "no header row found — the first row must name the columns, e.g. Name, Company, Title, Email",
    });
  }
  return { rows, errors, linkedInExport };
}

// ---------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------

export interface ExistingContactKey {
  id: string;
  name: string;
  companyKey: string | null;
  email: string | null;
  linkedinUrl: string | null;
}

export type DuplicateOf =
  | { kind: "existing"; contactId: string; name: string; reason: string }
  | { kind: "earlier-row"; lineNumber: number; reason: string };

/** Lowercased, trailing-slash-free profile path, so /in/x and /in/x/ match. */
function linkedinKey(url: string | null): string | null {
  const parsed = url ? parseLinkedinUrl(url) : null;
  if (!parsed) return null;
  const u = new URL(parsed);
  return u.pathname.replace(/\/+$/, "").toLowerCase();
}

function keysOf(c: { name: string; company: string | null; email: string | null; linkedinUrl: string | null }) {
  const company = c.company ? normalizeCompany(c.company) : null;
  return {
    email: c.email?.trim().toLowerCase() || null,
    linkedin: linkedinKey(c.linkedinUrl),
    nameCompany: company ? `${c.name.trim().toLowerCase().replace(/\s+/g, " ")}|${company}` : null,
  };
}

/**
 * Same email, same LinkedIn profile, or same name at the same company (by the
 * company normalizer) — against saved contacts first, then earlier rows.
 */
export function findDuplicates(
  rows: readonly ParsedContactRow[],
  existing: readonly ExistingContactKey[],
): Map<number, DuplicateOf> {
  const byEmail = new Map<string, DuplicateOf>();
  const byLinkedin = new Map<string, DuplicateOf>();
  const byNameCompany = new Map<string, DuplicateOf>();
  for (const e of existing) {
    const k = {
      email: e.email?.trim().toLowerCase() || null,
      linkedin: linkedinKey(e.linkedinUrl),
      nameCompany: e.companyKey ? `${e.name.trim().toLowerCase().replace(/\s+/g, " ")}|${e.companyKey}` : null,
    };
    if (k.email) byEmail.set(k.email, { kind: "existing", contactId: e.id, name: e.name, reason: "same email" });
    if (k.linkedin) byLinkedin.set(k.linkedin, { kind: "existing", contactId: e.id, name: e.name, reason: "same LinkedIn profile" });
    if (k.nameCompany) byNameCompany.set(k.nameCompany, { kind: "existing", contactId: e.id, name: e.name, reason: "same name and company" });
  }

  const out = new Map<number, DuplicateOf>();
  for (const r of rows) {
    const k = keysOf(r.contact);
    const hit =
      (k.email && byEmail.get(k.email)) ||
      (k.linkedin && byLinkedin.get(k.linkedin)) ||
      (k.nameCompany && byNameCompany.get(k.nameCompany)) ||
      null;
    if (hit) out.set(r.lineNumber, hit);
    // Register EVERY row's keys (first claim wins), duplicates included: a
    // later row that matches this one only by a key the saved contact lacked
    // is still the same person.
    const mine = (reason: string): DuplicateOf => ({ kind: "earlier-row", lineNumber: r.lineNumber, reason });
    if (k.email && !byEmail.has(k.email)) byEmail.set(k.email, mine("same email"));
    if (k.linkedin && !byLinkedin.has(k.linkedin)) byLinkedin.set(k.linkedin, mine("same LinkedIn profile"));
    if (k.nameCompany && !byNameCompany.has(k.nameCompany)) byNameCompany.set(k.nameCompany, mine("same name and company"));
  }
  return out;
}
