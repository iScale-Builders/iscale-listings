#!/usr/bin/env bash
# Refresh your trademark database, then re-check every monitored listing.
# Schedule daily with cron (see docs/setup/schedule.md).
# The EU refresh runs on Mondays (or with --euipo); the US refresh runs every time.
set -u
cd "$(dirname "$0")/.."

# Load .env.local into this process only (values are never printed).
if [ -f .env.local ]; then
  while IFS='=' read -r key value; do
    [[ "$key" =~ ^[A-Z0-9_]+$ ]] || continue
    value="${value%\"}"; value="${value#\"}"
    [ -n "$value" ] && [[ ! "$value" =~ ^\<.*\>$ ]] && export "$key=$value"
  done < .env.local
fi

days_ago() { date -u -d "$1 days ago" +%Y-%m-%d 2>/dev/null || date -u -v-"$1"d +%Y-%m-%d; }
today=$(date -u +%Y-%m-%d)
eu_exit=skipped

echo "US update (last 7 days)..."
python3 scripts/backfill_direct.py "$(days_ago 7)" "$today" --record-sync-metadata || { code=$?; echo "US update failed; shop scan skipped." >&2; node scripts/write-refresh-receipt.mjs "$code" skipped skipped skipped; exit "$code"; }

if [ "${1:-}" = "--euipo" ] || [ "$(date -u +%u)" = "1" ]; then
  eu_exit=0
  echo "EU update (last 8 days)..."
  python3 scripts/import_euipo.py --since "$(days_ago 8)" --classes 9,16,18,20,21,24,25 --partition-statuses --batch-size 100 --source-updated-at "$today" \
    || { code=$?; echo "EU update failed; shop scan skipped." >&2; node scripts/write-refresh-receipt.mjs 0 "$code" skipped skipped; exit "$code"; }
fi

node cli/iscale.mjs setup health --json || { code=$?; node scripts/write-refresh-receipt.mjs 0 "$eu_exit" "$code" skipped; exit "$code"; }
echo "Re-checking monitored listings..."
node cli/iscale.mjs listings scan --include-description
scan=$?

node scripts/write-refresh-receipt.mjs 0 "$eu_exit" 0 "$scan" || {
  echo "Run receipt could not be saved; completion is unverified." >&2
  [ "$scan" != 0 ] && [ "$scan" != 2 ] && exit "$scan"
  exit 1
}
exit "$scan"
