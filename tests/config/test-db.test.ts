import { describe, expect, it } from "vitest";
import { resolveTestDatabase, UnsafeTestDatabaseError } from "../db-url";

const DEV = "postgresql://u:p@tracker-db:5432/internship_tracker?schema=public";

describe("resolveTestDatabase", () => {
  it("skips — never falls back to DATABASE_URL — when TEST_DATABASE_URL is unset", () => {
    const r = resolveTestDatabase({ DATABASE_URL: DEV });
    expect(r).toMatchObject({ ok: false, skip: true });
    if (!r.ok) expect(r.reason).toMatch(/never fall back to DATABASE_URL/);
    expect(resolveTestDatabase({ DATABASE_URL: DEV, TEST_DATABASE_URL: "  " }).ok).toBe(false);
  });

  it("uses TEST_DATABASE_URL, forced into the test schema", () => {
    const r = resolveTestDatabase({
      DATABASE_URL: DEV,
      TEST_DATABASE_URL: "postgres://postgres:postgres@localhost:51214/template1?sslmode=disable&schema=public",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const u = new URL(r.url);
      expect(u.searchParams.get("schema")).toBe("itest");
      expect(u.searchParams.get("sslmode")).toBe("disable");
      expect(u.pathname).toBe("/template1");
    }
  });

  it("refuses the dev database itself, even with different credentials or params", () => {
    expect(() =>
      resolveTestDatabase({ DATABASE_URL: DEV, TEST_DATABASE_URL: "postgresql://other:x@TRACKER-DB/internship_tracker" }),
    ).toThrow(UnsafeTestDatabaseError);
  });

  it("allows the same server/database only when its name contains 'test'", () => {
    const dev = "postgresql://u:p@localhost:5432/tracker_test";
    expect(resolveTestDatabase({ DATABASE_URL: dev, TEST_DATABASE_URL: dev }).ok).toBe(true);
  });

  it("allows a different database on the same server", () => {
    expect(
      resolveTestDatabase({ DATABASE_URL: DEV, TEST_DATABASE_URL: "postgresql://u:p@tracker-db:5432/scratch" }).ok,
    ).toBe(true);
  });

  it("refuses a malformed, non-postgres, or database-less URL", () => {
    for (const bad of ["not a url", "mysql://u:p@h/db", "postgresql://u:p@h:5432/"]) {
      expect(() => resolveTestDatabase({ TEST_DATABASE_URL: bad }), bad).toThrow(UnsafeTestDatabaseError);
    }
  });
});

describe("hardening", () => {
  it("counts 'test' only as a word in the name", () => {
    const same = (db: string) => ({ DATABASE_URL: `postgresql://u:p@h:5432/${db}`, TEST_DATABASE_URL: `postgresql://u:p@h:5432/${db}` });
    for (const ok of ["tracker_test", "test", "test-db", "tracker.tests"]) expect(resolveTestDatabase(same(ok)).ok, ok).toBe(true);
    for (const bad of ["latest", "contest", "attestation"]) expect(() => resolveTestDatabase(same(bad)), bad).toThrow(UnsafeTestDatabaseError);
  });

  it("refuses when DATABASE_URL itself uses the test schema", () => {
    expect(() =>
      resolveTestDatabase({
        DATABASE_URL: "postgresql://u:p@h:5432/app?schema=itest",
        TEST_DATABASE_URL: "postgresql://u:p@other:5432/scratch",
      }),
    ).toThrow(/is the schema DATABASE_URL uses/);
  });

  it("turns a malformed %-escape into a clear refusal, not a URIError", () => {
    expect(() => resolveTestDatabase({ TEST_DATABASE_URL: "postgresql://u:p@h:5432/bad%zz" })).toThrow(UnsafeTestDatabaseError);
  });
});

describe("hasTestDatabase — the per-file gate", () => {
  it("is true only for a URL in the test schema", async () => {
    const { hasTestDatabase } = await import("../db-url");
    expect(hasTestDatabase({ DATABASE_URL: "postgresql://u:p@h:5432/x?schema=itest" })).toBe(true);
    // A dev URL restored after setup-env (e.g. by a dotenv override) → skip, don't wipe.
    expect(hasTestDatabase({ DATABASE_URL: "postgresql://u:p@tracker-db:5432/internship_tracker?schema=public" })).toBe(false);
    expect(hasTestDatabase({ DATABASE_URL: "postgresql://u:p@h:5432/x" })).toBe(false);
    expect(hasTestDatabase({ DATABASE_URL: "" })).toBe(false);
    expect(hasTestDatabase({})).toBe(false);
  });
});
