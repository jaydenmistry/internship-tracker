import "dotenv/config";
import { testDatabaseUrl } from "./db-url";

// Runs before each test file's module graph is evaluated. dotenv never
// overrides an already-set variable, so a test file's own `dotenv/config`
// import cannot put the dev database back.
if (process.env.DATABASE_URL) {
  process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL);
}
