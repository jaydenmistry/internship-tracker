import {
  canonicalizeUrl,
  extractRequisitionId,
  normalizeCompany,
  normalizeTitle,
  titleSimilarity,
} from "@/lib/ingestion/normalize";
import type { AppStatus } from "@/generated/prisma/enums";
import { restoreFormulaPrefix } from "@/lib/applications/csv";

/**
 * Bulk import of applications the user already submitted.
 *
 * Pure parsing + matching: no I/O, no DB. Nothing here writes anything — the
 * caller shows proposed matches for confirmation first, because a wrong
 * auto-match would silently mark the wrong role as applied and hide it.
 */

export interface ImportRow {
  company: string;
  role: string;
  location?: string;
  requisitionId?: string;
  url?: string;
  /** Per-row status (header "Status"). When present it wins over the review
   *  step's global status, so an exported CSV restores each row exactly. */
  status?: AppStatus;
  /** ISO date from an "Applied" column. */
  appliedAt?: string;
  notes?: string;
  /** 1-based line number in the pasted text, for error reporting. */
  lineNumber: number;
  raw: string;
}

export interface ParseResult {
  rows: ImportRow[];
  errors: Array<{ lineNumber: number; raw: string; reason: string }>;
}

/** A listing the row might refer to. Kept minimal so callers can select narrowly. */
export interface MatchableListing {
  id: string;
  company: string;
  title: string;
  locations: string[];
  url: string;
  requisitionId: string | null;
  finalScore: number | null;
  applied: boolean;
}

export interface MatchCandidate {
  listing: MatchableListing;
  /** 0–1. 1.0 only for proven identity (URL or requisition id). */
  confidence: number;
  reasons: string[];
}

export type MatchVerdict = "exact" | "strong" | "likely" | "weak" | "none";

/**
 * What the catalog knows about the company, independent of whether any role
 * matched. "Company absent entirely" and "company present but no role matches"
 * mean different things: the second says the posting probably closed or was
 * never carried by the sources, which is worth going to check.
 */
export interface CompanyContext {
  company: string;
  roleCount: number;
  sampleTitles: string[];
}

export interface RowMatch {
  row: ImportRow;
  best: MatchCandidate | null;
  alternatives: MatchCandidate[];
  verdict: MatchVerdict;
  companyContext: CompanyContext | null;
}

const HEADER_ALIASES: Record<string, keyof ImportRow> = {
  company: "company",
  employer: "company",
  organization: "company",
  org: "company",
  role: "role",
  title: "role",
  position: "role",
  job: "role",
  "job title": "role",
  location: "location",
  loc: "location",
  city: "location",
  req: "requisitionId",
  "req id": "requisitionId",
  reqid: "requisitionId",
  requisition: "requisitionId",
  "requisition id": "requisitionId",
  url: "url",
  link: "url",
  "job url": "url",
  "apply url": "url",
  status: "status",
  stage: "status",
  applied: "appliedAt",
  "applied at": "appliedAt",
  "applied on": "appliedAt",
  "date applied": "appliedAt",
  "applied date": "appliedAt",
  date: "appliedAt",
  notes: "notes",
  note: "notes",
  comments: "notes",
};

/** Accepts enum values (PHONE_SCREEN) and the words people actually type. */
const STATUS_ALIASES: Record<string, AppStatus> = {
  "not applied": "NOT_APPLIED",
  applied: "APPLIED",
  submitted: "APPLIED",
  oa: "OA",
  "online assessment": "OA",
  assessment: "OA",
  "coding challenge": "OA",
  "phone screen": "PHONE_SCREEN",
  phone: "PHONE_SCREEN",
  "recruiter screen": "PHONE_SCREEN",
  screen: "PHONE_SCREEN",
  interview: "INTERVIEW",
  interviewing: "INTERVIEW",
  onsite: "INTERVIEW",
  "final round": "INTERVIEW",
  offer: "OFFER",
  rejected: "REJECTED",
  rejection: "REJECTED",
  declined: "REJECTED",
  closed: "CLOSED",
  skipped: "SKIPPED",
  skip: "SKIPPED",
};

export function parseStatus(raw: string): AppStatus | null {
  const key = raw.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  return STATUS_ALIASES[key] ?? null;
}

