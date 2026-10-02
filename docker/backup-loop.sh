#!/bin/sh
set -eu
last=0
while true; do
  now=$(date +%s)
  if [ $((now-last)) -ge 86400 ]; then
    if sh /ops/backup-once.sh daily; then last=$now; else echo 'Backup failed; retrying in one minute' >&2; fi
  fi
  if [ -f /app-data/deletion-log.jsonl ]; then
    umask 077
    cp /app-data/deletion-log.jsonl /backups/deletion-log.latest.jsonl.partial
    mv /backups/deletion-log.latest.jsonl.partial /backups/deletion-log.latest.jsonl
  fi
  sleep 60
done
