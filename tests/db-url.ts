/**
 * Integration tests wipe tables in beforeEach, so they must never point at the
 * development data. They run against a dedicated Postgres SCHEMA inside the
 * same database.
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
  return value;
}

export function testDatabaseUrl(base: string): string {
  const url = new URL(base);
  url.searchParams.set("schema", TEST_SCHEMA);
  return url.toString();
}