/** YYYY-MM-DD (what the export writes) or any unambiguous full date. */
export function parseAppliedDate(raw: string): string | null {
  const v = raw.trim();
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const d = ymd
    ? new Date(Date.UTC(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])))
    : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  // Guard against Date's silent rollover: 2026-02-31 → March 3, and
  // 2026-13-01 → January 2027. Every component must survive unchanged.
  if (
    ymd &&
    (d.getUTCFullYear() !== Number(ymd[1]) ||
      d.getUTCMonth() !== Number(ymd[2]) - 1 ||
      d.getUTCDate() !== Number(ymd[3]))
  ) {
    return null;
  }
  return d.toISOString();
}

type Delimiter = "tab" | "pipe" | "comma" | "dash" | "none";

function detectDelimiter(record: string): Delimiter {
  if (record.includes("\t")) return "tab";
  if (record.includes("|")) return "pipe";
  if (record.includes(",")) return "comma";
  if (/\s[–—-]\s/.test(record)) return "dash";
  return "none";
}

/** A quote only opens a quoted field at the START of a field (RFC 4180), so a
 *  stray inch mark — `6" display` — is literal text, not a runaway quote. */
function atFieldStart(cur: string, sep: string): boolean {
  const t = cur.trimEnd();
  return t === "" || t.endsWith(sep);
}

function splitComma(record: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < record.length; i += 1) {
    const c = record[i];
    if (c === '"') {
      if (quoted && record[i + 1] === '"') {
        cur += '"';
        i += 1;
        continue;
      }
      if (quoted) {
        quoted = false;
        continue;
      }
      if (cur.trim() === "") {
        quoted = true;
        cur = "";
        continue;
      }
      cur += c;
    } else if (c === "," && !quoted) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

function splitWith(delimiter: Delimiter, record: string): string[] {
  switch (delimiter) {
    case "tab":
      return record.split("\t").map((s) => s.trim());
    case "pipe":
      return record.split("|").map((s) => s.trim());
    case "comma":
      return splitComma(record);
    case "dash":
      return record.split(/\s[–—-]\s/).map((s) => s.trim());
    default:
      return [record.trim()];
  }
}

/**
 * Splits text into logical records. A newline inside a quoted field (a
 * multi-line note in an exported CSV) does not end the record. Each record
 * keeps the line number it started on, for error messages.
 */
function splitRecords(text: string): Array<{ text: string; lineNumber: number }> {
  const out: Array<{ text: string; lineNumber: number }> = [];
  let cur = "";
  let inQuotes = false;
  let line = 1;
  let startLine = 1;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') {
      if (inQuotes && text[i + 1] === '"') {
        cur += '""';
        i += 1;
        continue;
      }
      if (inQuotes) inQuotes = false;
      else if (atFieldStart(cur, ",")) inQuotes = true;
      cur += c;
      continue;
    }
    if (c === "\r" && text[i + 1] === "\n") continue;
    if (c === "\n") {
      line += 1;
      if (inQuotes) {
        cur += "\n";
        continue;
      }
      out.push({ text: cur, lineNumber: startLine });
      cur = "";
      startLine = line;
      continue;
    }
    cur += c;
  }
  if (cur.length > 0) out.push({ text: cur, lineNumber: startLine });
  return out;
}

function looksLikeHeader(fields: string[]): boolean {
  const lowered = fields.map((f) => f.toLowerCase().replace(/^"|"$/g, "").trim());
  return lowered.some((f) => f in HEADER_ALIASES) && lowered.every((f) => f.length < 24);
}

/**
 * Parses pasted text or CSV. Accepts a header row (in any column order) or
 * positional "Company, Role, Location, ReqId, Url". With a header, optional
 * Status / Applied / Notes columns restore per-row state — which is what makes
 * the tracker's CSV export round-trip.
 *
 * The delimiter is chosen once from the first record so a comma CSV whose notes
 * contain "|" isn't re-split per line; a record that yields a single field
 * under it falls back to its own detection, for mixed freeform pastes.
 */
