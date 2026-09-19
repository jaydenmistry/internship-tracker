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

export function neutralizeFormula(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

/** Inverse of neutralizeFormula, applied on import. */
export function restoreFormulaPrefix(value: string): string {
  return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
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
