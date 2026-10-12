# Backups, retention and restore proof

Keep backups outside this repo and outside live database folders. A same-building
NAS is local recovery, not an offsite guarantee. Store at least one protected offsite
copy using your own provider/account; never commit database dumps or credentials.

## Make and verify a dump

Use PostgreSQL 17 tools and set your own PGHOST/PGPORT/PGUSER/PGDATABASE and protected
PGPASSFILE (or process-only PGPASSWORD) privately. Do not put a password/DSN in command
arguments. Pause risky maintenance and verify the last import completed first.

```bash
pg_dump --format=custom --file=/private/backups/trademarks-current.dump
pg_restore --list /private/backups/trademarks-current.dump
```

Require exit 0, nontrivial file size and `TABLE DATA public trademarks` in the TOC.
The dump is the whole combined database, not a US/EU-filtered export. Record exact
bytes and SHA-256 (`Get-FileHash -Algorithm SHA256 -LiteralPath <file>` on Windows,
`shasum -a 256 <file>` on macOS, `sha256sum <file>` on Linux) and compare them after copying. TOC/size/hash are archive
and transport checks; they do not establish restore success.

## Retention

The checked-in `scripts/local_lifecycle.py` and Windows updater automate dumping,
TOC validation, copying to a local directory or SSH target, SHA-256 comparison and
retention of seven target copies by default. See [schedule.md](schedule.md) for
exact configuration. A local-drive target is usable without SSH/cloud. For SSH,
the destination must provide `sha256sum` and standard Unix tools. Pruning starts
only after copy hash verification; a failed update/health/dump/copy/hash exits
nonzero and preserves older target copies. The scan runs after backup/retention:
a failed scan exits nonzero and retains the new verified backup, but older copies
may already have been pruned under retention. A failed retention command is a failed
run, even if the newly verified copy exists. Do not treat a local copy as offsite.

Keep several dated last-known-good dumps (for example seven daily copies). Rotate
only after a newly completed dump has passed TOC and copy/hash verification. A
failed update or backup must retain the prior good copy. Restore an older copy if a
new source import is discovered to be bad. Inspect your provider's own retention,
encryption and credential recovery procedure; a configured job is not an offsite proof.

## Scratch restore drill

Create a **separate**, clearly named scratch database owned by your test role. Confirm
its host/port/database are not the live target before running anything. Do not use
`--clean` against a live database. Use the private environment, never a password in argv.

For a new native scratch restore, create an actual separate owner/database as
your own administrator. Windows PostgreSQL installer administrator:

```powershell
createuser --username=postgres --password --login --pwprompt iscale_restore_owner
createdb --username=postgres --password --owner=iscale_restore_owner iscale_restore_scratch
```

macOS Homebrew administrator (your current OS account):

```bash
createuser --username="$USER" --password --login --pwprompt iscale_restore_owner
createdb --username="$USER" --password --owner=iscale_restore_owner iscale_restore_scratch
```

The person enters the admin/new-role passwords at tool prompts, never in chat or
argv. Homebrew's local admin may not have a password; use its existing local
socket/trust login and omit `--password` for that admin if appropriate. For local
Docker/Supabase use `--username=postgres --host=127.0.0.1 --port=54322` for both
admin commands and enter your stack's own password. The regular API owner lacks
CREATEDB by default; do not run administrator provisioning as that owner.

Keep source private PGHOST/PGPORT/PGPASSFILE unchanged; choose the scratch role/DB
explicitly with these flags (same tools work in PowerShell/bash):

```bash
pg_restore --username=iscale_restore_owner --password --no-owner --dbname=iscale_restore_scratch /private/backups/trademarks-current.dump
```

Supply your actual private dump path and source host/port (Docker port 54322,
native usually 5432). `--password` prompts for the new restore-role password and
does not expose it in arguments. If you prefer a private PGPASSFILE, create its
scratch-role entry yourself and omit `--password`; no AI-generated grants needed.
Always check source versus scratch identities. These flags do not mutate the
source connection environment; restore that environment if you changed it.

Require exit 0. Compare US/EU total/live counts, sync timestamps, schema/matching
functions and known lookups with the source snapshot. Record start/end time, target
identity, counts and lookup results privately. Only an actual successful restore
proves this archive's restorability; synthetic fixture drills do not prove a full
production dataset or a clean-computer rebuild time. Dispose of scratch only after
verifying its exact owned identity. Never restore over production.

### Existing read-only comparison SQL: no AI-written queries

Pause imports while taking the source dump and its evidence. With your private
PGHOST/PGPORT/PGUSER/PGDATABASE/PGPASSFILE set to the **source**, capture:

```bash
psql --no-psqlrc --set ON_ERROR_STOP=1 --tuples-only --no-align --file scripts/restore_evidence.sql --output /private/evidence/source-restore.txt
```

Use your own absolute evidence path (PowerShell accepts `C:\private\evidence\source-restore.txt`).
After the isolated scratch restore, explicitly select that **scratch role/database**,
confirm identity first, then capture with the same SQL:

```bash
psql --username=iscale_restore_owner --password --dbname=iscale_restore_scratch --no-psqlrc --set ON_ERROR_STOP=1 --command "SELECT current_database(), current_user, inet_server_addr(), inet_server_port();"
psql --username=iscale_restore_owner --password --dbname=iscale_restore_scratch --no-psqlrc --set ON_ERROR_STOP=1 --tuples-only --no-align --file scripts/restore_evidence.sql --output /private/evidence/scratch-restore.txt
```

Require exit 0 and compare the files: macOS `diff -u /private/evidence/source-restore.txt /private/evidence/scratch-restore.txt`;
PowerShell `Compare-Object (Get-Content 'C:\private\evidence\source-restore.txt') (Get-Content 'C:\private\evidence\scratch-restore.txt')`
(no difference output expected). The SQL uses a read-only transaction and compares
per-jurisdiction total/live counts, sync dates/counts, public column definitions,
matching-function identity/definition hashes and fixed known phrase lookups.
Function hash equality can require the same PostgreSQL version; explain any
difference instead of declaring success. Empty known lookup arrays on both sides
do not prove positive matching; add an actual known-result API check from the user's
source evidence. This bounded comparison does not prove every row identical.

Keep a private recovery note covering tool versions, environment/key recovery,
backup locations and the last successful drill. `iscale setup` leaves backup/restore
pending until you review this external evidence; it never marks a TOC as a restore.
