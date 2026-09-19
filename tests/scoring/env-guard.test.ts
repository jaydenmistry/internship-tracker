import { afterEach, describe, expect, it } from "vitest";
import { positiveNumberFromEnv, qualifiedListingTable } from "@/lib/scoring/rescore";

/**
 * These knobs cap spending. A malformed value must fall back to the default,
 * never to NaN — `calls >= NaN` is always false, which would silently remove
 * the cap entirely and bill every candidate.
 */
describe("positiveNumberFromEnv", () => {
  const KEY = "TEST_SPEND_CAP";
  afterEach(() => {
    delete process.env[KEY];
  });

  const cases: Array<[string | undefined, number]> = [
    [undefined, 200],
    ["", 200],
    ["   ", 200],
    ["abc", 200], // the dangerous one: must not become NaN
    ["-5", 200], // negative cap is meaningless
    ["NaN", 200],
    ["Infinity", 200],
    ["0", 0], // explicit zero is a valid "disable"
    ["50", 50],
    ["  7  ", 7],
  ];

  it.each(cases)("%s → %i", (raw, expected) => {
    if (raw === undefined) delete process.env[KEY];
    else process.env[KEY] = raw;
    const result = positiveNumberFromEnv(KEY, 200);
    expect(result).toBe(expected);
    expect(Number.isNaN(result)).toBe(false);
  });
});

/**
 * Raw SQL bypasses the driver adapter's schema handling and resolves through
 * the connection's search_path, which `prisma dev`'s proxy leaks between
 * connections. An unqualified table name silently wrote to the TEST schema
 * while reporting success, so the qualification must be explicit.
 */
describe("qualifiedListingTable", () => {
  const original = process.env.DATABASE_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  });

  it("uses the schema named in DATABASE_URL", () => {
    process.env.DATABASE_URL = "postgres://u:p@localhost:5432/db?schema=public";
    expect(qualifiedListingTable()).toBe('"public"."Listing"');
    process.env.DATABASE_URL = "postgres://u:p@localhost:5432/db?schema=itest";
    expect(qualifiedListingTable()).toBe('"itest"."Listing"');
  });

  it("never returns a bare table name, which would follow search_path", () => {
    for (const url of [
      "postgres://u:p@localhost:5432/db",
      "postgres://u:p@localhost:5432/db?sslmode=disable",
      "not-a-url",
      "",
    ]) {
      process.env.DATABASE_URL = url;
      expect(qualifiedListingTable()).toBe('"public"."Listing"');
    }
    delete process.env.DATABASE_URL;
    expect(qualifiedListingTable()).toBe('"public"."Listing"');
  });

  it("refuses a schema name that cannot be safely quoted", () => {
    // Identifiers cannot be parameterized, so anything odd must throw.
    for (const bad of ['pub"lic', "drop;table", "has space", "1abc", "sch-ema"]) {
      process.env.DATABASE_URL = `postgres://u:p@localhost:5432/db?schema=${encodeURIComponent(bad)}`;
      expect(() => qualifiedListingTable()).toThrow(/unsafe schema/i);
    }
  });
});
