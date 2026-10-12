# Scheduling: data refresh and local shop screening

US refresh runs daily; EU runs weekly with an overlapping eight-day window. A
missed window still requires inspection and a successful catch-up, not a green claim.

## Hosted database / GitHub Actions

The daily-sync and euipo-refresh workflows update **your fork's database** using
its own secrets. They do not have your local `~/.iscale-listings/listings.json` and
do not recheck your shop. Configure your own USPTO/EUIPO/Supabase/DB secrets, enable
Actions, and inspect each natural run's completion and imported counts. GitHub
cannot reach a loopback database on your computer. Workflow schedules are UTC.

After a successful hosted refresh, run a local job:

```bash
iscale setup health --json
iscale listings scan --include-description --json --out /private/reports/shop-risk-report.json
```

Do not scan if the health/coverage gate exits 3. Ensure the scanner's machine/user
has the same private API key and listing store you imported.

## Local refresh and scan

`scripts/refresh-and-scan.ps1` (Windows) or `scripts/refresh-and-scan.sh` (macOS/Linux)
load your private `.env.local`, run US updates daily and EU updates on Mondays (or
with `-Euipo` / `--euipo`), then verify fresh authenticated coverage before scanning
including descriptions. An update/health failure skips scanning and preserves a
nonzero exit code. Exit 2 after a scan means new risk alerts, not an upload approval.

For Windows Task Scheduler choose your own user, daily trigger, `powershell.exe`,
arguments `-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "<repo>\scripts\refresh-and-scan.ps1"`,
and Start in `<repo>`. Use absolute paths and the same account/home as your imports.
Do not save credentials in task arguments. Verify Python/Node on that task's PATH,
prevent sleep during imports, and choose a bounded execution time suitable for your
source set. For cron use an absolute repo/script path and a private log outside Git.

The wrapper writes `~/.iscale-listings/refresh-and-scan-last.json`: exact stage exit
codes, completion/failure and time; `trigger` remains `not verified`. A manual run
proves the pipeline only. Compare a fresh receipt with a **natural** scheduler event,
last/next run and exit result to prove unattended execution. Missing/older-than-30h
receipts or failed stages require action. Keep dated logs; never replace a failure
with a successful manual receipt and claim the original schedule worked.

`iscale setup scheduled` records **reported configuration** only and intentionally
does not clear the scheduler evidence gate. Use [acceptance](acceptance.md).

## Failures and backups

Fix 401/key configuration, empty/stale registries, interrupted imports or missing
executables before retrying. Retain the original failure and inspect partial effects;
run one bounded catch-up with the same source window, then verify health and recheck.
Refresh wrappers are not backups: follow [backups](backups.md). Native Windows
`Invoke-TrademarkUpdate.ps1` can make a validated dump after successful refresh,
and now gates shop scanning after validated backup; this does not prove offsite/restore coverage.

## Register the complete own-PC lifecycle (Windows)

Finish initial US/EU imports and build first. Keep the private env outside Git.
The following single-line command works in PowerShell; substitute your paths:

```powershell
./scripts/selfhost-windows/Register-LocalLifecycle.ps1 -RepoDir 'C:\apps\iscale-listings' -EnvFile 'C:\secure\update.env' -PythonExe 'C:\apps\venv\Scripts\python.exe' -BackupTarget 'E:\trademark-backups' -PgBin 'C:\Program Files\PostgreSQL\17\bin'
```

Use `-WhatIf` to review task registration without installing it. No password is
stored in task arguments. The script creates current-user daily Update (08:30) and
five-minute API keeper tasks. **This user must be signed in**; it does not claim
logged-out unattended execution. The updater discovers Node at registration and
records its absolute path. PostgreSQL's Windows service starts independently.
Prevent sleep during imports. `WorkDir` defaults to
`$HOME\.iscale-listings\maintenance`, outside the repo. Set it explicitly to another
private local directory if desired. API defaults `127.0.0.1:3000`; see extension.md.
`BackupTarget` may instead be `backup-host:/private/trademark-backups`, with existing
SSH auth and Unix remote `sha256sum` tools. Local-drive backup needs no SSH.

Pipeline: daily US overlapping seven-day import; EU weekly overlapping eight-day
import; fresh authenticated health; validated backup/copy/hash/retention; then
shop scan. Import/health/backup failure skips scan. Scan failure retains the newly
verified backup and exits nonzero. Exit 2 means risk alerts, not failed import.
For downtime exceeding the US seven-day window, run `backfill_direct.py` manually
from the last confirmed imported day before restarting the job.

Inspect real task runs (commands do not run an import):

```powershell
Get-ScheduledTask -TaskName 'iScale Listings *'
Get-ScheduledTaskInfo -TaskName 'iScale Listings Update'
```

## Register the complete own-PC lifecycle (macOS)

Use absolute paths from `command -v python3`, `command -v node`, and
`brew --prefix postgresql@17` (or Postgres.app's PG17 bin). From repo root:

```bash
python3 scripts/register_macos.py --python /opt/homebrew/bin/python3 --node /opt/homebrew/bin/node --env-file "$HOME/.iscale-listings/update.env" --backup-target /Volumes/Backup/trademarks --pg-bin /opt/homebrew/opt/postgresql@17/bin
```

This generates inspectable `~/Library/LaunchAgents/com.iscale-listings.*.plist`
files only. Add `--install` after reviewing them to `launchctl bootstrap` both.
To regenerate an installed job, first `launchctl bootout gui/$(id -u)/com.iscale-listings.api`
and `launchctl bootout gui/$(id -u)/com.iscale-listings.update`, then generate/install.
Agents run while that same user is signed in. API restarts with KeepAlive; the daily
08:30 update uses the same success gates and seven-copy backup retention as Windows.
The API reads repo `.env.local`; the updater reads the specified env file, which
must point at that same database/API/key. Ensure Node/Python/PG tools exist at the
specified paths and the backup volume is mounted. A missed wake/run is not proof
of freshness; inspect receipts and catch up source windows.

```bash
launchctl print gui/$(id -u)/com.iscale-listings.api
launchctl print gui/$(id -u)/com.iscale-listings.update
```

Private logs and Python `last-success.json` are under
`~/.iscale-listings/maintenance`. A receipt says `trigger: not verified`; pair it
with a natural scheduler event. Run no full import just to test registration.
TOC/hash prove archive/transport only; use backups.md for a separate restore drill.
