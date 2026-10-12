<#
.SYNOPSIS
  Keep the self-hosted trademark API running on Windows (no Docker).

.DESCRIPTION
  Run it every few minutes from a scheduled task. If the API answers on its port
  (200, or 401 when REQUIRE_API_KEY locks it), it does nothing. Otherwise it stops a
  stale copy of itself and starts `next start` (output to server.*.log next to the
  keeper) from the repo folder, which reads DATABASE_URL and the rest from the repo's .env.local.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File Invoke-TrademarksApiKeeper.ps1 -RepoDir C:\apps\iscale-listings -Port 3090
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$RepoDir,
    [int]$Port = 3090,
    [string]$BindHost = '0.0.0.0',
    [string]$LogPath = ''
)
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 has no $PSScriptRoot inside param() defaults.
if (-not $LogPath) { $LogPath = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'keeper.log' }
$ProgressPreference = 'SilentlyContinue'

function Log([string]$Message) { "$(Get-Date -Format s) $Message" | Add-Content -LiteralPath $LogPath }

function Test-Api {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 8 "http://127.0.0.1:$Port/api/v1/health"
        return $r.StatusCode -eq 200
    } catch {
        $code = $_.Exception.Response.StatusCode.value__
        return $code -eq 401 # locked to an API key: up and refusing anonymous calls
    }
}

$next = Join-Path $RepoDir 'node_modules\next\dist\bin\next'
foreach ($required in @($next, (Join-Path $RepoDir '.next\BUILD_ID'), (Join-Path $RepoDir '.env.local'))) {
    if (-not (Test-Path -LiteralPath $required)) { Log "MISSING $required (npm ci; npm run build; create .env.local)"; exit 2 }
}

$listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    if (Test-Api) { exit 0 }
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
    if ($owner.Name -ieq 'node.exe' -and [string]$owner.CommandLine -like "*$next*") {
        Log "UNHEALTHY pid $($owner.ProcessId); restarting"
        Stop-Process -Id $owner.ProcessId -Force
        Start-Sleep -Seconds 2
    } else {
        Log "PORT $Port is used by another program ($($owner.Name) pid $($owner.ProcessId)); not touching it"
        exit 3
    }
}

$node = (Get-Command node.exe).Source
# Run from a scheduled task (no desktop, so no window can appear); output goes to logs.
$logDir = Split-Path -Parent $LogPath
Start-Process -FilePath $node -WorkingDirectory $RepoDir -WindowStyle Hidden `
    -ArgumentList @("`"$next`"", 'start', '-p', "$Port", '-H', $BindHost) `
    -RedirectStandardOutput (Join-Path $logDir 'server.out.log') -RedirectStandardError (Join-Path $logDir 'server.err.log')
$deadline = (Get-Date).AddSeconds(60)
do { Start-Sleep -Seconds 2 } until ((Test-Api) -or (Get-Date) -gt $deadline)
if (Test-Api) { Log "STARTED on port $Port"; exit 0 }
Log "FAILED to start on port $Port within 60 s"
exit 1
