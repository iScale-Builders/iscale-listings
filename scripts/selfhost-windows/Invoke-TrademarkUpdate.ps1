<#
.SYNOPSIS
  Daily data update for a self-hosted trademark database on Windows, then a backup.

.DESCRIPTION
  1. US (USPTO): the last 7 days of daily files (scripts/backfill_direct.py).
  2. EU (EUIPO): changes since 8 days ago, once every -EuipoEveryDays UTC calendar days
     (scripts/import_euipo.py, direct-PostgreSQL mode).
  3. Only if every step succeeded: pg_dump (compressed, indexes are rebuilt on
     restore), check the dump is readable and holds the trademarks data, copy it to
     -BackupTarget (local directory or SSH/scp), confirm the copy's SHA-256, and only then prune to the
     newest -Keep. A failed update or an unreadable dump makes no backup and deletes
     nothing, so a good copy is never replaced by a bad one. The database password
     is passed through PGPASSWORD, never on the pg_dump command line.

  -EnvFile holds KEY=VALUE lines: TM_DB_URL, USPTO_API_KEY, EUIPO_CLIENT_ID,
  EUIPO_CLIENT_SECRET. Keep it machine-local and readable only by admins.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File Invoke-TrademarkUpdate.ps1 `
    -RepoDir C:\apps\iscale-listings -EnvFile C:\secure\update.env `
    -PythonExe C:\apps\venv\Scripts\python.exe -BackupTarget backup-host:/backups/trademarks
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$RepoDir,
    [Parameter(Mandatory)] [string]$EnvFile,
    [Parameter(Mandatory)] [string]$PythonExe,
    [string]$BackupTarget = '',
    [string]$SshConfig = '',
    [int]$Keep = 7,
    [int]$EuipoEveryDays = 7,
    [string]$EuipoClasses = '9,16,18,20,21,24,25',
    [string]$PgBin = 'C:\Program Files\PostgreSQL\17\bin',
    [string]$WorkDir = '',
    [string]$NodeExe = 'node'
)
# Every external step is judged by its exit code. Windows PowerShell 5.1 turns any
# stderr line (ssh warnings, python logging) into a terminating error under 'Stop'.
$ErrorActionPreference = 'Continue'
if (-not $WorkDir) { $WorkDir = Join-Path $env:USERPROFILE '.iscale-listings\maintenance' }
$repoFull = [IO.Path]::GetFullPath($RepoDir).TrimEnd('\')
$workFull = [IO.Path]::GetFullPath($WorkDir).TrimEnd('\')
if ($workFull -eq $repoFull -or $workFull.StartsWith($repoFull + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'WorkDir must be outside repo' }
[void](New-Item -ItemType Directory -Path $WorkDir -Force)
$log = Join-Path $WorkDir 'update.log'
function Log([string]$m) { "$(Get-Date -Format s) $m" | Add-Content -LiteralPath $log }
function Fail([string]$m) { Log "FAILED: $m (inspect stage logs; any verified backup is retained)"; exit 1 }

foreach ($line in Get-Content -LiteralPath $EnvFile) {
    if ($line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$') {
        $envName = $Matches[1]; $envValue = $Matches[2].Trim()
        if ($envValue.Length -ge 2 -and (($envValue.StartsWith('"') -and $envValue.EndsWith('"')) -or ($envValue.StartsWith("'") -and $envValue.EndsWith("'")))) {
            $envValue = $envValue.Substring(1, $envValue.Length - 2)
        }
        Set-Item -Path "Env:$envName" -Value $envValue
    }
}
foreach ($name in 'TM_DB_URL', 'USPTO_API_KEY') { if (-not (Get-Item "Env:$name" -ErrorAction SilentlyContinue)) { Fail "$name missing from $EnvFile" } }
Set-Location $RepoDir
$utc = [DateTime]::UtcNow
Log 'start'

# 1. US daily files (idempotent upserts; a 7-day window covers missed days). --skip-imported: only files not yet
# imported cleanly are downloaded; USPTO answers 429 for files already fetched several times (2026-10-06).
$from = $utc.AddDays(-7).ToString('yyyy-MM-dd'); $to = $utc.ToString('yyyy-MM-dd')
$usLog = Join-Path $WorkDir 'us-import.log'
cmd /c "`"$PythonExe`" scripts\backfill_direct.py $from $to --record-sync-metadata --skip-imported >> `"$usLog`" 2>&1"
if ($LASTEXITCODE -ne 0) { Fail "US import exit $LASTEXITCODE" }
Log "US import ok ($from..$to)"

# 2. EU changes, on its own cadence.
$stamp = Join-Path $WorkDir 'last-euipo.txt'
$last = [DateTime]::MinValue
if (Test-Path -LiteralPath $stamp) {
    try {
        $last = [DateTimeOffset]::Parse((Get-Content -LiteralPath $stamp -Raw -ErrorAction Stop).Trim()).UtcDateTime
    } catch { Fail 'EUIPO timestamp unreadable or invalid' }
    if ($last.Date -gt $utc.Date) { Fail 'EUIPO timestamp is a future UTC date' }
}
# Calendar dates keep a late manual run or daily start-time jitter from delaying
# the next weekly import by a day. Normalize offset-bearing stamps before comparing.
if (($utc.Date - $last.Date).Days -ge $EuipoEveryDays) {
    if (-not $env:EUIPO_CLIENT_ID -or -not $env:EUIPO_CLIENT_SECRET) { Fail 'EUIPO_CLIENT_ID / EUIPO_CLIENT_SECRET missing' }
    $since = $utc.AddDays(-8).ToString('yyyy-MM-dd')
    $euLog = Join-Path $WorkDir 'eu-import.log'
    cmd /c "`"$PythonExe`" scripts\import_euipo.py --since $since --classes $EuipoClasses --partition-statuses --batch-size 500 --source-updated-at $to >> `"$euLog`" 2>&1"
    if ($LASTEXITCODE -ne 0) { Fail "EU import exit $LASTEXITCODE" }
    Set-Content -LiteralPath $stamp -Value $utc.ToString('o')
    Log "EU import ok (since $since)"
}

# 3. Fresh coverage is required before scanning the same user's local store.
& $NodeExe cli/iscale.mjs setup health --json
if ($LASTEXITCODE -ne 0) { Fail 'coverage health gate failed; scan skipped' }
# 4. Verified local-drive or SSH backup. No pruning before copy SHA-256 matches.
if ($BackupTarget) {
    $backupArgs = @('scripts/local_lifecycle.py', '--backup-only', '--env-file', $EnvFile,
        '--work-dir', $WorkDir, '--backup-target', $BackupTarget, '--pg-bin', $PgBin, '--keep', "$Keep")
    if ($SshConfig) { $backupArgs += @('--ssh-config', $SshConfig) }
    & $PythonExe @backupArgs
    if ($LASTEXITCODE -ne 0) { Fail 'verified backup failed' }
} else { Log 'BACKUP NOT CONFIGURED: supply a local drive directory or SSH target' }
& $NodeExe cli/iscale.mjs listings scan --include-description
$scanExit = $LASTEXITCODE
if ($scanExit -notin 0, 2) { Fail "shop scan exit $scanExit" }
Log 'done'
exit $scanExit
