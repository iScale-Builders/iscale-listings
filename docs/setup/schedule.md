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
but does not scan a shop or prove offsite/restore coverage.
