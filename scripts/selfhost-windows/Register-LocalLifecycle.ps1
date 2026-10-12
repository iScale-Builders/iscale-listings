<# Register current-user tasks: daily update/scan/backup and a loopback API keeper.
   Run after npm run build, successful initial imports and private auth setup.
   Interactive-token tasks run only while this same user is signed in. #>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$RepoDir,
    [Parameter(Mandatory)][string]$EnvFile,
    [Parameter(Mandatory)][string]$PythonExe,
    [Parameter(Mandatory)][string]$BackupTarget,
    [string]$PgBin = 'C:\Program Files\PostgreSQL\17\bin',
    [string]$WorkDir = '',
    [string]$DailyAt = '08:30',
    [string]$TaskPrefix = 'iScale Listings'
)
$ErrorActionPreference = 'Stop'
if (-not $WorkDir) { $WorkDir = Join-Path $env:USERPROFILE '.iscale-listings\maintenance' }
$RepoDir = (Resolve-Path -LiteralPath $RepoDir).Path.TrimEnd('\')
$WorkDir = [IO.Path]::GetFullPath($WorkDir).TrimEnd('\')
if ($WorkDir -eq $RepoDir -or $WorkDir.StartsWith($RepoDir + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'WorkDir must be outside repo' }
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
if (-not $WhatIfPreference) { [void](New-Item -ItemType Directory -Path $WorkDir -Force) }
foreach ($value in @($RepoDir,$EnvFile,$PythonExe,$BackupTarget,$PgBin,$WorkDir,$nodeExe)) {
    if ($value.Contains('"') -or $value.Contains("`n")) { throw 'Arguments must not contain quotes/newlines' }
}
$update = Join-Path $RepoDir 'scripts\selfhost-windows\Invoke-TrademarkUpdate.ps1'
$keeper = Join-Path $RepoDir 'scripts\selfhost-windows\Invoke-TrademarksApiKeeper.ps1'
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 12)
$updateArgs = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$update`" -RepoDir `"$RepoDir`" -EnvFile `"$EnvFile`" -PythonExe `"$PythonExe`" -BackupTarget `"$BackupTarget`" -PgBin `"$PgBin`" -WorkDir `"$WorkDir`" -NodeExe `"$nodeExe`""
$keeperArgs = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$keeper`" -RepoDir `"$RepoDir`" -Port 3000 -BindHost 127.0.0.1 -NodeExe `"$nodeExe`" -LogPath `"$(Join-Path $WorkDir 'keeper.log')`""
$apiTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
foreach ($job in @(@('Update', $updateArgs, (New-ScheduledTaskTrigger -Daily -At $DailyAt)), @('API', $keeperArgs, $apiTrigger))) {
    if ($PSCmdlet.ShouldProcess("$TaskPrefix $($job[0])", 'Register current-user task')) {
        $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $job[1] -WorkingDirectory $RepoDir
        Register-ScheduledTask -TaskName "$TaskPrefix $($job[0])" -Action $action -Trigger $job[2] -Principal $principal -Settings $settings -Force | Out-Null
    }
}
