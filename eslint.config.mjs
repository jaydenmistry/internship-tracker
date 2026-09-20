import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Compiled worker bundle (scripts/build-worker.mjs). Generated code, built
    // fresh by the image build — linting it only reports on its dependencies.
    "dist/**",
    // Gitignored one-off query/smoke scripts (see .gitignore). They are never
    // committed, so holding them to the app's lint rules only ever produces
    // noise that hides real findings.
    ".scratch/**",
  ]),
]);

export default eslintConfig;
