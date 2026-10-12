// `iscale helper --install | --uninstall | --status`: start the helper hidden in
// the background every time you log in, so nobody has to keep a terminal open.
//   Windows: a per-user Task Scheduler task (at logon, runs hidden through
//            wscript + a tiny VBS so no console window ever flashes).
//   macOS:   a LaunchAgent in ~/Library/LaunchAgents (RunAtLoad + KeepAlive).
//   Linux:   a systemd --user service.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repoRoot } from './core-loader.mjs';
import { iscaleHome } from './settings-store.mjs';

export const TASK_NAME = 'iScale Listings Helper';
const LABEL = 'com.iscale-listings.helper';
const cliPath = path.join(repoRoot, 'cli', 'iscale.mjs');

function ps(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

function windowsVbs() {
  const file = path.join(iscaleHome(), 'start-helper.vbs');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const q = (s) => `""${s}""`;
  // Window style 0 = hidden; False = don't wait (the helper keeps running).
  fs.writeFileSync(
    file,
    `CreateObject("WScript.Shell").Run "${q(process.execPath)} ${q(cliPath)} helper", 0, False\r\n`
  );
  return file;
}

export function installAutostart() {
  if (process.platform === 'win32') {
    const vbs = windowsVbs();
    ps(
      [
        `$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ${psq(`"${vbs}"`)} -WorkingDirectory ${psq(repoRoot)}`,
        `$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME`,
        `$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited`,
        `$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew`,
        `Register-ScheduledTask -TaskName ${psq(TASK_NAME)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null`,
        `Start-ScheduledTask -TaskName ${psq(TASK_NAME)}`,
      ].join('; ')
    );
    return `Installed: "${TASK_NAME}" starts the helper hidden at every login (and was started now).`;
  }
  if (process.platform === 'darwin') {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    const log = path.join(iscaleHome(), 'helper.log');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${cliPath}</string><string>helper</string></array>
  <key>WorkingDirectory</key><string>${repoRoot}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
`
    );
    try {
      execFileSync('launchctl', ['unload', plist], { stdio: 'ignore' });
    } catch {
      /* not loaded yet */
    }
    execFileSync('launchctl', ['load', plist]);
    return `Installed: ${plist} starts the helper at every login (and was started now).`;
  }
  const unit = path.join(os.homedir(), '.config', 'systemd', 'user', 'iscale-helper.service');
  fs.mkdirSync(path.dirname(unit), { recursive: true });
  fs.writeFileSync(
    unit,
    `[Unit]\nDescription=iScale Listings helper\n\n[Service]\nExecStart=${process.execPath} ${cliPath} helper\nWorkingDirectory=${repoRoot}\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`
  );
  execFileSync('systemctl', ['--user', 'daemon-reload']);
  execFileSync('systemctl', ['--user', 'enable', '--now', 'iscale-helper.service']);
  return `Installed: systemd user service iscale-helper (enabled and started).`;
}

export function uninstallAutostart() {
  if (process.platform === 'win32') {
    ps(`if (Get-ScheduledTask -TaskName ${psq(TASK_NAME)} -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName ${psq(TASK_NAME)} -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName ${psq(TASK_NAME)} -Confirm:$false }`);
    fs.rmSync(path.join(iscaleHome(), 'start-helper.vbs'), { force: true });
    return `Removed the "${TASK_NAME}" login task. (A helper already running keeps running until you log out or stop it.)`;
  }
  if (process.platform === 'darwin') {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
    try {
      execFileSync('launchctl', ['unload', plist], { stdio: 'ignore' });
    } catch {
      /* not loaded */
    }
    fs.rmSync(plist, { force: true });
    return 'Removed the login item and stopped the helper.';
  }
  try {
    execFileSync('systemctl', ['--user', 'disable', '--now', 'iscale-helper.service'], { stdio: 'ignore' });
  } catch {
    /* not installed */
  }
  fs.rmSync(path.join(os.homedir(), '.config', 'systemd', 'user', 'iscale-helper.service'), { force: true });
  return 'Removed the systemd user service.';
}

export function autostartInstalled() {
  if (process.platform === 'win32') {
    return ps(`[bool](Get-ScheduledTask -TaskName ${psq(TASK_NAME)} -ErrorAction SilentlyContinue)`) === 'True';
  }
  if (process.platform === 'darwin') return fs.existsSync(path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`));
  return fs.existsSync(path.join(os.homedir(), '.config', 'systemd', 'user', 'iscale-helper.service'));
}
