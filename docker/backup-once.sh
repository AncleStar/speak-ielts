#!/bin/sh
set -eu
# Run in the application image, which includes the matching PostgreSQL clients.
case "${1:-daily}" in
  premigrate) exec node --import tsx scripts/backup.ts --maintenance --allow-empty-db ;;
  daily|manual) exec node --import tsx scripts/backup.ts --maintenance ;;
  *) echo 'Unknown backup purpose' >&2; exit 2 ;;
esac
