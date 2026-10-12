# Native PostgreSQL on Windows (without Docker)

The API supports `DATABASE_URL` through its native PostgreSQL adapter. This is a
separate route from local Supabase/Docker. Release acceptance for a clean PostgreSQL
17 installation is pending: do not infer it from an existing database or a mock.

Use a PostgreSQL 17 installation with `psql`, `createuser`, `createdb`, `pg_dump` and
`pg_restore`. Add its `bin` folder to this shell's PATH. Python 3.11+ and Node 20.9+
are required; `python -m pip install -r scripts/requirements.txt` installs the importer
dependencies. Keep data on a local disk outside this repository and synchronized folders.

`iscale setup database postgres` selects this guide. It records the choice only; schema, data, private auth and clean-install acceptance remain separate.

1. As your own PostgreSQL administrator, create a login with an interactive password
   prompt and a separate empty database owned by it:

   ```powershell
   createuser -U postgres --login --pwprompt iscale_owner
   createdb -U postgres -O iscale_owner iscale_trademarks
   ```

2. Save your own connection privately in `.env.local` as `DATABASE_URL` and
   `TM_DB_URL` (same database, URL-encode special password characters). Do not put it
   in a command argument or chat. Also set `ENABLE_MULTI_JURISDICTION_DB=true` and
   `REQUIRE_API_KEY=true`. Dot-source `. ./scripts/load-env.ps1` in PowerShell.
3. `python scripts/bootstrap_postgres.py --apply` applies all checked-in migrations
   in one transaction, including `pg_trgm`, tables, RLS and matching functions. It
   refuses a system database or existing user tables/views/sequences/functions/types/schemas (only existing pg_trgm-owned objects are allowed) and rolls back on failure. It creates no
   roles and imports no data. The API's database owner bypasses RLS on its own
   tables; do not substitute an unprivileged role without separately reviewed grants.
   Supabase auth schemas/roles are not fabricated for this route.
4. Follow [private API authentication](api-auth.md), the US/EU import guides, and
   [acceptance](acceptance.md). Do not mark native setup accepted until real private
   health/check requests and the matching functions have passed on the clean database.
5. Use [backup and restore](backups.md). To automate on Windows, the existing
   `scripts/selfhost-windows/Invoke-TrademarkUpdate.ps1` accepts explicit `RepoDir`,
   `EnvFile`, `PythonExe`, `PgBin`, `WorkDir`, `EuipoEveryDays`, `BackupTarget` and
   `SshConfig`. WorkDir must be outside the repo. A failed import makes no new backup;
   archive TOC and copied size are checked before retention. This script does not
   scan your shop; schedule the local scanner separately after successful updates.

**Migration upgrades:** bootstrap is for an empty database only. Back up first and
apply only new reviewed migrations to an existing database; never use `db reset`
or bootstrap to upgrade a live mirror. A restore target must be a different scratch
database, never your live database.
