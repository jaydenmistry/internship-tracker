#!/bin/sh
# Takes one custom-format pg_dump of the tracker database and prunes old ones.
#
# Runs inside a postgres:17-alpine container (see the `backup` service in
# docker-compose.yml) rather than in the worker: pg_dump refuses to dump from a
# server newer than itself, so the dump tool has to come from the same image as
# the server. Using the node image would mean pinning a postgres-client version
# by hand and re-pinning it on every Postgres upgrade.
#
# Connection settings come from the standard libpq variables (PGHOST, PGPORT,
# PGUSER, PGPASSWORD, PGDATABASE) so no credential is ever a command argument —
# arguments are visible in `ps`, environment variables are not.
#
# Knobs:
#   BACKUP_DIR              where dumps land (default /backups)
#   BACKUP_RETENTION_DAYS   delete dumps older than this (default 14)
#   BACKUP_KEEP_MIN         always keep at least this many, whatever their age
#                           (default 7) — so a fortnight of downtime cannot
#                           leave the volume empty
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
KEEP_MIN="${BACKUP_KEEP_MIN:-7}"
DB="${PGDATABASE:-postgres}"

log() { echo "[backup] $*"; }

mkdir -p "$BACKUP_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FINAL="$BACKUP_DIR/${DB}-${STAMP}.dump"
# Written under a name the retention sweep and the restore script both ignore,
# so a dump killed halfway through is never mistaken for a usable backup.
PARTIAL="$BACKUP_DIR/.partial-${DB}-${STAMP}.dump"

log "dumping ${PGUSER:-?}@${PGHOST:-?}/${DB} -> $(basename "$FINAL")"

# -Fc: custom format — compressed, and restorable selectively with pg_restore.
# --no-owner/--no-acl: the dump restores cleanly even if the role it is restored
# as differs from the role that created the objects.
if ! pg_dump -Fc --no-owner --no-acl -f "$PARTIAL"; then
  log "ERROR: pg_dump failed; leaving previous backups untouched"
  rm -f "$PARTIAL"
  exit 1
fi

# A dump that pg_restore cannot read is not a backup. Cheap to check now,
# expensive to discover during an actual restore.
if ! pg_restore --list "$PARTIAL" >/dev/null 2>&1; then
  log "ERROR: dump is not readable by pg_restore; discarding"
  rm -f "$PARTIAL"
  exit 1
fi

mv "$PARTIAL" "$FINAL"
log "wrote $(basename "$FINAL") ($(du -h "$FINAL" | cut -f1))"

# --- retention -------------------------------------------------------------
# Newest first, so the index is "how many newer backups exist".
i=0
for f in $(ls -1t "$BACKUP_DIR"/*.dump 2>/dev/null); do
  i=$((i + 1))
  if [ "$i" -le "$KEEP_MIN" ]; then
    continue
  fi
  if [ -n "$(find "$f" -mtime +"$RETENTION_DAYS" 2>/dev/null)" ]; then
    log "pruning $(basename "$f")"
    rm -f "$f"
  fi
done

# Abandoned partials from a killed container.
find "$BACKUP_DIR" -name '.partial-*.dump' -mtime +1 -exec rm -f {} + 2>/dev/null || true

log "done; $(ls -1 "$BACKUP_DIR"/*.dump 2>/dev/null | wc -l | tr -d ' ') backup(s) retained"
