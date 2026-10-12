<# Isolated UTC calendar-date cadence tests. No imports, network, or database calls. #>
$ErrorActionPreference = 'Stop'
$source = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Invoke-TrademarkUpdate.ps1') -Raw
$tokens = $null; $errors = $null
[void][System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw "Updater syntax errors: $($errors.Count)" }
$assignment = [regex]::Match($source, '(?ms)^\$last = .*?(?=^# Calendar dates)').Value
$predicate = [regex]::Match($source, '(?m)^if \((\(\$utc\.Date - \$last\.Date\)\.Days -ge \$EuipoEveryDays)\) \{').Groups[1].Value
if (-not $assignment -or -not $predicate) { throw 'Cadence source contract missing' }
function Test-Path { return $script:hasStamp }
function Get-Content { return $script:stampText }
function Fail { throw $args[0] }
$stamp = 'isolated-stamp'; $EuipoEveryDays = 7
$cases = @(
    @('actual late Monday, Sunday', '2026-10-05T22:54:17.4229088Z', '2026-10-11T08:30:00Z', $false),
    @('actual late Monday, next Monday', '2026-10-05T22:54:17.4229088Z', '2026-10-12T08:30:00Z', $true),
    @('daily jitter before same clock time', '2026-10-05T08:30:01Z', '2026-10-12T08:30:00Z', $true),
    @('offset normalized across UTC midnight', '2026-10-05T23:30:00-04:00', '2026-10-12T08:30:00Z', $false),
    @('offset normalized, seven UTC dates', '2026-10-05T23:30:00-04:00', '2026-10-13T08:30:00Z', $true),
    @('missing stamp', $null, '2026-10-12T08:30:00Z', $true)
)
foreach ($case in $cases) {
    $script:hasStamp = $null -ne $case[1]; $script:stampText = $case[1]
    $utc = [DateTimeOffset]::Parse($case[2]).UtcDateTime
    . ([scriptblock]::Create($assignment))
    $due = . ([scriptblock]::Create($predicate))
    if ($due -ne $case[3]) { throw "Failed: $($case[0])" }
    Write-Output "PASS: $($case[0]) due=$due"
}
# Execute the real stamp guard and Fail function in separate Windows PowerShell
# processes with the production Continue setting. A backup marker must be unreachable.
$failDefinition = [regex]::Match($source, '(?m)^function Fail\(.+$').Value
if (-not $failDefinition) { throw 'Production Fail function missing' }
foreach ($failure in @('malformed', 'future', 'unreadable')) {
    $read = switch ($failure) {
        'malformed' { "function Get-Content { return 'not-a-date' }" }
        'future' { "function Get-Content { return '2026-10-13T08:30:00Z' }" }
        'unreadable' { "function Get-Content { throw 'isolated read failure' }" }
    }
    $child = @'
$ErrorActionPreference = 'Continue'
function Log { Write-Output $args[0] }
function Test-Path { return $true }
$stamp = 'isolated-stamp'
$utc = [DateTimeOffset]::Parse('2026-10-12T08:30:00Z').UtcDateTime
'@
    $child += "`n$read`n$failDefinition`n$assignment`nWrite-Output 'BACKUP_REACHED'"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($child))
    $result = & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -EncodedCommand $encoded 2>&1
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 1 -or ($result -join "`n") -match 'BACKUP_REACHED' -or ($result -join "`n") -notmatch 'FAILED: EUIPO timestamp') {
        throw "Failure guard failed: $failure exit=$exitCode output=$result"
    }
    Write-Output "PASS: $failure production Continue process exit=$exitCode backupReached=False receipt=$result"
}
Write-Output 'PASS: updater syntax; 6 cadence cases; 3 production failure subprocesses'
