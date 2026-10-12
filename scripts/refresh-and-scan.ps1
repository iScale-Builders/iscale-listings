# Refresh your trademark database, then re-check every monitored listing.
# Schedule daily with Task Scheduler (see docs/setup/schedule.md).
# The EU refresh runs on Mondays (or with -Euipo); the US refresh runs every time.
param([switch]$Euipo)

# Native stderr may contain progress; stage exit codes decide success/failure.
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo -ErrorAction Stop

# Load .env.local into this process only (values are never printed).
$envFile = Join-Path $repo '.env.local'
if (Test-Path $envFile) {
  foreach ($line in Get-Content -LiteralPath $envFile -ErrorAction Stop) {
    if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$' -and $Matches[2].Trim() -and $Matches[2].Trim() -notmatch '^<.*>$') {
      [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim().Trim('"'), 'Process')
    }
  }
}

$today = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')
$euExit = 'skipped'

Write-Host "US update (last 7 days)..."
python scripts/backfill_direct.py (Get-Date).ToUniversalTime().AddDays(-7).ToString('yyyy-MM-dd') $today --record-sync-metadata
if ($LASTEXITCODE -ne 0) { $updateExit = $LASTEXITCODE; Write-Warning 'US update failed; shop scan skipped.'; node scripts/write-refresh-receipt.mjs $updateExit skipped skipped skipped; exit $updateExit }

if ($Euipo -or (Get-Date).DayOfWeek -eq 'Monday') {
  $euExit = '0'
  Write-Host "EU update (last 8 days)..."
  python scripts/import_euipo.py --since (Get-Date).ToUniversalTime().AddDays(-8).ToString('yyyy-MM-dd') --classes 9,16,18,20,21,24,25 --partition-statuses --batch-size 100 --source-updated-at $today
  if ($LASTEXITCODE -ne 0) { $updateExit = $LASTEXITCODE; Write-Warning 'EU update failed; shop scan skipped.'; node scripts/write-refresh-receipt.mjs 0 $updateExit skipped skipped; exit $updateExit }
}

node cli/iscale.mjs setup health --json
if ($LASTEXITCODE -ne 0) { $healthExit = $LASTEXITCODE; Write-Warning "Fresh private API coverage not verified; shop scan skipped."; node scripts/write-refresh-receipt.mjs 0 $euExit $healthExit skipped; exit $healthExit }
Write-Host "Re-checking monitored listings..."
node cli/iscale.mjs listings scan --include-description
$scan = $LASTEXITCODE

node scripts/write-refresh-receipt.mjs 0 $euExit 0 $scan
if ($LASTEXITCODE -ne 0) {
  Write-Warning 'Run receipt could not be saved; completion is unverified.'
  if ($scan -ne 0 -and $scan -ne 2) { exit $scan }
  exit 1
}
exit $scan
