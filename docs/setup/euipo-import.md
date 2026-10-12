# European Union: first import

Loads EU trade marks for the product classes print-on-demand sellers use
(9 phone cases, 16 paper and stickers, 18 bags, 20 home decor, 21 drinkware, 24 textiles,
25 apparel).

## Before you start

- `python -m pip install -r scripts/requirements.txt`
- In private `.env.local`: `EUIPO_CLIENT_ID`, `EUIPO_CLIENT_SECRET`, and
  `ENABLE_MULTI_JURISDICTION_DB=true` (restart the API after changing it).
- Native PostgreSQL: `TM_DB_URL` (same DB as API `DATABASE_URL`); no Supabase
  URL/service-role key is needed. Supabase REST fallback: `NEXT_PUBLIC_SUPABASE_URL`
  plus `SUPABASE_SERVICE_ROLE_KEY`. Direct `TM_DB_URL` is preferred for bulk imports.
- Load the file first: PowerShell `. ./scripts/load-env.ps1`; on macOS use
  `set -a; source .env.local; set +a` only with a trusted shell-compatible env file.

## Steps

```bash
# 1. Prove the credentials work (small, writes nothing)
python scripts/import_euipo.py --since 2026-01-01 --classes 25 --page-limit 1 --dry-run

# 2. Full import (long; resumable — the script prints a --start-page hint if interrupted)
python scripts/import_euipo.py --since 1996-01-01 --classes 9,16,18,20,21,24,25 --partition-statuses --batch-size 100 --source-updated-at 2026-10-12
```

The full-import command is one line and works in PowerShell and bash. Replace
`2026-10-12` with the confirmed official source/update date. A local run date is
not independent proof of official source freshness. Complete initial US and EU
imports before scheduling incremental updates.

## Check it

```bash
iscale setup                      # "euipo-data" should be done and fresh
iscale check "just do it" --class 025   # now CLEAR / RISK instead of UNVERIFIED
```

Next: `iscale setup guide schedule`.
