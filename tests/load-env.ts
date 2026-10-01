import dotenv from "dotenv";

/**
 * Loads .env for the test harness — imported FIRST by setup-env.ts and
 * global-setup.ts (a side-effect import, so it runs before db-url.ts reads
 * TEST_SCHEMA).
 *
 * dotenv reads its own options from the environment: DOTENV_OVERRIDE /
 * DOTENV_CONFIG_OVERRIDE would let a LATER load (any `import "dotenv/config"`)
 * write the dev DATABASE_URL back over the test URL setup-env sets, and the
 * *_PATH variables could point it at another file. None of them has a place in
 * a test run, so they're removed before anything loads.
 */
for (const k of ["DOTENV_OVERRIDE", "DOTENV_CONFIG_OVERRIDE", "DOTENV_PATH", "DOTENV_CONFIG_PATH"]) {
  delete process.env[k];
}
dotenv.config({ quiet: true });
