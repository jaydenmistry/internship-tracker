/**
 * Schema-qualified table names for raw SQL.
 *
 * Prisma's driver adapter applies the `?schema=` parameter to the queries IT
 * generates, but raw SQL is sent verbatim and resolves through the
 * connection's `search_path` — which `prisma dev`'s proxy leaks between
 * connections. An unqualified `"Listing"` once silently hit the test schema.
 * Never write an unqualified table name in raw SQL; build it here.
 */
export function qualifiedTable(table: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`refusing unsafe table name: ${table}`);
  let schema = "public";
  try {
    schema = new URL(process.env.DATABASE_URL ?? "").searchParams.get("schema") ?? "public";
  } catch {
    /* falls back to public */
  }
  // The value reaches SQL as an identifier, which cannot be parameterized.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error(`refusing unsafe schema name in DATABASE_URL: ${schema}`);
  }
  return `"${schema}"."${table}"`;
}
