#!/bin/sh
set -eu
exec node --import tsx scripts/backup-loop.ts
