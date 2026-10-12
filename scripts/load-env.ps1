param([string]$EnvFile = (Join-Path (Split-Path -Parent $PSScriptRoot) '.env.local'))
# Dot-source this helper. It prints no values and changes only this shell.
$ErrorActionPreference = 'Stop'
foreach ($line in Get-Content -LiteralPath $EnvFile) {
  if ($line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$') {
    $value = $Matches[2].Trim().Trim('"').Trim("'")
    if ($value -and $value -notmatch '^<.*>$') { [Environment]::SetEnvironmentVariable($Matches[1], $value, 'Process') }
  }
}
