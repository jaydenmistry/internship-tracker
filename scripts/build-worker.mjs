#!/usr/bin/env node
/**
 * Compiles worker/index.ts (and its first-party import graph) into a single
 * ESM file at dist/worker.mjs.
 *
 * Why precompile instead of shipping `tsx`: `tsx` is a devDependency, so it is
 * absent from an `npm ci --omit=dev` runtime install, and promoting it to
 * `dependencies` would mean regenerating package-lock.json. Precompiling also
 * removes a TypeScript compile from every container start. esbuild is already
 * present in the install (tsx depends on it), so this needs no new dependency.
 *
 * Only first-party code is bundled. Real runtime packages stay external and are
 * resolved from the image's node_modules, so nothing in @prisma/client,
 * cheerio, or nodemailer gets rewritten by a bundler that has never been tested
 * against them. `dotenv` is the one exception: it is a devDependency that
 * worker/index.ts imports, so it is inlined to keep the runtime install
 * production-only.
 *
 * The build fails if the bundle ends up needing a package that is not in
 * `dependencies` — better a red build than a container that crash-loops on a
 * missing module.
 */
import { builtinModules, createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(projectRoot, "package.json"));

// esbuild arrives as a transitive dependency of tsx. Resolve it through tsx as
// a fallback so a non-hoisting installer does not break the build.
let esbuild;
try {
  esbuild = await import("esbuild");
} catch {
  const viaTsx = createRequire(require.resolve("tsx/package.json"));
  esbuild = await import(viaTsx.resolve("esbuild"));
}

const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
const prodDeps = new Set(Object.keys(pkg.dependencies ?? {}));

const NODE_BUILTINS = new Set(builtinModules);

const ENTRY = "worker/index.ts";
const OUTFILE = "dist/worker.mjs";

/** Maps the `@/*` tsconfig path alias onto the project root. */
const aliasPlugin = {
  name: "tsconfig-path-alias",
  setup(build) {
    build.onResolve({ filter: /^@\// }, async (args) => {
      if (args.pluginData === "alias-resolved") return;
      const resolved = await build.resolve("./" + args.path.slice(2), {
        kind: args.kind,
        resolveDir: projectRoot,
        pluginData: "alias-resolved",
      });
      if (resolved.errors.length > 0) return { errors: resolved.errors };
      return { path: resolved.path, namespace: resolved.namespace, external: resolved.external };
    });
  },
};

/**
 * Pulls dotenv into the bundle even though `packages: "external"` is set.
 * Returning an absolute path is what overrides the blanket externalisation —
 * routing back through `build.resolve` would just re-externalise it.
 */
const inlineDotenvPlugin = {
  name: "inline-dotenv",
  setup(build) {
    build.onResolve({ filter: /^dotenv(\/.*)?$/ }, (args) => ({
      path: require.resolve(args.path),
      external: false,
    }));
  },
};

const result = await esbuild.build({
  absWorkingDir: projectRoot,
  entryPoints: [ENTRY],
  outfile: OUTFILE,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap: true,
  metafile: true,
  logLevel: "info",
  plugins: [aliasPlugin, inlineDotenvPlugin],
  banner: {
    // Some CJS dependencies reach for `require` after esbuild's ESM interop
    // hands them an ESM scope; this gives them a real one.
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
});

const externals = new Set();
for (const output of Object.values(result.metafile.outputs)) {
  for (const imported of output.imports ?? []) {
    if (!imported.external) continue;
    if (imported.path.startsWith("node:")) continue;
    // dotenv's CJS reaches for unprefixed builtins ("fs", "path"); those always
    // resolve, dependency list or not.
    if (NODE_BUILTINS.has(imported.path)) continue;
    // "@scope/name/sub/path" -> "@scope/name"; "name/sub" -> "name"
    const parts = imported.path.split("/");
    externals.add(imported.path.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]);
  }
}

const notProduction = [...externals].filter((name) => !prodDeps.has(name)).sort();
if (notProduction.length > 0) {
  console.error(
    `[build-worker] these packages are imported at runtime but are not in package.json "dependencies", ` +
      `so an --omit=dev install will not have them: ${notProduction.join(", ")}`,
  );
  process.exit(1);
}

console.log(`[build-worker] ${ENTRY} -> ${OUTFILE}`);
console.log(`[build-worker] external runtime packages: ${[...externals].sort().join(", ")}`);
