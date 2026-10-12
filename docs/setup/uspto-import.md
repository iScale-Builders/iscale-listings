# United States: first import

This loads every registered and pending US mark into your database once. After this,
the daily update only adds what changed.

## Before you start

- Python 3.11+ and: `python -m pip install -r scripts/requirements.txt`
- `USPTO_API_KEY` and `TM_DB_URL` set in `.env.local` (load them into your shell, or
  prefix each command, e.g. PowerShell: `$env:TM_DB_URL = "…"` — don't echo them).
- Missing USPTO key? Follow [uspto.md](uspto.md) first; do not attempt import to
  obtain account approval. For exact official annual-date discovery and OS-specific
  catch-up commands, follow [local-walkthrough.md](local-walkthrough.md), step 3.
- **Disk:** run `python scripts/download_uspto.py --manifest-only` first for the current compressed byte count (no files downloaded). Budget that ZIP size **plus** expanded XML, database/index growth and import/backup scratch space. A fixed 20 GB is insufficient; measure a representative extraction and reserve generous headroom for your chosen source set; even a 100 GB planning estimate is not a guarantee. Download to a folder
  **outside this repo** with plenty of space.
- **Time:** the load takes several hours. Run it on a computer that won't sleep.

For PowerShell, load the private environment with `. ./scripts/load-env.ps1` (prints no values). `TM_DB_URL` is read by the loader; do not pass connection passwords or keys in command arguments.

## Steps

```bash
# 1. Download the annual USPTO file set (TRTYRAP) — resumable with --start-from N
python scripts/download_uspto.py --output-dir /path/outside/repo/uspto

# 2. Load it into your database (direct Postgres connection = fastest)
python scripts/load_uspto.py /path/outside/repo/uspto/xml

# 3. Catch up from the annual file's date to today with the daily files
python scripts/backfill_direct.py <annual-file-date YYYY-MM-DD> <today YYYY-MM-DD> --record-sync-metadata
```

The loader refuses to finish if the live-mark count looks wrong, and the daily sync
aborts on a >10% drop — both protect you from a silently broken database.

## Check it

```bash
iscale setup                      # "uspto-data" should be done and fresh
iscale check "just do it" --class 025
```

Next: `iscale setup guide euipo` (EU), or skip to `iscale setup guide schedule` if you
only sell in the US. Note: the extension and CLI require **both** US and EU coverage
before they will call anything "clear"; with US only, results stay UNVERIFIED.
