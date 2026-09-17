#!/usr/bin/env bash
# ============================================================================
# Cron entrypoint for the daily ETL sync. This script must run on a
# machine/server that has real network access to the production SQL
# Server (202.4.117.56:1433) — it will NOT work from an isolated sandbox.
#
# Example crontab line (runs daily at 2:00 AM server time):
#   0 2 * * * /path/to/bi-warehouse/scripts/run-daily-sync.sh >> /var/log/bi-etl.log 2>&1
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
node src/etl/sync.mjs
