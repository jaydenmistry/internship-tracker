import type { LetterProfile, Signature } from "./profile-schema";

/**
 * The exported letter as a layout-neutral model, shared by the .docx and PDF
 * writers so both put the same words in the same places:
 *
 *   JAYDEN MISTRY                         ← letterhead (centred, page header)
 *   City | phone | email
 *   site | linkedin | github
 *
 *   October 13, 2026                      ← date
 *   Talent Acquisition Team               ← recipient block
 *   MEMX
 *
 *   Dear MEMX Talent Acquisition Team,    ← greeting
 *
 *       Body paragraph, first line indented …
 *
 *   Sincerely,                            ← closing
 *   [signature image]
 *   Jayden Mistry
 *
 * Pure: no DOM, no database.
 */

export interface LetterDoc {
  header: { name: string; lines: string[] } | null;
  date: string;
  recipient: string[];
  greeting: string;
  /** Blank-line-separated blocks; a single newline inside one is a line break. */
  paragraphs: string[];
  closing: string;
  signature: Signature | null;
  signName: string;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** A civil date ("2026-10-13", as <input type="date"> gives it). */
export function isCivilDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** Today in the browser's own timezone, as a civil date. */
export function todayCivil(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** "2026-10-13" → "October 13, 2026". */
export function formatLetterDate(civil: string): string {
  const [y, m, d] = civil.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/** "2026-10-13", "MEMX", "pdf" → "20261013_Cover Letter_MEMX.pdf". */
export function exportFilename(civil: string, company: string, ext: "pdf" | "docx"): string {
  // Scraped names: strip what a file name can't hold, plus invisible format
  // characters (a U+202E right-to-left override in a company name would make the
  // downloaded file name read as something else). Cut by code point, not UTF-16 unit.
  const safe =
    Array.from(
      company
        .replace(/[\\/:*?"<>|\p{Cc}\p{Cf}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^\.+/, ""),
    )
      .slice(0, 80)
      .join("")
      .trim() || "Company";
  return `${civil.replaceAll("-", "")}_Cover Letter_${safe}.${ext}`;
}

export function defaultRecipient(profile: Pick<LetterProfile, "recipient">, company: string): string {
  return [profile.recipient.trim(), company.trim()].filter(Boolean).join("\n");
}

export function defaultGreeting(profile: Pick<LetterProfile, "greeting">, company: string): string {
  return profile.greeting.replaceAll("{company}", company.trim()).replace(/\s+/g, " ").trim();
}

export function splitParagraphs(body: string): string[] {
  return body
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n/)
    .map((p) =>
      p
        .split("\n")
        .map((line) => line.trim())
        .join("\n")
        .trim(),
    )
    .filter((p) => p !== "");
}

export function composeLetter(input: {
  profile: LetterProfile;
  company: string;
  /** The letter's own recipient block and greeting; null means the profile's defaults. */
  recipient: string | null;
  greeting: string | null;
  body: string;
  date: string;
}): LetterDoc {
  const { profile } = input;
  const name = profile.name.trim();
  const lines = profile.contactLines.map((l) => l.trim()).filter(Boolean);
  const recipient = (input.recipient?.trim() ? input.recipient : defaultRecipient(profile, input.company))
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return {
    header: name || lines.length ? { name: name.toUpperCase(), lines } : null,
    date: formatLetterDate(input.date),
    recipient,
    greeting: input.greeting?.trim() || defaultGreeting(profile, input.company),
    paragraphs: splitParagraphs(input.body),
    closing: profile.closing,
    signature: profile.signature,
    signName: name,
  };
}
