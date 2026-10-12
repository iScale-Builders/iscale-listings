# Sandboxed real registration script: task cmdlets mocked; no real task changes.
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$temp = Join-Path ([IO.Path]::GetTempPath()) ('iscale-register-' + [Guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $temp)
$global:iscaleTestTasks = [Collections.Generic.List[object]]::new()
function New-ScheduledTaskPrincipal { param($UserId,$LogonType,$RunLevel); return @{kind='principal'} }
function New-ScheduledTaskSettingsSet { param([switch]$StartWhenAvailable,$MultipleInstances,$ExecutionTimeLimit); return @{kind='settings'} }
function New-ScheduledTaskTrigger { param([switch]$Once,[switch]$Daily,$At,$RepetitionInterval); return @{kind='trigger'} }
function New-ScheduledTaskAction { param($Execute,$Argument,$WorkingDirectory); return @{execute=$Execute;argument=$Argument;working=$WorkingDirectory} }
function Register-ScheduledTask { param($TaskName,$Action,$Trigger,$Principal,$Settings,[switch]$Force); $global:iscaleTestTasks.Add(@{name=$TaskName;action=$Action}) }
try {
    $work = Join-Path $temp 'maintenance'
    & (Join-Path $repo 'scripts\selfhost-windows\Register-LocalLifecycle.ps1') -RepoDir $repo -EnvFile (Join-Path $temp 'private.env') -PythonExe (Get-Command python).Source -BackupTarget (Join-Path $temp 'backups') -WorkDir $work
    if ($global:iscaleTestTasks.Count -ne 2 -or -not (Test-Path $work)) { throw 'Tasks/work directory missing' }
    $node = (Get-Command node.exe).Source
    foreach ($call in $global:iscaleTestTasks) {
        if (-not $call.action.argument.Contains("-NodeExe `"$node`"")) { throw 'Task missing absolute NodeExe' }
    }
    $api = $global:iscaleTestTasks | Where-Object name -like '* API'
    if ($api.action.argument -notlike '*-Port 3000 -BindHost 127.0.0.1*') { throw 'API default/bind mismatch' }
    $before = $global:iscaleTestTasks.Count
    $refused = $false
    try {
        & (Join-Path $repo 'scripts\selfhost-windows\Register-LocalLifecycle.ps1') -RepoDir $repo -EnvFile (Join-Path $temp 'private.env') -PythonExe (Get-Command python).Source -BackupTarget (Join-Path $temp 'backups') -WorkDir (Join-Path $repo 'unsafe-test-work')
    } catch { $refused = $_.Exception.Message -like '*outside repo*' }
    if (-not $refused -or $global:iscaleTestTasks.Count -ne $before) { throw 'Repo work-directory guard failed' }
    foreach ($scriptFile in Get-ChildItem (Join-Path $repo 'scripts\selfhost-windows') -Filter '*.ps1') {
        $tokens=$null; $errors=$null
        [void][System.Management.Automation.Language.Parser]::ParseFile($scriptFile.FullName,[ref]$tokens,[ref]$errors)
        if ($errors.Count) { throw "Syntax errors: $($scriptFile.Name)" }
    }
    Write-Output 'PASS: mocked registration; 2 tasks; absolute NodeExe; loopback:3000; mkdir; repo-work guard; all Windows script syntax'
} finally {
    # Exact task-owned temp directory only.
    $full = [IO.Path]::GetFullPath($temp)
    if (-not $full.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase)) { throw 'Temp cleanup boundary' }
    Remove-Item -LiteralPath $full -Recurse -Force
}
