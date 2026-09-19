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

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
