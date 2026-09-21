#!/bin/sh
# Shared entrypoint for both containers built from this image.
#
# Migrations run ONLY when RUN_MIGRATIONS is set, and only the app service sets
# it. Both containers share one image, so an unconditional `migrate deploy`
# here would mean two containers racing to migrate the same database on every
# `docker compose up` — Prisma takes an advisory lock, so the loser blocks
# rather than corrupting anything, but it is a needless way to make a boot
# failure look like a hang.
#
# The order matters for the app: migrations must finish before server.js
# accepts a request, or it serves reads against a schema its client was not
# compiled for. A failure exits non-zero, so the container stops instead of
# starting half-migrated, and compose's restart policy retries.
set -e

case "${RUN_MIGRATIONS:-}" in
  1|true|TRUE|yes)
    echo "[entrypoint] applying pending migrations"
    node /app/node_modules/prisma/build/index.js migrate deploy
    echo "[entrypoint] migrations applied"
    ;;
  *)
    echo "[entrypoint] RUN_MIGRATIONS unset; skipping migrations"
    ;;
esac

echo "[entrypoint] starting: $*"
exec "$@"
