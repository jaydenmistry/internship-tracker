# syntax=docker/dockerfile:1.7
#
# One image source, two runtime targets: `app` (Next.js server) and `worker`
# (node-cron scheduler). Both are built from this repo so they can never drift
# apart on the shared code in lib/.
#
#   docker build --target app    -t internship-tracker-app    .
#   docker build --target worker -t internship-tracker-worker .
#
# Debian slim rather than Alpine: the Prisma CLI's schema engine is a native
# binary, and its musl builds are a recurring source of "engine not found" at
# deploy time. The Prisma *client* needs no engine binary here — it runs on the
# WASM query compiler through the pg driver adapter — but `migrate deploy` does.

ARG NODE_IMAGE=node:22-bookworm-slim


# ---------------------------------------------------------------------------
# base — shared settings for every stage
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ENV NODE_ENV=production
# Turn npm's progress/funding chatter off so build logs stay readable.
ENV NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /app


# ---------------------------------------------------------------------------
# deps — the full install, dev dependencies included (needed to build)
# ---------------------------------------------------------------------------
FROM base AS deps
# npm reads NODE_ENV and would otherwise omit dev dependencies, which is exactly
# what this stage exists to install (next, typescript, prisma CLI, esbuild).
ENV NODE_ENV=development
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --include=dev


# ---------------------------------------------------------------------------
# prod-deps — production-only install, used by the worker runtime
# ---------------------------------------------------------------------------
FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev


# ---------------------------------------------------------------------------
# build — generate the Prisma client, build Next, compile the worker
# ---------------------------------------------------------------------------
FROM base AS build

# A placeholder, never a secret and never used at runtime: `prisma generate`
# wants prisma.config.ts to resolve a datasource URL, and nothing in this stage
# opens a connection. Real credentials reach the containers only as environment
# variables at run time, never as a build layer.
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build?schema=public"

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# generated/ is gitignored, so the client does not exist in the source tree and
# has to be generated here. Invoked directly rather than through npx so the
# build can never reach the network for a CLI it already has.
RUN node node_modules/prisma/build/index.js generate

# Next.js standalone output (see next.config.ts).
RUN npm run build

# worker/index.ts -> dist/worker.mjs. See scripts/build-worker.mjs for why the
# worker is precompiled instead of running under tsx.
RUN node scripts/build-worker.mjs

# The Prisma CLI and its dependency closure, so the app image can run
# `migrate deploy` without carrying the whole development install.
RUN node scripts/stage-prisma-cli.mjs /opt/prisma-cli


# ---------------------------------------------------------------------------
# app — Next.js server. Runs migrations, then serves.
# ---------------------------------------------------------------------------
FROM base AS app

# The standalone server reads both of these; 0.0.0.0 so Traefik can reach it
# from outside the container's loopback.
ENV PORT=3000 HOSTNAME=0.0.0.0

# .next/standalone is a whole app root: server.js, .next/, package.json and a
# traced node_modules. It lands at /app, which everything below extends.
COPY --from=build --chown=node:node /app/.next/standalone ./
# Standalone deliberately omits these two; server.js serves them once present.
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public

# Migration inputs. prisma.config.ts is what points the CLI at the schema and
# supplies the datasource URL, so it has to travel with them.
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/prisma.config.ts ./prisma.config.ts

# A baseline scoring config so the container starts even if the bind mount is
# missing; compose mounts ./config over this directory at run time.
COPY --from=build --chown=node:node /app/config ./config

# Merged into the traced tree (COPY into an existing directory merges rather
# than replaces). Both trees come from the same package-lock.json, so shared
# packages are byte-identical and the overlay cannot produce a version skew.
COPY --from=build --chown=node:node /opt/prisma-cli/node_modules ./node_modules

COPY --chown=node:node docker/app-entrypoint.sh /usr/local/bin/app-entrypoint.sh
RUN chmod +x /usr/local/bin/app-entrypoint.sh

# `node` (uid 1000) ships with the official image. Everything above is
# chowned to it, including .next/ — the server writes its image-optimizer cache
# under .next/cache at run time.
USER node
EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/app-entrypoint.sh"]
CMD ["node", "server.js"]


# ---------------------------------------------------------------------------
# worker — node-cron scheduler. No TypeScript, no Next, no Prisma CLI.
# ---------------------------------------------------------------------------
FROM base AS worker

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist/worker.mjs ./dist/worker.mjs
COPY --from=build --chown=node:node /app/dist/worker.mjs.map ./dist/worker.mjs.map
COPY --from=build --chown=node:node /app/config ./config
# No "type" field in package.json, so the .mjs extension is what makes this ESM.
COPY --from=build --chown=node:node /app/package.json ./package.json

USER node

# The worker's HTTP port is intentionally not EXPOSEd and never published:
# /refresh must stay reachable only from the internal compose network.

# --enable-source-maps maps stack traces back through the esbuild bundle to the
# original .ts files; without it every trace points at dist/worker.mjs.
CMD ["node", "--enable-source-maps", "dist/worker.mjs"]
