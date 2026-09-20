#!/usr/bin/env node
/**
 * Stages the Prisma CLI (and anything it loads) into a standalone node_modules
 * tree, so the runtime image can run `prisma migrate deploy` without carrying
 * the whole ~900MB development install.
 *
 * Why this exists: `prisma` is a devDependency, so `npm ci --omit=dev` does not
 * install it, and Next's standalone output only traces what the *app* imports —
 * never the CLI. Hand-listing the packages to COPY in the Dockerfile would rot
 * the moment Prisma changes a dependency, so the closure is computed from the
 * installed package.json files instead.
 *
 * Usage: node scripts/stage-prisma-cli.mjs <dest-dir> [extra-root ...]
 * Produces <dest-dir>/node_modules/... ; invoke the CLI as
 *   node <dest-dir>/node_modules/prisma/build/index.js migrate deploy
 *
 * `dotenv` is staged alongside it because prisma.config.ts imports it.
 */
import fs from "node:fs";
import path from "node:path";

const [dest, ...extraRoots] = process.argv.slice(2);
if (!dest) {
  console.error("usage: node scripts/stage-prisma-cli.mjs <dest-dir> [extra-root ...]");
  process.exit(1);
}

const projectRoot = path.resolve(import.meta.dirname, "..");
const ROOTS = ["prisma", "dotenv", ...extraRoots];

/**
 * Resolves a package directory the way Node does: nearest node_modules first,
 * then upward. npm hoists almost everything flat, but a version conflict can
 * still nest a copy, and silently missing it would only surface at deploy time.
 */
function resolvePackageDir(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const staged = new Map(); // name -> source dir
const queue = ROOTS.map((name) => ({ name, from: projectRoot }));
const missingOptional = [];

while (queue.length > 0) {
  const { name, from } = queue.shift();
  if (staged.has(name)) continue;
  const dir = resolvePackageDir(name, from);
  if (!dir) {
    missingOptional.push(name);
    continue;
  }
  staged.set(name, dir);

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    continue;
  }
  // `dependencies` are required; `optionalDependencies` are the platform-specific
  // binaries (esbuild, engines) — take whichever ones this platform installed and
  // skip the rest rather than failing the build.
  for (const depName of [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ]) {
    if (!staged.has(depName)) queue.push({ name: depName, from: dir });
  }
}

const outModules = path.join(path.resolve(dest), "node_modules");
fs.rmSync(outModules, { recursive: true, force: true });
fs.mkdirSync(outModules, { recursive: true });

for (const [name, dir] of staged) {
  const target = path.join(outModules, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // `dereference` so a pnpm-style symlinked store still produces a self-contained
  // tree that COPY --from can lift out in one piece.
  fs.cpSync(dir, target, { recursive: true, dereference: true });
}

console.log(`[stage-prisma-cli] staged ${staged.size} packages into ${outModules}`);
if (missingOptional.length > 0) {
  console.log(`[stage-prisma-cli] not installed on this platform, skipped: ${missingOptional.join(", ")}`);
}
