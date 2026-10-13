import { afterEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { positiveNumberFromEnv, qualifiedListingTable } from "@/lib/scoring/rescore";
import { qualifiedTable } from "@/lib/sql";

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

describe("qualifiedTable", () => {
  const original = process.env.DATABASE_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  });

  it("qualifies any table with the URL's schema", () => {
    process.env.DATABASE_URL = "postgres://u:p@localhost:5432/db?schema=itest";
    expect(qualifiedTable("Application")).toBe('"itest"."Application"');
  });

  it("refuses a table name that isn't a plain identifier", () => {
    expect(() => qualifiedTable('Application"; DROP TABLE x; --')).toThrow(/unsafe table name/);
  });
});

/**
 * The rule above, enforced by search: no raw SQL anywhere in lib/ may name a
 * table without a schema. A template like FROM "Application" passes every test
 * under one schema while locking or writing the wrong table under another.
 */
describe("raw SQL never uses a bare table name", () => {
  it("finds none in lib/", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) {
          const src = readFileSync(full, "utf8");
          for (const m of src.matchAll(/\b(?:FROM|UPDATE|INTO|JOIN)\s+"[A-Z][A-Za-z0-9_]*"/g)) {
            offenders.push(`${path.relative(process.cwd(), full)}: ${m[0]}`);
          }
        }
      }
    };
    walk(path.join(process.cwd(), "lib"));
    expect(offenders).toEqual([]);
  });
});
