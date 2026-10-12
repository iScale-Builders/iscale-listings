# Local own-PC walkthrough: hand this to Claude or Codex

Follow this order on Windows or macOS. The repository already provides schema,
importers, API, helper, scanner and scheduler/backup scripts. The agent configures
them and runs their commands; it does not write an importer or invent SQL.
`iscale setup` reports progress, not a one-command installer. Current full setup
requires fresh US **and** EUIPO; narrower extension queries do not waive that gate.
No cold install/full import/natural schedule/full restore is proved by this guide.

## 1. Prerequisites and accounts

Complete [prerequisites.md](prerequisites.md), including Node, Python, Git, Chrome,
optional Docker, clone, `npm ci` and the private venv. Commands below run from repo
root with that venv activated (Windows can substitute its absolute Python path).

```bash
iscale setup guide local-walkthrough
iscale setup profile --name "YOUR NAME" --email "YOUR EMAIL" --country "YOUR COUNTRY" --subscriber-type "natural person"
iscale setup workflow cli
```

Profile placeholders are personal details, not credentials. The person opens
[USPTO ODP](https://data.uspto.gov), creates/signs into their USPTO account,
completes its current identity/MFA/profile flow and creates their API key. See
[uspto.md](uspto.md). The person also registers an EUIPO account, creates/subscribes
an app first in [EUIPO Sandbox](https://dev-sandbox.euipo.europa.eu), and follows
[euipo.md](euipo.md)'s read-only integration probe and production application.

```bash
iscale setup access uspto account_created
iscale setup access euipo account_created
iscale setup letters euipo
```

The person attaches the required identity/company documents and sends the draft
(or explicitly authorizes sending); the agent must not send merely because a
mailbox is connected. Record `iscale setup access euipo requested`, then
`iscale setup access euipo waiting_reply`. Approval can take time: continue local
database/US work while waiting, but do not run a production EU import or claim
US+EU completion. `iscale setup letters euipo --followup` drafts a follow-up.
Secrets go privately into `.env.local`, never chat or command-line arguments.

## 2. Database and private environment

Choose exactly one route; each supplies all schema/migrations:

- **Docker on either OS:** [database-local.md](database-local.md):
  `npx supabase@2.104.0 start`, then fresh-target-only
  `npx supabase@2.104.0 db reset`; save its printed URL/service-role/DB values
  privately; `iscale setup database local`.
- **Native PG17 on either OS:** [database-postgres.md](database-postgres.md): exact
  OS installer/service/role/database commands, private `DATABASE_URL` and
  `TM_DB_URL`, then `python scripts/bootstrap_postgres.py --apply`;
  `iscale setup database postgres`. Clean-install acceptance remains pending.

Copy the example first (`Copy-Item .env.local.example .env.local` on Windows;
`cp .env.local.example .env.local` on macOS). Replace placeholders privately.
Use `ENABLE_MULTI_JURISDICTION_DB=true` and `REQUIRE_API_KEY=true`. The API and
importers must point to the same database. Native API uses `DATABASE_URL`; the
importers use `TM_DB_URL`; Docker API uses its Supabase URL/service-role values.

Load importer environment before Python commands, on **both** database routes:

```powershell
. ./scripts/load-env.ps1
```

macOS bash/zsh, only for your own trusted shell-compatible `KEY=VALUE` file:

```bash
set -a; source .env.local; set +a
```

Quote shell-special characters. `source` executes shell content; never source an
untrusted downloaded file. The API and Node key registration load `.env.local`
themselves; Python imports need the process environment above.

## 3. USPTO annual download, load and daily catch-up

With your private `USPTO_API_KEY` saved/loaded:

```bash
iscale setup access uspto credentials_saved
python scripts/download_uspto.py --manifest-only
```

This existing manifest command contacts official ODP and prints current file count
and ZIP bytes without downloading. Plan ZIPs **plus** expanded XML, database/indexes
and backups, not a fixed 10/20 GB budget. ~176 files/~21 GB is a historical estimate.

**Find the catch-up start date before downloading:** in the signed-in ODP portal,
open Bulk Data → search product **TRTYRAP** (Trademark Annual XML) → product
description/download file metadata. Record the official **data/snapshot coverage
date** for the annual files you will load, not their download/upload time. For
mixed snapshots use the earliest coverage date. If the portal only exposes release
dates and does not establish coverage, ask ODP support from that product page;
pause the catch-up date choice rather than guessing or using today's date. This
is a source-documentation/human lookup, not code generation. Keep its receipt
privately with the import evidence; the manifest count alone does not supply it.

Windows (choose an adequately sized local directory):

```powershell
python scripts/download_uspto.py --output-dir "$HOME\iscale-data\uspto"
python scripts/load_uspto.py "$HOME\iscale-data\uspto\xml"
$annualCoverageDate = Read-Host 'Confirmed official annual coverage date YYYY-MM-DD'
$catchupToday = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')
python scripts/backfill_direct.py $annualCoverageDate $catchupToday --record-sync-metadata
```

macOS:

```bash
python scripts/download_uspto.py --output-dir "$HOME/iscale-data/uspto"
python scripts/load_uspto.py "$HOME/iscale-data/uspto/xml"
read -r annualCoverageDate
python scripts/backfill_direct.py "$annualCoverageDate" "$(date -u +%Y-%m-%d)" --record-sync-metadata
```

Enter the confirmed official coverage date at `read`; do not fabricate it. Require
each exit 0. Downloads/extractions fail nonzero. Loader refuses a completed
baseline after any errors or below 3M US-only LIVE rows (including zero); US keeps
every class. Catch-up fails closed on errors/data cliffs. Neither count guard is
proof every source file was present; retain manifest/import receipts. See
[uspto-import.md](uspto-import.md) for resume and post-import maintenance.

## 4. EUIPO production approval and seven-class import

After production subscription approval, save production `EUIPO_CLIENT_ID` and
`EUIPO_CLIENT_SECRET` privately. Remove Sandbox `EUIPO_API_BASE`/`EUIPO_AUTH_URL`
overrides from file **and process**, then reload your private production env.
See [euipo.md](euipo.md) for exact override removal and Sandbox probe commands.

```bash
iscale setup access euipo approved
iscale setup access euipo credentials_saved
python scripts/import_euipo.py --since 2026-01-01 --classes 25 --page-limit 1 --dry-run
```

The one-page probe contacts EUIPO and writes no database data. Establish the
official source/update date from the approved API/product's official response,
export or catalogue metadata; local import time alone is not independent source
freshness proof. Replace `SOURCE_DATE` below with that documented date, not an
invented date (one line works in PowerShell/bash):

```bash
python scripts/import_euipo.py --since 1996-01-01 --classes 9,16,18,20,21,24,25 --partition-statuses --batch-size 100 --source-updated-at SOURCE_DATE
```

Require exit 0. These are EU classes 9,16,18,20,21,24,25; US was not filtered to them.
~13.7M is a dated observed row count, not a guaranteed unique-mark install size.
See [euipo-import.md](euipo-import.md) for retry/resume and freshness limits.

## 5. Private API key, build and local server

Register the key **after schema exists and before the private API build/start**:

```bash
node --env-file=.env.local scripts/create-local-api-key.mjs
npm run build
npm start
```

The key remains machine-local; its hash is stored in your database. Configure your
own allowed browser/extension origins per [api-auth.md](api-auth.md). Keep the
server terminal open until its scheduler restart job is installed. In another
terminal, same OS user/repo, use the machine key automatically:

```bash
iscale setup health --api http://localhost:3000 --json
iscale check "example phrase" --api http://localhost:3000 --json
```

Health requires actual authenticated v1/connected/fresh US+EU evidence. Exit 3
means unverified; 401/404/empty/stale is not completion. A risk result is useful
screening, not legal clearance.

## 6. Extension, CLI and helper

```bash
npm run build:extension
iscale helper --trust YOUR_UNPACKED_EXTENSION_ID
iscale helper --install
```

The person opens `chrome://extensions`, enables Developer mode, loads
`extension/dist`, copies their own unpacked extension ID for the trust command,
and sets panel Trademark API URL `http://localhost:3000`. The helper's loopback
18799 is the key/AI bridge, not the API's port 3000. CLI agents need no helper/model
subscription to write listings; they use `iscale listing generate IMAGE --agent`.
Extension subscription AI additionally uses `npx codex login` (person signs in);
OpenAI-key writing uses the person's private key in Chrome. See
[extension.md](extension.md) for settings/registry controls and real browser proof.

## 7. Register scheduled updates/API/backup jobs

Follow the exact registration commands in [schedule.md](schedule.md): Windows
`scripts/selfhost-windows/Register-LocalLifecycle.ps1` or macOS
`python scripts/register_macos.py` (generate/review, then `--install`). Supply
absolute Python/Node/PG/env paths and a local-drive or SSH backup target. Daily US,
weekly EU, authenticated health, dump/TOC/copy/hash/retention, then shop scan are
already coded. Both OS jobs run while that same user is signed in; prevent sleep.
Work defaults outside the repo; seven verified target copies are retained. A
failed stage exits nonzero/skips later stages. US downtime beyond seven days
needs explicit catch-up. Inspect a natural scheduler event plus private logs,
not merely registration or a manual run.

Choose a future first trigger when registering/reviewing jobs. Shop scans operate
on the same OS user's imported local store; an empty store is not a proven shop
protection run. Complete recovery review below and section 9's CSV import before
claiming the first natural update-and-shop-scan acceptance. If a task runs before
then, keep its receipt as an empty-store run and later prove a fresh populated run.

## 8. Separate recovery acceptance

Follow [backups.md](backups.md)'s exact `pg_dump`, `pg_restore --list`, copy/hash
and **different scratch database** `createdb`/`pg_restore` commands. A TOC/hash
does not prove full restoration; actually restore and compare schema/counts/freshness/
lookups. A local-drive copy is not offsite. Finish [acceptance.md](acceptance.md),
then `iscale setup review schedule|extension|backup|restore PRIVATE_EVIDENCE_FILE`
for each reviewed topic; recorded review remains manual, not independent proof.
Keep government data subject to [office terms](../open-source/data-terms.md),
separate from MIT. All trademark checks remain risk screening, not legal advice.

## 9. Etsy/Merch import, scan and natural-run proof

The Etsy person downloads their shop listing CSV from Etsy's listing export UI.
Import it with `iscale listings import PATH_TO_ETSY_CSV`. For Amazon Merch:

```bash
iscale merch login
iscale merch export
iscale listings import PATH_TO_EXPORTED_MERCH_CATALOG_CSV
iscale listings scan --include-description --json
```

The person signs into the isolated Merch browser profile. Use the actual CSV path
printed by export; no AI-built scraper. See [listings.md](listings.md) and
[merch-catalog.md](merch-catalog.md). Require complete coverage; review risk alerts.
Import the same user's store before claiming a populated scheduled scan.

Once the store is populated, observe the next **natural** scheduled refresh,
verified backup and shop scan. Match task/LaunchAgent run time and exit to private
logs. A manual scan/import or task registration alone is not unattended proof.
