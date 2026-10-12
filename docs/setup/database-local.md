# Database: local, on this computer

Runs the same database stack (Supabase's open-source Postgres + API) inside Docker
on your own machine. Free, private, and offline-capable — but this computer has to be
on for your data to refresh.

For a native Windows route without Docker, see [database-postgres.md](database-postgres.md). Its clean-install acceptance is tracked separately; do not treat an existing database as proof.

## What it needs

- **Docker Desktop** (<https://www.docker.com/products/docker-desktop/>), running.
- **Disk planning:** current source ZIP bytes + expanded XML + database/indexes + import/backup scratch. Query the live manifest as described in `uspto-import.md`; a fixed 20 GB is insufficient. Measure a representative extraction and plan generous headroom from your selected source set. A 100 GB estimate is only an illustration, not a guarantee: XML expansion can require much more.
- 8 GB RAM or more recommended.

## Steps

1. Start the local stack from the repo root:

   ```bash
   npx supabase start
   ```

   The first start downloads the Docker images (a few minutes). When it finishes it
   prints an **API URL**, a **service_role key** and a **DB URL**.
2. Put them in `.env.local` (copy `.env.local.example` first if needed). **Never paste
   them into a chat.**

   | `.env.local` name | Value printed by `supabase start` |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | API URL (usually `http://127.0.0.1:54321`) |
   | `SUPABASE_SERVICE_ROLE_KEY` | service_role key |
   | `TM_DB_URL` | DB URL (usually `postgresql://postgres:postgres@127.0.0.1:54322/postgres`) |

   Also set `ENABLE_MULTI_JURISDICTION_DB=true`.
3. Apply the schema:

   ```bash
   npx supabase db reset     # creates the tables from supabase/migrations
   ```

4. Start your trademark API:

   ```bash
   npm run build
   npm start          # http://localhost:3000
   ```

5. Record the choice and check progress:

   ```bash
   iscale setup database local
   iscale setup
   ```

**Windows with Docker inside WSL (no Docker Desktop):** the stack runs in the WSL
Ubuntu VM, and `127.0.0.1:54321` / `:54322` may refuse connections from Windows. Use the
VM's address instead (`wsl hostname -I`, first value) in `NEXT_PUBLIC_SUPABASE_URL` and
`TM_DB_URL`. Also keep the VM awake while importing (any running `wsl` command does), or
WSL's idle shutdown stops the database mid-import. Docker Desktop has neither problem.

After a large import, run `VACUUM (ANALYZE) trademarks;` once (the importer reminds you).

`npx supabase stop` stops the stack and keeps the data; start it again with
`npx supabase start`.

Next: `iscale setup guide uspto`.
