#!/bin/sh
# Applies pending migrations, then hands off to the server.
#
# The order is the point: `prisma migrate deploy` must finish before server.js
# accepts a request, or the app serves reads against a schema that does not
# match the client it was compiled with. A failure here exits non-zero, which
# stops the container rather than starting it — Docker's restart policy retries,
# and the app never comes up half-migrated.
set -e

echo "[entrypoint] applying pending migrations"
node /app/node_modules/prisma/build/index.js migrate deploy
echo "[entrypoint] migrations applied; starting $*"

exec "$@"
