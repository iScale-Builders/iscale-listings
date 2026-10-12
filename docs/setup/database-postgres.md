# Native PostgreSQL on Windows or macOS (without Docker)

The API supports `DATABASE_URL` through its native PostgreSQL adapter. This is a
separate route from local Supabase/Docker. Release acceptance for a clean PostgreSQL
17 installation is pending: do not infer it from an existing database or a mock.

Use a PostgreSQL 17 installation with `psql`, `createuser`, `createdb`, `pg_dump` and
`pg_restore`. Add its `bin` folder to this shell's PATH. Python 3.11+ and Node 20.9+
are required; `python -m pip install -r scripts/requirements.txt` installs the importer
dependencies. Keep data on a local disk outside this repository and synchronized folders.
On macOS use `python3` for the guides' `python` commands, or activate your own
virtual environment that supplies `python`; Homebrew may provide only `python3`.

## Install PostgreSQL 17 first

Windows PowerShell (approve the installer UI yourself and save its administrator
password privately):

```powershell
winget install --exact --id PostgreSQL.PostgreSQL.17 --interactive
$env:Path = 'C:\Program Files\PostgreSQL\17\bin;' + $env:Path
Get-Service -Name postgresql-x64-17
Start-Service -Name postgresql-x64-17 # elevated shell if the service is stopped
psql --version
pg_isready -h 127.0.0.1 -p 5432
```

Alternatively download the PG17 installer from [PostgreSQL's Windows page](https://www.postgresql.org/download/windows/).
Choose the server plus command-line tools, port 5432, and a data directory outside
the repo/synced folders. The installer creates the service; do not invent a second
service. PATH above affects this shell only; repeat it in new shells or add that
bin directory to your user PATH through Windows Environment Variables.

macOS Homebrew (Homebrew must already be installed):

```bash
brew install postgresql@17
brew services start postgresql@17
export PATH="$(brew --prefix postgresql@17)/bin:$PATH"
psql --version
pg_isready -h 127.0.0.1 -p 5432
createuser --login --pwprompt iscale_owner
createdb -O iscale_owner iscale_trademarks
```

The Homebrew administrator is normally your macOS user, so omit Windows's
`-U postgres`. Add the PATH export to your own `~/.zprofile`; use absolute paths
in scheduled jobs. PostgreSQL starts at login through `brew services`.
[Postgres.app](https://postgresapp.com/) is an alternative: choose its PG17 server,
initialize it in its UI, enable start at login, and use
`/Applications/Postgres.app/Contents/Versions/17/bin` on PATH. Do not run both
servers on the same port. These are supported prerequisite instructions, **not
clean-install acceptance evidence**.

`iscale setup database postgres` selects this guide. It records the choice only; schema, data, private auth and clean-install acceptance remain separate.

1. Windows only (macOS already created these above): as your own PostgreSQL administrator, create a login with an interactive password
   prompt and a separate empty database owned by it:

   ```powershell
   createuser -U postgres --login --pwprompt iscale_owner
   createdb -U postgres -O iscale_owner iscale_trademarks
   ```

2. Save your own connection privately in `.env.local` as `DATABASE_URL` and
   `TM_DB_URL` (same database, URL-encode special password characters). Do not put it
   in a command argument or chat. Also set `ENABLE_MULTI_JURISDICTION_DB=true` and
   `REQUIRE_API_KEY=true`. Dot-source `. ./scripts/load-env.ps1` in PowerShell.
   In macOS bash/zsh, load your own trusted, shell-compatible `KEY=VALUE` file
   before running Python import/bootstrap commands:

   ```bash
   set -a; source .env.local; set +a
   ```

   Quote values containing shell-special characters in the file. `source` executes
   shell content: use only the private file you created, never an untrusted download.
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
   archive TOC and copied SHA-256 are checked before retention. The updater gates
   the local shop scan on successful refresh and fresh authenticated US+EU coverage.
   Follow [schedule.md](schedule.md) for Windows registration and the Mac equivalent.

**Migration upgrades:** bootstrap is for an empty database only. Back up first and
apply only new reviewed migrations to an existing database; never use `db reset`
or bootstrap to upgrade a live mirror. A restore target must be a different scratch
database, never your live database.

For a reviewed upgrade, select **only** the specific unapplied migration, then
load private PGHOST/PGPORT/PGUSER/PGDATABASE and PGPASSFILE (or process-only
PGPASSWORD). Do not place the password/DSN in argv. Example valid in PowerShell/bash:

```bash
psql --set ON_ERROR_STOP=1 --single-transaction --file supabase/migrations/REVIEWED_NEW_MIGRATION.sql
```

Replace the placeholder with the actual reviewed new file; inspect its transaction
compatibility before running. Require exit 0 and verify functions/API lookups. Do
not blindly replay every migration; the initial native bootstrap creates no upgrade
history. Keep your own applied-migration receipt and verified pre-upgrade backup.
