# Database: your own Supabase project

Your trademark database lives in **your** Supabase account. Nobody else can see it,
and nothing is hosted for you by the iScale project.

## What it costs / needs

- The US register alone is several million rows (roughly 3–5 GB with indexes);
  EU marks add more. **The Supabase free plan (500 MB) is too small** — you need a
  paid plan with enough disk (Supabase Pro at the time of writing). Check current
  pricing on supabase.com before you start.
- About 10 minutes to create the project, then the data import (see the USPTO guide).

## Steps

1. Create a project at <https://supabase.com/dashboard> (pick a region near you and
   save the database password somewhere safe — a password manager, not a text file in
   this repo).
2. Copy three values into `.env.local` at the repo root (copy `.env.local.example`
   first if the file doesn't exist). **Never paste these into a chat.**

   | `.env.local` name | Where to find it |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | Project Settings → API → Project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API → `service_role` secret |
   | `TM_DB_URL` | Connect → Session pooler connection string (with your password) |

   Also set `ENABLE_MULTI_JURISDICTION_DB=true` (needed for EU marks).
3. Apply the database schema:

   ```bash
   npx supabase login
   npx supabase link --project-ref <the id in your project URL>
   npx supabase db push
   ```

4. Start your trademark API (the extension and the CLI talk to it):

   ```bash
   npm run build
   npm start          # http://localhost:3000
   ```

5. Record the choice and check progress:

   ```bash
   iscale setup database supabase
   iscale setup
   ```

Next: `iscale setup guide uspto`.
