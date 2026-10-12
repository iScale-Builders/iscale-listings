# European Union: first import

Loads EU trade marks for the product classes print-on-demand sellers use
(9 phone cases, 16 paper and stickers, 18 bags, 20 home decor, 21 drinkware, 24 textiles,
25 apparel).

## Before you start

- `python -m pip install -r scripts/requirements.txt`
- In `.env.local`: `EUIPO_CLIENT_ID`, `EUIPO_CLIENT_SECRET`,
  `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and
  `ENABLE_MULTI_JURISDICTION_DB=true` (restart `npm start` after changing it).

## Steps

```bash
# 1. Prove the credentials work (small, writes nothing)
python scripts/import_euipo.py --since 2026-01-01 --classes 25 --page-limit 1 --dry-run

# 2. Full import (long; resumable — the script prints a --start-page hint if interrupted)
python scripts/import_euipo.py --since 1996-01-01 --classes 9,16,18,20,21,24,25 \
  --partition-statuses --batch-size 100 --source-updated-at <today YYYY-MM-DD>
```

## Check it

```bash
iscale setup                      # "euipo-data" should be done and fresh
iscale check "just do it" --class 025   # now CLEAR / RISK instead of UNVERIFIED
```

Next: `iscale setup guide schedule`.
