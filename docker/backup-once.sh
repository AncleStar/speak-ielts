#!/bin/sh
set -eu
umask 077
mkdir -p /backups
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="/backups/${stamp}-${1:-daily}"
pg_dump --format=custom --file="${target}.dump.partial"
mv "${target}.dump.partial" "${target}.dump"
tar -czf "${target}.data.tar.gz.partial" -C /app-data .
mv "${target}.data.tar.gz.partial" "${target}.data.tar.gz"
if [ -f /app-data/deletion-log.jsonl ]; then
  cp /app-data/deletion-log.jsonl /backups/deletion-log.latest.jsonl.partial
  mv /backups/deletion-log.latest.jsonl.partial /backups/deletion-log.latest.jsonl
fi
# Only dated backups in this dedicated mount are eligible; the latest tombstone log is never pruned.
find /backups -maxdepth 1 -type f -name '20*-*.dump' -mtime +6 -delete
find /backups -maxdepth 1 -type f -name '20*-*.data.tar.gz' -mtime +6 -delete
echo "Backup completed: ${stamp}"
