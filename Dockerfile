# syntax=docker/dockerfile:1.7
#
# ONE image, two commands. The app container runs `node server.js`; the worker
# container runs the same image with `node dist/worker.mjs`. Building twice
# would be smaller, but this way the two containers cannot drift apart on the
# shared code in lib/, and the stack rebuilds with a single `--build`.
#
#   docker compose build tracker-app
#
# Debian slim rather than Alpine: the Prisma CLI's schema engine is a native
# binary and its musl builds are a recurring source of "engine not found" at
# deploy time. The Prisma *client* needs no engine binary — it runs on the WASM
# query compiler through the pg driver adapter — but `migrate deploy` does.

ARG NODE_IMAGE=node:22-bookworm-slim


# ---------------------------------------------------------------------------
# base — shared settings for every stage
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ENV NODE_ENV=production
ENV NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /app


# ---------------------------------------------------------------------------
# deps — full install, dev dependencies included (needed to build)
# ---------------------------------------------------------------------------
FROM base AS deps
# npm reads NODE_ENV and would otherwise omit dev dependencies, which is exactly
# what this stage exists to install (next, typescript, prisma CLI, esbuild).
ENV NODE_ENV=development
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --include=dev


# ---------------------------------------------------------------------------
# prod-deps — production-only install; the runtime's node_modules
# ---------------------------------------------------------------------------
FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev


# ---------------------------------------------------------------------------
# build — Prisma client, Next build, worker bundle, staged Prisma CLI
# ---------------------------------------------------------------------------
FROM base AS build

# A placeholder, never a secret and never used at runtime: `prisma generate`
# wants prisma.config.ts to resolve a datasource URL, and nothing in this stage
# opens a connection. Real credentials reach the containers only as environment
# variables at run time, never as a build layer.
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build?schema=public"

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# generated/ is gitignored, so the client does not exist in the source tree.
# Invoked directly rather than through npx so the build never reaches the
# network for a CLI it already has.
RUN node node_modules/prisma/build/index.js generate

# Next.js standalone output (see next.config.ts).
RUN npm run build

# worker/index.ts -> dist/worker.mjs. The worker is precompiled rather than run
# under tsx, which is a devDependency: see scripts/build-worker.mjs.
RUN node scripts/build-worker.mjs

# The Prisma CLI plus its dependency closure, so the runtime can run
# `migrate deploy` without carrying the whole development install.
RUN node scripts/stage-prisma-cli.mjs /opt/prisma-cli


# ---------------------------------------------------------------------------
# runtime — what both containers run
# ---------------------------------------------------------------------------
FROM base AS runtime

ENV PORT=3000 HOSTNAME=0.0.0.0

# Production dependencies FIRST, so the worker has its full runtime closure
# (cheerio, node-cron, nodemailer, robots-parser, the Anthropic SDK). Next's
# standalone tracing only keeps what the *app* imports, and the worker imports
# more — relying on the traced tree for it would fail at run time, not build
# time, and only on the code path that happens to need the missing package.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules

# .next/standalone is a whole app root: server.js, .next/, package.json and a
# traced node_modules. Copied over the top; both trees come from the same
# package-lock.json, so overlapping packages are byte-identical.
COPY --from=build --chown=node:node /app/.next/standalone ./
# Standalone deliberately omits these two; server.js serves them once present.
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public

# The worker bundle. No "type" field in package.json, so the .mjs extension is
# what makes it ESM.
COPY --from=build --chown=node:node /app/dist/worker.mjs ./dist/worker.mjs
COPY --from=build --chown=node:node /app/dist/worker.mjs.map ./dist/worker.mjs.map

# Migration inputs. prisma.config.ts is what points the CLI at the schema and
# supplies the datasource URL, so it travels with them.
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/prisma.config.ts ./prisma.config.ts

# A baseline scoring config so the container starts even if the bind mount is
# missing; compose mounts the host's config directory over this at run time.
COPY --from=build --chown=node:node /app/config ./config

# Merged into the tree above (COPY into an existing directory merges rather
# than replaces), giving the runtime a `prisma` CLI without the dev install.
COPY --from=build --chown=node:node /opt/prisma-cli/node_modules ./node_modules

COPY --chown=node:node docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# `node` (uid 1000) ships with the official image. Everything above is chowned
# to it, including .next/ — the server writes an image-optimizer cache there.
USER node

# The worker's HTTP port is deliberately never EXPOSEd or published: POST
# /refresh is unauthenticated and starts a full ingest cycle, so it must stay
# reachable only from the compose network.
EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "server.js"]