export function parseImportText(text: string): ParseResult {
  const rows: ImportRow[] = [];
  const errors: ParseResult["errors"] = [];

  let columns: Array<keyof ImportRow | null> | null = null;
  let delimiter: Delimiter | null = null;

  for (const record of splitRecords(text)) {
    const { lineNumber } = record;
    const line = record.text.trim();
    if (!line || line.startsWith("#")) continue;

    if (delimiter === null) delimiter = detectDelimiter(line);
    let fields = splitWith(delimiter, line);
    if (fields.length === 1) {
      const own = detectDelimiter(line);
      if (own !== delimiter) fields = splitWith(own, line);
    }
    fields = fields.map((f) => restoreFormulaPrefix(f.replace(/^"([\s\S]*)"$/, "$1").trim()));

    if (columns === null && looksLikeHeader(fields)) {
      columns = fields.map((f) => HEADER_ALIASES[f.toLowerCase().trim()] ?? null);
      continue;
    }

    const row: Record<string, string> = {};
    if (columns) {
      columns.forEach((key, i) => {
        if (key && fields[i]) row[key] = fields[i];
      });
    } else {
      // Positional fallback. A bare URL in any field is recognized as the URL.
      const [company, role, location, reqOrUrl, maybeUrl] = fields;
      if (company) row.company = company;
      if (role) row.role = role;
      if (location) row.location = location;
      for (const v of [reqOrUrl, maybeUrl]) {
        if (!v) continue;
        if (/^https?:\/\//i.test(v)) row.url = v;
        else row.requisitionId = v;
      }
    }

    // A URL sitting in the location/req column is still a URL.
    for (const key of ["location", "requisitionId"] as const) {
      const v = row[key];
      if (v && /^https?:\/\//i.test(v)) {
        row.url = row.url ?? v;
        delete row[key];
      }
    }

    if (!row.company || !row.role) {
      errors.push({
        lineNumber,
        raw: line,
        reason:
          !row.company && !row.role
            ? "could not find a company or a role"
            : `missing ${!row.company ? "company" : "role"}`,
      });
      continue;
    }

    // Strict on purpose: silently defaulting an unrecognized status to
    // "Applied" would mark a role as submitted that may not have been.
    let status: AppStatus | undefined;
    if (row.status) {
      const parsed = parseStatus(row.status);
      if (!parsed) {
        errors.push({ lineNumber, raw: line, reason: `unknown status "${row.status}"` });
        continue;
      }
      status = parsed;
    }
    let appliedAt: string | undefined;
    if (row.appliedAt) {
      const parsed = parseAppliedDate(row.appliedAt);
      if (!parsed) {
        errors.push({ lineNumber, raw: line, reason: `unreadable applied date "${row.appliedAt}"` });
        continue;
      }
      appliedAt = parsed;
    }

    rows.push({
      company: row.company,
      role: row.role,
      location: row.location,
      requisitionId: row.requisitionId,
      url: row.url,
      status,
      appliedAt,
      notes: row.notes,
      lineNumber,
      raw: line,
    });
  }

  return { rows, errors };
}

/** Punctuation-insensitive: "Menlo Park CA" and "Menlo Park, CA" are the same place. */
function normalizeLocation(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,/()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Loose location agreement: same string, containment, or a shared city token. */
function locationAgrees(rowLocation: string | undefined, listingLocations: string[]): boolean {
  if (!rowLocation) return false;
  const a = normalizeLocation(rowLocation);
  if (!a) return false;
  if (/\bremote\b/.test(a) && listingLocations.some((l) => /remote/i.test(l))) return true;

  return listingLocations.some((raw) => {
    const b = normalizeLocation(raw);
    if (!b) return false;
    if (a === b || a.includes(b) || b.includes(a)) return true;
    // Shared city token. Tokens of 2 characters are excluded on purpose: "CA"
    // is both California and Canada, and matching on it alone is meaningless.
    const aTokens = new Set(a.split(" ").filter((t) => t.length > 2));
    return b.split(" ").some((t) => t.length > 2 && aTokens.has(t));
  });
}

const COMPANY_MATCH_FLOOR = 0.6;
const TITLE_MATCH_FLOOR = 0.45;

function scoreCandidate(row: ImportRow, listing: MatchableListing): MatchCandidate | null {
  const reasons: string[] = [];

  // Proven identity first — these beat any fuzzy signal.
  if (row.url && listing.url && canonicalizeUrl(row.url) === canonicalizeUrl(listing.url)) {
    return { listing, confidence: 1, reasons: ["exact URL match"] };
  }
  const rowReq = row.requisitionId ?? (row.url ? extractRequisitionId(row.url) : null);
  if (rowReq && listing.requisitionId && rowReq === listing.requisitionId) {
    return { listing, confidence: 0.98, reasons: [`requisition id match (${rowReq})`] };
  }

  const companySim = titleSimilarity(
    normalizeCompany(row.company),
    normalizeCompany(listing.company),
  );
  if (companySim < COMPANY_MATCH_FLOOR) return null;

  const titleSim = titleSimilarity(normalizeTitle(row.role), normalizeTitle(listing.title));
  if (titleSim < TITLE_MATCH_FLOOR) return null;

  reasons.push(
    companySim === 1 ? "company matches" : `company ~${Math.round(companySim * 100)}%`,
  );
  reasons.push(titleSim === 1 ? "role matches" : `role ~${Math.round(titleSim * 100)}%`);

  // Company identity is the stronger signal; the role title varies more across
  // sources ("SWE Intern" vs "Software Engineer Intern, Summer 2027").
  let confidence = companySim * 0.45 + titleSim * 0.45;

  if (locationAgrees(row.location, listing.locations)) {
    confidence += 0.1;
    reasons.push("location agrees");
  } else if (row.location && listing.locations.length > 0) {
    confidence -= 0.05;
    reasons.push("location differs");
  }

  return { listing, confidence: Math.max(0, Math.min(0.97, confidence)), reasons };
}

function verdictFor(best: MatchCandidate | null, runnerUp: MatchCandidate | null): MatchVerdict {
  if (!best) return "none";
  if (best.confidence >= 0.98) return "exact";
  // An ambiguous pair is demoted: two near-identical candidates mean we cannot
  // tell which requisition the user actually applied to.
  const ambiguous = runnerUp !== null && best.confidence - runnerUp.confidence < 0.05;
  if (best.confidence >= 0.85) return ambiguous ? "likely" : "strong";
  if (best.confidence >= 0.6) return ambiguous ? "weak" : "likely";
  if (best.confidence >= 0.42) return "weak";
  return "none";
}

/**
 * Matches each parsed row against the catalog. Returns the best candidate plus
 * alternatives so the user can correct a wrong guess without leaving the page.
 */
export function matchRows(
  rows: ImportRow[],
  listings: MatchableListing[],
  opts: { maxAlternatives?: number } = {},
): RowMatch[] {
  const maxAlternatives = opts.maxAlternatives ?? 4;

  // Bucket by normalized company so each row compares against a short list
  // instead of the whole catalog.
  const byCompany = new Map<string, MatchableListing[]>();
  for (const l of listings) {
    const key = normalizeCompany(l.company);
    const bucket = byCompany.get(key);
    if (bucket) bucket.push(l);
    else byCompany.set(key, [l]);
  }
  const companyKeys = [...byCompany.keys()];

  return rows.map((row) => {
    const rowCompany = normalizeCompany(row.company);
    const pool: MatchableListing[] = [];
    const exact = byCompany.get(rowCompany);
    if (exact) pool.push(...exact);
    // Fuzzy company fallback: "Google" vs "Google LLC", typos, abbreviations.
    for (const key of companyKeys) {
      if (key === rowCompany) continue;
      if (titleSimilarity(rowCompany, key) >= COMPANY_MATCH_FLOOR) {
        pool.push(...byCompany.get(key)!);
      }
    }

    // Recorded whether or not a role matches, so the UI can tell the user
    // "we know this company, but none of its roles look like what you typed".
    const companyContext: CompanyContext | null =
      pool.length > 0
        ? {
            company: pool[0].company,
            roleCount: pool.length,
            sampleTitles: [...new Set(pool.map((l) => l.title))].slice(0, 3),
          }
        : null;
    // A URL or requisition id can identify a listing under a different company
    // spelling, so those rows fall back to the whole catalog.
    const searchSpace =
      pool.length > 0 || !(row.url || row.requisitionId) ? pool : listings;

    const scored = searchSpace
      .map((l) => scoreCandidate(row, l))
      .filter((c): c is MatchCandidate => c !== null)
      .sort((a, b) => b.confidence - a.confidence);

    const best = scored[0] ?? null;
    return {
      row,
      best,
      alternatives: scored.slice(1, 1 + maxAlternatives),
      verdict: verdictFor(best, scored[1] ?? null),
      companyContext,
    };
  });
}

/** Verdicts that may be pre-selected for the user; everything else is opt-in. */
export function isPreselected(verdict: MatchVerdict): boolean {
  return verdict === "exact" || verdict === "strong";
}
