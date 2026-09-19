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
export const TEST_SCHEMA = "itest";

export function testDatabaseUrl(base: string): string {
  const url = new URL(base);
  url.searchParams.set("schema", TEST_SCHEMA);
  return url.toString();
}
