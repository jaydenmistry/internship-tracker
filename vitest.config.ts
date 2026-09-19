import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
    // Integration tests run against a dedicated Postgres SCHEMA (not a separate
    // database — see tests/db-url.ts for why), created by global-setup.
    globalSetup: ["tests/global-setup.ts"],
    setupFiles: ["tests/setup-env.ts"],
    // Those tests wipe tables in beforeEach and share the one test database,
    // so test files must not run concurrently. The suite is seconds either way.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname),
    },
  },
});
