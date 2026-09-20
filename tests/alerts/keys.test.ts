import { describe, expect, it } from "vitest";
import { baseKeys, calendarDate, calendarDaysBetween, dedupeKey } from "@/lib/alerts/build";
import { NOW, TZ } from "./fixtures";

/**
 * Dedupe keys decide whether an alert is ever sent twice, or never sent again.
 * They are the part of this feature with no visible failure mode, so they get
 * their own tests.
 */

describe("dedupeKey", () => {
  it("separates the two channels, so one alert can go to both", () => {
    const discord = dedupeKey("HIGH_SCORE", "listing-1", "DISCORD");
    const email = dedupeKey("HIGH_SCORE", "listing-1", "EMAIL");

    expect(discord).not.toBe(email);
    expect(discord).toBe("HIGH_SCORE:DISCORD:listing-1");
  });

  it("separates kinds that share a base key", () => {
    expect(dedupeKey("HIGH_SCORE", "l1", "EMAIL")).not.toBe(
      dedupeKey("CLOSING_SOON", "l1", "EMAIL"),
    );
  });
});

describe("baseKeys.dailyDigest", () => {
  it("is one key per calendar day", () => {
    const morning = new Date("2026-09-20T06:00:00Z");
    const evening = new Date("2026-09-20T23:59:00Z");

    expect(baseKeys.dailyDigest(morning, TZ)).toBe("2026-09-20");
    expect(baseKeys.dailyDigest(evening, TZ)).toBe(baseKeys.dailyDigest(morning, TZ));
    expect(baseKeys.dailyDigest(new Date("2026-09-21T00:01:00Z"), TZ)).toBe("2026-09-21");
  });

  it("follows the configured zone, not UTC", () => {
    // 01:30 UTC on the 21st is still the 20th in New York.
    const late = new Date("2026-09-21T01:30:00Z");
    expect(baseKeys.dailyDigest(late, "UTC")).toBe("2026-09-21");
    expect(baseKeys.dailyDigest(late, "America/New_York")).toBe("2026-09-20");
  });
});

describe("baseKeys.highScore", () => {
  it("is the listing id, so a listing alerts at most once", () => {
    expect(baseKeys.highScore("abc")).toBe("abc");
  });
});

describe("baseKeys.closingSoon", () => {
  it("is stable for an unchanged deadline", () => {
    const deadline = new Date("2026-10-01T00:00:00Z");
    expect(baseKeys.closingSoon("abc", deadline)).toBe(baseKeys.closingSoon("abc", new Date(deadline)));
  });

  it("changes when the deadline moves, so a moved deadline can re-alert", () => {
    const first = baseKeys.closingSoon("abc", new Date("2026-10-01T00:00:00Z"));
    const moved = baseKeys.closingSoon("abc", new Date("2026-10-08T00:00:00Z"));
    expect(moved).not.toBe(first);
  });
});

describe("calendar arithmetic", () => {
  it("formats as YYYY-MM-DD in the given zone", () => {
    expect(calendarDate(NOW, TZ)).toBe("2026-09-20");
  });

  it("counts calendar days, so midnight tonight is still today", () => {
    // 12:00 on the 20th to 00:00 on the 20th is negative in milliseconds but
    // the same calendar day — the deadline has not passed.
    expect(calendarDaysBetween(NOW, new Date("2026-09-20T00:00:00Z"), TZ)).toBe(0);
    expect(calendarDaysBetween(NOW, new Date("2026-09-21T00:00:00Z"), TZ)).toBe(1);
    expect(calendarDaysBetween(NOW, new Date("2026-09-19T23:00:00Z"), TZ)).toBe(-1);
  });

  it("is not thrown off by a DST transition", () => {
    // US DST ends 2026-11-01; the 7 days from Oct 29 to Nov 5 are 7 calendar
    // days even though they are 7 days and an hour.
    const from = new Date("2026-10-29T12:00:00-04:00");
    const to = new Date("2026-11-05T12:00:00-05:00");
    expect(calendarDaysBetween(from, to, "America/New_York")).toBe(7);
  });
});
