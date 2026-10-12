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
`sha256sum <file>` on Linux) and compare them after copying. TOC/size/hash are archive
and transport checks; they do not establish restore success.

## Retention

Keep several dated last-known-good dumps (for example seven daily copies). Rotate
only after a newly completed dump has passed TOC and copy/hash verification. A
failed update or backup must retain the prior good copy. Restore an older copy if a
new source import is discovered to be bad. Inspect your provider's own retention,
encryption and credential recovery procedure; a configured job is not an offsite proof.

## Scratch restore drill

Create a **separate**, clearly named scratch database owned by your test role. Confirm
its host/port/database are not the live target before running anything. Do not use
`--clean` against a live database. Use the private environment, never a password in argv.

```bash
createdb --owner=your_test_role iscale_restore_scratch
pg_restore --no-owner --dbname=iscale_restore_scratch /private/backups/trademarks-current.dump
```

Require exit 0. Compare US/EU total/live counts, sync timestamps, schema/matching
functions and known lookups with the source snapshot. Record start/end time, target
identity, counts and lookup results privately. Only an actual successful restore
proves this archive's restorability; synthetic fixture drills do not prove a full
production dataset or a clean-computer rebuild time. Dispose of scratch only after
verifying its exact owned identity. Never restore over production.

Keep a private recovery note covering tool versions, environment/key recovery,
backup locations and the last successful drill. `iscale setup` leaves backup/restore
pending until you review this external evidence; it never marks a TOC as a restore.
