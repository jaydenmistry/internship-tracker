import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

// Prisma 7 connects through a driver adapter; DATABASE_URL comes from env
// (dotenv for CLI/worker contexts, the container environment in production).
function createClient() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  // A `?schema=` parameter must be passed to the adapter explicitly: node-postgres
  // ignores unknown connection-string parameters, so without this the client
  // silently stays on `public`. Integration tests rely on this to keep their
  // wipes off development data.
  let schema: string | undefined;
  try {
    schema = new URL(connectionString).searchParams.get("schema") ?? undefined;
  } catch {
    schema = undefined;
  }
  const adapter = new PrismaPg({ connectionString }, schema ? { schema } : undefined);
  return new PrismaClient({ adapter });
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/** The real client, created on FIRST USE rather than at import. */
function client(): PrismaClient {
  if (!globalForPrisma.prisma) globalForPrisma.prisma = createClient();
  return globalForPrisma.prisma;
}

/**
 * Lazy: importing a module that happens to reach this file (a Server Action,
 * a read model) no longer needs DATABASE_URL — only a query does. Tests rely
 * on that: they run with DATABASE_URL blank unless TEST_DATABASE_URL names a
 * test database (tests/db-url.ts), so no test can ever reach dev data just by
 * importing the app. Behaviour is otherwise identical: one client per process
 * (cached on globalThis so dev HMR doesn't open a new pool per reload), and
 * the same "DATABASE_URL is not set" error, raised by the first query.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const real = client();
    const value = Reflect.get(real, prop, real);
    return typeof value === "function" ? value.bind(real) : value;
  },
});
