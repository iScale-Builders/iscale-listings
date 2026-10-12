# USPTO Source Module

USPTO is the likely first source for open-source users because the repo already
has import and sync scripts around the USPTO trademark data pipeline.

## User-Owned Requirements

The user needs:

- their own database;
- their own USPTO Open Data Portal API key or other official USPTO data access;
- enough local disk/time for bulk or backfill imports;
- a recurring sync plan if they want freshness monitoring.

Do not ship USPTO keys or database rows.

## Agent Bootstrap Flow

1. Confirm the database is schema-ready.
2. Confirm `USPTO_API_KEY` and `TM_DB_URL` are present in the user's environment.
3. Run a small source/file discovery smoke test.
4. Choose initial import strategy:
   - bulk historical import for a blank database;
   - daily/backfill direct import for a catch-up window;
   - hosted/imported delivery if the user has already staged source files.
5. Run the import.
6. Record sync metadata.
7. Run readiness/health checks.
8. Add recurring sync only after a manual run succeeds.

## Current Repo Commands To Evaluate

```bash
python scripts/load_uspto.py
python scripts/backfill_direct.py <from-date> <to-date> --record-sync-metadata
python scripts/sync_daily_delta.py
curl http://localhost:3000/api/v1/health   # US row should be fresh
```

For large imports, prefer direct Postgres paths over REST/PostgREST writes to
avoid statement timeouts.

## Mark Drawing Coverage

The bulk importer follows the current USPTO drawing-code definitions:

| Code | USPTO drawing type | Text-screening behavior |
|---|---|---|
| 1 | Typeset wording (pre-November 2003) | Include |
| 2 | Design only | Exclude |
| 3 | Wording plus design | Include literal wording |
| 4 | Standard characters | Include |
| 5 | Stylized letters and/or numbers | Include literal wording |
| 6 | Non-visual mark | Exclude |

Initial and historical imports must therefore retain codes 1, 3, 4, and 5.
Apply `008_include_uspto_literal_special_form_marks.sql` to align both matching
RPCs, then apply migration 009 to remove the obsolete two-argument RPC overload.
Existing databases built with the old mapping require a historical
reconciliation before claiming complete coverage. The
mapping is based on [USPTO TMEP 807.18](https://tmep.uspto.gov/RDMS/TMEP/print?href=TMEP-800d1e1.html&version=current)
and the [Trademark Search field definitions](https://tmsearch.uspto.gov/?page=help).

The reconciliation is intentionally staged and resumable:

```bash
python scripts/stage_uspto_drawing_reconciliation.py stage \
  --state-db /safe/path/uspto-drawing-stage.sqlite3 \
  --work-dir /safe/path/uspto-downloads
python scripts/apply_uspto_drawing_reconciliation.py backup \
  --state-db /safe/path/uspto-drawing-stage.sqlite3 \
  --backup-db /safe/path/uspto-drawing-backup.sqlite3
```

The first command streams the latest annual snapshot and chronological daily
deltas into a local SQLite stage without touching production. The second
exports every production row and function definition needed for rollback.
`apply`, `cutover`, and `rollback` remain fail-closed unless the operator adds
both `--execute` and the exact printed confirmation phrase.

## Freshness Principle

Do not treat row count alone as freshness. A successful import should also
write completed sync metadata with the source/date context the health endpoint
expects.

## Agent Warnings

- Do not print API keys.
- Do not commit downloaded bulk files.
- Do not assume production freshness applies to the user's database.
- Verify current USPTO data terms and source URLs from official USPTO docs.


See [official government data terms](../data-terms.md): government data is not MIT-licensed.
