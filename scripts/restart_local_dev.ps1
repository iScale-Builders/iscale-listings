param(
  [int]$Port = 3000
)

$ErrorActionPreference = 'Stop'

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if ((Split-Path $repo -Leaf) -ne 'iscale-listings') {
  throw "Unexpected repo path: $repo"
}

$listeners = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
  Where-Object { $_.State -eq 'Listen' } |
  Select-Object -ExpandProperty OwningProcess -Unique

$candidateProcesses = @()
foreach ($process in Get-CimInstance Win32_Process -ErrorAction SilentlyContinue) {
  $commandLine = $process.CommandLine
  if (-not $commandLine) {
    continue
  }

  $isRepoProcess = $commandLine -like "*$repo*" -or $commandLine -like "*iscale-listings*"
  $isNextDevProcess =
    $commandLine -like "*next* dev*" -or
    $commandLine -like "*next\dist\bin\next* dev*" -or
    $commandLine -like "*next\dist\server\lib\start-server.js*"
  $isNextBuildProcess =
    $commandLine -like "*next* build*" -or
    $commandLine -like "*next\dist\bin\next* build*" -or
    $commandLine -like "*next\dist\compiled\jest-worker\processChild.js*"

  if ($isRepoProcess -and ($isNextDevProcess -or $isNextBuildProcess)) {
    $candidateProcesses += $process.ProcessId
  }
}

$processesToStop = @($listeners) + @($candidateProcesses) |
  Where-Object { $_ } |
  Select-Object -Unique

foreach ($processId in $processesToStop) {
  Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Seconds 2

$nextPath = Join-Path $repo '.next'
if (Test-Path $nextPath) {
  $resolvedNext = (Resolve-Path $nextPath).Path
  if (-not $resolvedNext.StartsWith($repo, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove unexpected path: $resolvedNext"
  }
  Remove-Item -LiteralPath $resolvedNext -Recurse -Force
}

$credentialPath = $env:TM_VAULT
if (-not $credentialPath) {
  throw "Set the TM_VAULT environment variable to your credentials file path"
}
if (-not (Test-Path $credentialPath)) {
  throw "Missing credential vault: $credentialPath"
}

$credentials = Get-Content $credentialPath -Raw

function Get-TableValue {
  param([string]$Section, [string]$Label)
  $pattern = '## ' + [regex]::Escape($Section) + '[\s\S]*?\| ' + [regex]::Escape($Label) + ' \| `([^`]+)` \|'
  $match = [regex]::Match($credentials, $pattern)
  if (-not $match.Success) {
    throw "Missing credential field: $Section / $Label"
  }
  return $match.Groups[1].Value
}

$supabaseUrl = Get-TableValue 'Supabase (iScaleListings)' 'URL'
$supabaseAnon = Get-TableValue 'Supabase (iScaleListings)' 'Anon Key'
$supabaseService = Get-TableValue 'Supabase (iScaleListings)' 'Service Role Key'

$log = Join-Path $env:TEMP 'iscale-listings-next-dev.log'
$err = Join-Path $env:TEMP 'iscale-listings-next-dev.err.log'
Remove-Item $log, $err -ErrorAction SilentlyContinue

try {
  $env:NEXT_PUBLIC_SUPABASE_URL = $supabaseUrl
  $env:NEXT_PUBLIC_SUPABASE_ANON_KEY = $supabaseAnon
  $env:SUPABASE_SERVICE_ROLE_KEY = $supabaseService

  Start-Process `
    -FilePath 'C:\Program Files\nodejs\npm.cmd' `
    -ArgumentList @('run', 'dev') `
    -WorkingDirectory $repo `
    -WindowStyle Hidden `
    -RedirectStandardOutput $log `
    -RedirectStandardError $err
} finally {
  Remove-Item Env:\NEXT_PUBLIC_SUPABASE_URL, Env:\NEXT_PUBLIC_SUPABASE_ANON_KEY, Env:\SUPABASE_SERVICE_ROLE_KEY -ErrorAction SilentlyContinue
}

Start-Sleep -Seconds 8

$activeListener = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
  Where-Object { $_.State -eq 'Listen' } |
  Select-Object -First 1

if (-not $activeListener) {
  Write-Host "Dev server did not start on port $Port. See $log and $err"
  exit 1
}

Write-Host "Dev server listening on http://localhost:$Port"
Write-Host "stdout: $log"
Write-Host "stderr: $err"
