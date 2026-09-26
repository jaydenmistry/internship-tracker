import { describe, expect, it } from "vitest";
import {
  addBusinessDays,
  businessDaysAfter,
  civilDate,
  endOfDay,
  parseCivilDate,
  startOfCivilDay,
} from "@/lib/networking/dates";

const NY = "America/New_York";

describe("addBusinessDays", () => {
  it.each([
    // 2026-09-25 is a Friday.
    [{ year: 2026, month: 9, day: 25 }, 5, { year: 2026, month: 10, day: 2 }], // Fri + 5 = next Fri
    [{ year: 2026, month: 9, day: 25 }, 1, { year: 2026, month: 9, day: 28 }], // Fri + 1 = Mon
    [{ year: 2026, month: 9, day: 26 }, 1, { year: 2026, month: 9, day: 28 }], // Sat + 1 = Mon
    [{ year: 2026, month: 9, day: 27 }, 1, { year: 2026, month: 9, day: 28 }], // Sun + 1 = Mon
    [{ year: 2026, month: 9, day: 21 }, 7, { year: 2026, month: 9, day: 30 }], // Mon + 7 = next Wed
    [{ year: 2026, month: 12, day: 31 }, 1, { year: 2027, month: 1, day: 1 }], // across a year
    [{ year: 2026, month: 9, day: 25 }, 0, { year: 2026, month: 9, day: 25 }],
  ])("%o + %i business days = %o", (start, n, expected) => {
    expect(addBusinessDays(start, n)).toEqual(expected);
  });
});

describe("zone handling", () => {
  it("uses the calendar day in the configured zone, not UTC", () => {
    // 01:30 UTC on Saturday is still Friday evening in New York.
    const fridayEveningNY = new Date("2026-09-26T01:30:00Z");
    expect(civilDate(fridayEveningNY, NY)).toEqual({ year: 2026, month: 9, day: 25 });
    expect(civilDate(fridayEveningNY, "UTC")).toEqual({ year: 2026, month: 9, day: 26 });
    // Friday + 5 business days = next Friday, at New York midnight (EDT, -4).
    expect(businessDaysAfter(fridayEveningNY, 5, NY).toISOString()).toBe("2026-10-02T04:00:00.000Z");
  });

  it("lands on local midnight across a DST change", () => {
    // US DST ends 2026-11-01: EDT (-4) before, EST (-5) after.
    expect(startOfCivilDay({ year: 2026, month: 10, day: 31 }, NY).toISOString()).toBe("2026-10-31T04:00:00.000Z");
    expect(startOfCivilDay({ year: 2026, month: 11, day: 2 }, NY).toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });

  it("starts a day with no local midnight (DST at 00:00) at 01:00 on that day, not the day before", () => {
    // Chile springs forward at 00:00 on 2026-09-06: the day begins at 01:00 (-03).
    const start = startOfCivilDay({ year: 2026, month: 9, day: 6 }, "America/Santiago");
    expect(civilDate(start, "America/Santiago")).toEqual({ year: 2026, month: 9, day: 6 });
    expect(start.toISOString()).toBe("2026-09-06T04:00:00.000Z");
  });

  it("endOfDay is the last millisecond of the local day", () => {
    expect(endOfDay(new Date("2026-09-25T15:00:00Z"), NY).toISOString()).toBe("2026-09-26T03:59:59.999Z");
  });
});

describe("parseCivilDate", () => {
  it("accepts real dates only", () => {
    expect(parseCivilDate("2026-02-28")).toEqual({ year: 2026, month: 2, day: 28 });
    expect(parseCivilDate("2026-02-30")).toBeNull();
    expect(parseCivilDate("2026-9-1")).toBeNull();
    expect(parseCivilDate("tomorrow")).toBeNull();
  });
});
