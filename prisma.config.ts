import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
    // Local prisma-dev shadow instance; only used by `migrate diff/dev` locally.
    shadowDatabaseUrl: process.env["SHADOW_DATABASE_URL"],
  },
});
