import "dotenv/config";
import { execFileSync } from "node:child_process";
import { testDatabaseUrl } from "./db-url";

/**
 * Creates/syncs the dedicated test schema once per run, so integration tests
 * never touch development data. `--url` targets it explicitly, so no stray
 * environment variable can redirect this at the development schema.
 */
export default async function setup(): Promise<void> {
  const base = process.env.DATABASE_URL;
  if (!base) return; // integration tests self-skip without a database

  execFileSync("npx", ["prisma", "db", "push", "--url", testDatabaseUrl(base)], {
    stdio: "ignore",
  });
}
