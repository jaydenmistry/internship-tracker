import { calendarDate } from "@/lib/alerts/build";

/**
 * Civil-date arithmetic for follow-up due dates. Pure: no clock, no I/O.
 *
 * A due date is a calendar DAY in the configured zone (ALERT_TIMEZONE), stored
 * as that day's local midnight. "Due today" then means `nextFollowUpAt <= end
 * of today`, which is correct on any server clock. Business days skip Saturday
 * and Sunday only — holidays are not handled.
 */

export interface CivilDate {
  year: number;
  month: number; // 1–12
  day: number;
}

export function civilDate(d: Date, timeZone?: string): CivilDate {
  const [year, month, day] = calendarDate(d, timeZone).split("-").map(Number);
  return { year, month, day };
}

/** 0 = Sunday … 6 = Saturday, of the civil date itself (zone-free). */
function weekday(c: CivilDate): number {
  return new Date(Date.UTC(c.year, c.month - 1, c.day)).getUTCDay();
}

function addDays(c: CivilDate, n: number): CivilDate {
  const d = new Date(Date.UTC(c.year, c.month - 1, c.day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * `n` business days after `c`. A weekend start counts from the weekend:
 * Saturday + 1 = Monday, Friday + 5 = the next Friday.
 */
export function addBusinessDays(c: CivilDate, n: number): CivilDate {
  let out = c;
  let left = n;
  while (left > 0) {
    out = addDays(out, 1);
    const wd = weekday(out);
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return out;
}

/** Offset of `timeZone` from UTC at instant `ms`, in ms (east positive). */
function zoneOffset(ms: number, timeZone?: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The instant that is local midnight at the start of `c` in `timeZone`. */
export function startOfCivilDay(c: CivilDate, timeZone?: string): Date {
  const wall = Date.UTC(c.year, c.month - 1, c.day);
  // Two passes: the offset at the guess can differ from the offset at the
  // answer when a DST change falls between them.
  let guess = wall - zoneOffset(wall, timeZone);
  guess = wall - zoneOffset(guess, timeZone);
  // Zones whose DST change is AT midnight (America/Santiago) have no 00:00 on
  // that day; the math above lands an hour early, on the previous day. The
  // day then starts at 01:00 — step forward until we're on the right date.
  for (let i = 0; i < 3; i += 1) {
    const got = civilDate(new Date(guess), timeZone);
    if (got.year === c.year && got.month === c.month && got.day === c.day) break;
    guess += 3_600_000;
  }
  return new Date(guess);
}

/** Last millisecond of `d`'s calendar day in `timeZone`. */
export function endOfDay(d: Date, timeZone?: string): Date {
  const next = addDays(civilDate(d, timeZone), 1);
  return new Date(startOfCivilDay(next, timeZone).getTime() - 1);
}

/** Local midnight of the day `n` business days after `d`'s calendar day. */
export function businessDaysAfter(d: Date, n: number, timeZone?: string): Date {
  return startOfCivilDay(addBusinessDays(civilDate(d, timeZone), n), timeZone);
}

/** Parses "YYYY-MM-DD" strictly; null for anything else or an impossible date. */
export function parseCivilDate(s: string): CivilDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const c = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  const d = new Date(Date.UTC(c.year, c.month - 1, c.day));
  if (d.getUTCFullYear() !== c.year || d.getUTCMonth() + 1 !== c.month || d.getUTCDate() !== c.day) return null;
  return c;
}
