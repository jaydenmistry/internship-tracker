import type { TrackerApplication } from "@/lib/applications/tracker";

/**
 * Applications CSV export. The columns are exactly the headers the bulk import
 * parser understands (lib/applications/import.ts), so an exported file
 * round-trips through /import: per-row status, applied date and notes restore.
 */
export const CSV_COLUMNS = [
  "Company",
  "Role",
  "Location",
  "Status",
  "Applied",
  "Req ID",
  "URL",
  "Notes",
] as const;

/**
 * Formula-injection guard. Company and role text is scraped from third-party
 * sites, and spreadsheet apps execute a cell beginning with = + - @ (or a
 * leading tab/CR) as a formula. Prefixing an apostrophe makes it inert text.
 * The importer strips exactly this prefix back off, so the round trip is exact.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Leading whitespace is checked too: a spreadsheet treats " =x" as text, but a
 * CSV reader that trims hands "=x" straight back to one as a live formula.
 */
function looksLikeFormula(value: string): boolean {
  return FORMULA_START.test(value) || FORMULA_START.test(value.trimStart());
}

/**
 * Prefixes an apostrophe so a spreadsheet treats the cell as text. A value that
 * ALREADY starts with an apostrophe is escaped the same way, so the guard is
 * unambiguous on the way back — otherwise a genuine "'=x" and a guarded "=x"
 * would be written identically and one of them would come back wrong.
 */
export function neutralizeFormula(value: string): string {
  return looksLikeFormula(value) || value.startsWith("'") ? `'${value}` : value;
}

/**
 * Inverse of neutralizeFormula: strips exactly one leading apostrophe. This
 * matches spreadsheet convention, where a leading apostrophe is an escape
 * marker rather than content.
 */
export function restoreFormulaPrefix(value: string): string {
  return value.startsWith("'") ? value.slice(1) : value;
}

/** RFC 4180 quoting: wrap when needed, double embedded quotes. */
function quote(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function cell(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  return quote(neutralizeFormula(value));
}

export function applicationsToCsv(apps: TrackerApplication[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const a of apps) {
    lines.push(
      [
        cell(a.company),
        cell(a.role),
        cell(a.location),
        cell(a.status),
        cell(a.appliedAt ? a.appliedAt.slice(0, 10) : null),
        cell(a.requisitionId),
        cell(a.url),
        cell(a.notes),
      ].join(","),
    );
  }
  // CRLF per RFC 4180; spreadsheet apps and the importer both accept it.
  return lines.join("\r\n") + "\r\n";
}
