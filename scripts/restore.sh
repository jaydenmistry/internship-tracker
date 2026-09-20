#!/bin/sh
# Restores one pg_dump custom-format backup over the tracker database.
#
# THIS IS DESTRUCTIVE: it drops and recreates every object in the target
# database. Stop the app and worker first (see docs/DEPLOYMENT.md), or a write
# landing mid-restore will be lost and can leave a half-applied schema.
#
# Usage, from the Docker host, in the directory holding docker-compose.yml:
#
#   docker compose run --rm --entrypoint sh backup /scripts/restore.sh --list
#   docker compose run --rm --entrypoint sh backup /scripts/restore.sh <file> --confirm
#
# `--entrypoint sh` matters: the backup service's entrypoint is `sh -c`, which
# would swallow the arguments instead of passing them to this script.
#
# Connection settings come from the standard libpq variables, exactly as in
# backup.sh, so the restore always targets the same database the dumps come from
# unless you override PGDATABASE deliberately (which is how you test a restore
# into a scratch database — see docs/DEPLOYMENT.md).
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
DB="${PGDATABASE:-postgres}"

log() { echo "[restore] $*"; }

if [ "${1:-}" = "--list" ] || [ "${1:-}" = "" ]; then
  log "backups in $BACKUP_DIR (newest first):"
  ls -lht "$BACKUP_DIR"/*.dump 2>/dev/null || log "  (none)"
  log ""
  log "restore with: docker compose run --rm --entrypoint sh backup /scripts/restore.sh <file> --confirm"
  exit 0
fi

DUMP="$1"
shift

CONFIRMED=no
for arg in "$@"; do
  [ "$arg" = "--confirm" ] && CONFIRMED=yes
done

if [ ! -f "$DUMP" ]; then
  log "ERROR: no such file: $DUMP"
  exit 1
fi

case "$(basename "$DUMP")" in
  .partial-*)
    log "ERROR: $DUMP is a partial dump from an interrupted backup, not a usable one"
    exit 1
    ;;
esac

# Fails fast and loudly on a truncated or corrupt file, before anything is
# dropped — a restore that destroys the current data and *then* discovers the
# dump is unreadable is the worst possible outcome.
if ! pg_restore --list "$DUMP" >/dev/null 2>&1; then
  log "ERROR: $DUMP is not a readable pg_dump custom-format archive"
  exit 1
fi

if [ "$CONFIRMED" != "yes" ]; then
  log "about to DROP and recreate every object in database '$DB' on ${PGHOST:-?}"
  log "from $DUMP"
  log ""
  log "re-run with --confirm to proceed."
  exit 1
fi

log "restoring $DUMP into '$DB' on ${PGHOST:-?}"

# --clean --if-exists: drop existing objects first, tolerating ones that are
# already gone. --no-owner/--no-acl pairs with the same flags in backup.sh.
# --exit-on-error so a failure stops rather than limping to a partial schema.
pg_restore \
  --dbname="$DB" \
  --clean --if-exists \
  --no-owner --no-acl \
  --exit-on-error \
  "$DUMP"

log "restore complete."
log "verify before restarting the app — see docs/DEPLOYMENT.md#verifying-a-restore"
