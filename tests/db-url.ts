/**
 * Where integration tests may run — and, just as important, where they may
 * NOT. Those tests wipe tables in beforeEach, so pointing them at development
 * data is destructive.
 *
 * The rules:
 *  1. Tests use TEST_DATABASE_URL, and ONLY that. DATABASE_URL (the app's own
 *     database) is never used as a fallback — an unset TEST_DATABASE_URL means
 *     the integration tests skip, not that they borrow the dev database.
 *  2. TEST_DATABASE_URL is refused if it names the same database as
 *     DATABASE_URL (same host, port and database), unless that database's
 *     name contains "test". A copy-paste of the dev URL into the test variable
 *     is the likeliest way to wipe real data.
 *  3. Whatever database is used, the tests run in a dedicated SCHEMA inside
 *     it (TEST_SCHEMA, default `itest`), never `public`.
 *
 * Schema (not database) separation is deliberate: `prisma dev`'s local proxy
 * ignores the database name in a connection string and routes every name to
 * one physical database, so a "<db>_test" URL silently shares storage with
 * development. A `?schema=` override is honored everywhere and works the same
 * on a real Postgres.
 */

/**
 * Overridable so two test runs can execute at the same time (parallel agents,
 * or a watch process beside a one-off run) without wiping each other's tables
 * in `beforeEach`. The default is what every normal run uses.
 */
export const TEST_SCHEMA = schemaName(process.env.TEST_SCHEMA);

function schemaName(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) return "itest";
  // The name is interpolated into SQL identifiers downstream, and a test
  // harness pointing at an attacker-chosen schema is not a thing worth
  // supporting — reject anything that isn't a plain identifier.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`TEST_SCHEMA is not a valid identifier: ${value}`);
  }
  if (value === "public") throw new Error("TEST_SCHEMA must not be `public`");
  return value;
}

/**
 * The per-file gate integration tests use: true only when DATABASE_URL is the
 * TEST URL — i.e. it carries `schema=<TEST_SCHEMA>`, which only setup-env puts
 * there. If anything restored a dev URL after setup-env ran (a dotenv override,
 * a stray export), this is false and the tests SKIP instead of wiping it.
 */
export function hasTestDatabase(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const raw = env.DATABASE_URL?.trim();
  if (!raw) return false;
  try {
    return new URL(raw).searchParams.get("schema") === TEST_SCHEMA;
  } catch {
    return false;
  }
}

export function testDatabaseUrl(base: string): string {
  const url = new URL(base);
  url.searchParams.set("schema", TEST_SCHEMA);
  return url.toString();
}

export type TestDatabase = { ok: true; url: string } | { ok: false; skip: true; reason: string };

export class UnsafeTestDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeTestDatabaseError";
  }
}

function dbNameOf(u: URL): string {
  try {
    return decodeURIComponent(u.pathname.replace(/^\//, ""));
  } catch {
    throw new UnsafeTestDatabaseError(`database URL has a malformed %-escape in its path`);
  }
}

/** host:port/database — the identity of a Postgres database, credentials and params aside. */
function databaseIdentity(u: URL): string {
  const port = u.port || "5432";
  return `${u.hostname.toLowerCase()}:${port}/${dbNameOf(u)}`;
}

/** "test" as a word in a database name: tracker_test, test-db, tests — not "latest" or "contest". */
const NAMED_TEST = /(^|[_\-.])tests?($|[_\-.])/i;

/**
 * Resolves the test database from the environment. Returns a skip (with the
 * reason) when TEST_DATABASE_URL is unset; THROWS when it is set but unsafe
 * or malformed, so a misconfiguration fails loudly instead of quietly running
 * against the wrong place.
 *
 * The SCHEMA is the real isolation boundary; the database-identity check is
 * best-effort. It only sees the DATABASE_URL in THIS process's environment
 * (usually .env) — not the one a separately started dev server was given —
 * and under `prisma dev` every database name on a port routes to the same
 * physical database, while host aliases (localhost / 127.0.0.1 / a container
 * name) also defeat it. What always holds: tests write only to TEST_SCHEMA,
 * which is never `public` and never the schema DATABASE_URL names.
 */
export function resolveTestDatabase(env: Readonly<Record<string, string | undefined>>): TestDatabase {
  const raw = env.TEST_DATABASE_URL?.trim();
  if (!raw) {
    return {
      ok: false,
      skip: true,
      reason:
        "TEST_DATABASE_URL is not set — integration tests are skipped. " +
        "Tests never fall back to DATABASE_URL.",
    };
  }

  let test: URL;
  try {
    test = new URL(raw);
  } catch {
    throw new UnsafeTestDatabaseError("TEST_DATABASE_URL is not a valid URL");
  }
  if (!/^postgres(ql)?:$/.test(test.protocol)) {
    throw new UnsafeTestDatabaseError("TEST_DATABASE_URL must be a postgres:// or postgresql:// URL");
  }
  const dbName = dbNameOf(test);
  if (!dbName) throw new UnsafeTestDatabaseError("TEST_DATABASE_URL must name a database");

  const devRaw = env.DATABASE_URL?.trim();
  if (devRaw) {
    let dev: URL | null = null;
    try {
      dev = new URL(devRaw);
    } catch {
      dev = null;
    }
    // Never the schema the app itself uses, whatever database this is.
    const devSchema = dev?.searchParams.get("schema") ?? "public";
    if (devSchema === TEST_SCHEMA) {
      throw new UnsafeTestDatabaseError(
        `TEST_SCHEMA (${TEST_SCHEMA}) is the schema DATABASE_URL uses. Refusing: integration tests wipe tables.`,
      );
    }
    if (dev && databaseIdentity(dev) === databaseIdentity(test) && !NAMED_TEST.test(dbName)) {
      throw new UnsafeTestDatabaseError(
        `TEST_DATABASE_URL points at the same database as DATABASE_URL (${databaseIdentity(test)}), ` +
          `and its name doesn't contain "test". Refusing: integration tests wipe tables. ` +
          `Use a separate database, or one whose name contains "test".`,
      );
    }
  }

  return { ok: true, url: testDatabaseUrl(raw) };
}
