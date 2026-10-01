import "./load-env";
import { execFileSync } from "node:child_process";
import { resolveTestDatabase } from "./db-url";

/**
 * Creates/syncs the dedicated test schema once per run. Uses ONLY
 * TEST_DATABASE_URL (see tests/db-url.ts) — never DATABASE_URL — and throws
 * before touching anything if that URL is unsafe. `--url` targets the test
 * schema explicitly, so no stray environment variable can redirect the push.
 */
export default async function setup(): Promise<void> {
  const db = resolveTestDatabase(process.env);
  if (!db.ok) {
    console.warn(`[tests] ${db.reason}`);
    return;
  }
  execFileSync("npx", ["prisma", "db", "push", "--url", db.url], { stdio: "ignore" });
}
