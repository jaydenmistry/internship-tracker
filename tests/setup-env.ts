import "./load-env";
import { resolveTestDatabase } from "./db-url";

// Runs before each test file's module graph is evaluated. DATABASE_URL is
// ALWAYS overwritten here — with the test URL, or with "" when there's no test
// database — so nothing under test (lib/db.ts, or a test file's own
// `dotenv/config` import, which never overrides an already-set variable) can
// reach the development database. Integration tests self-skip on "".
const db = resolveTestDatabase(process.env);
process.env.DATABASE_URL = db.ok ? db.url : "";
