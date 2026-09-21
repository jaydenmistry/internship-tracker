#!/bin/sh
# Healthy while a dump newer than two backup intervals exists.
#
# Lives in a file rather than inline in compose because the inline form needed
# nested quoting plus `$$` on every shell variable (compose expands a single
# `$` itself at parse time, so `$BACKUP_DIR` would arrive empty). One escaping
# slip there produces a container that reports healthy while backing up
# nothing, which is the exact failure a backup healthcheck exists to catch.
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
INTERVAL="${BACKUP_INTERVAL_SECONDS:-86400}"

# Two intervals of grace, in minutes, so one slow dump is not an outage.
WINDOW_MIN=$(( (INTERVAL * 2) / 60 ))
[ "$WINDOW_MIN" -lt 1 ] && WINDOW_MIN=1

if [ -n "$(find "$BACKUP_DIR" -name '*.dump' -mmin "-$WINDOW_MIN" 2>/dev/null | head -n 1)" ]; then
  exit 0
fi

echo "no dump in $BACKUP_DIR newer than ${WINDOW_MIN}m"
exit 1
