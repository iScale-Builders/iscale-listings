"""
Direct-DB USPTO backfill for the 2025-06..present coverage gap.

Why this exists: the REST backfill (backfill_window.py) hit the 8s PostgREST
statement_timeout (57014) on this 10-index table when *updating* existing rows.
This version connects straight to the session pooler (psycopg2, statement_timeout=0),
mirroring scripts/backfill_fast.py, and upserts via execute_values ON CONFLICT
DO UPDATE — no 8s wall.

Regression-safe: processes daily files CHRONOLOGICALLY from the gap start through
TODAY, so the latest transaction per mark wins (a mark that updated after the gap
isn't rolled back to its gap-window state).

Idempotent: ON CONFLICT (jurisdiction, serial_number, international_class) DO UPDATE.

Creds come from env (TM_DB_URL + USPTO_API_KEY) or, if unset, a local vault file:
  - trademark session-pooler URL (postgresql://...)
  - USPTO ODP API key
Point TM_VAULT at the vault file; TM_DB_REF disambiguates if it holds several URLs.

Usage:
    python scripts/backfill_direct.py [FROM_DATE] [TO_DATE]
    python scripts/backfill_direct.py 2026-06-24 2026-06-28 --record-sync-metadata
Defaults: FROM=2025-06-01  TO=<today>
"""

import argparse
import json
import os
import re
import sys
import tempfile
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import psycopg2
from psycopg2.extras import execute_values
from safe_zip import extract_suffixed_members
from sync_daily_delta import (
    API_BASE,
    PRODUCT_ID,
    api_get,
    download_file,
    log,
    process_xml_to_records,
)

VAULT = os.environ.get("TM_VAULT")  # optional path to a file containing the creds
DEFAULT_FROM = "2025-06-01"

UPSERT_COLS = [
    "jurisdiction", "source", "serial_number", "registration_number", "wordmark",
    "wordmark_normalized", "mark_drawing_type", "status", "status_code",
    "filing_date", "registration_date", "owner_name", "international_class",
]
# Columns refreshed on conflict (the conflict key itself is never updated).
UPDATE_COLS = [
    "source", "registration_number", "wordmark", "wordmark_normalized",
    "mark_drawing_type", "status", "status_code", "filing_date",
    "registration_date", "owner_name",
]
DATE_COLS = {"filing_date", "registration_date"}


def read_vault_creds() -> tuple[str, str]:
    """Pull the trademark pooler URL + USPTO API key from env or the vault file."""
    env_dsn = os.environ.get("TM_DB_URL", "").strip()
    env_key = os.environ.get("USPTO_API_KEY", "").strip()
    if env_dsn and env_key:
        return env_dsn, env_key

    if not VAULT:
        raise SystemExit("ERROR: set TM_DB_URL + USPTO_API_KEY, or TM_VAULT to a creds file")
    text = Path(VAULT).read_text(encoding="utf-8", errors="replace")
    # Pick the pooler URL from the vault; TM_DB_REF disambiguates if it holds
    # several (default: first match). No project ref is hardcoded here.
    ref = os.environ.get("TM_DB_REF", "")
    dsn_candidates = [u for u in re.findall(r"postgresql://[^\s`]+", text) if ref in u]
    if not dsn_candidates:
        raise SystemExit("ERROR: trademark pooler URL not found in vault (set TM_DB_URL or TM_DB_REF)")
    if not ref and len(dsn_candidates) > 1:
        raise SystemExit("ERROR: multiple postgresql URLs in vault; set TM_DB_URL or TM_DB_REF")
    # USPTO ODP API key: the `| API Key | \`...\` |` row under the ODP section.
    odp = text.split("USPTO Open Data Portal", 1)
    key_m = re.search(r"API Key\s*\|\s*`([^`]+)`", odp[1]) if len(odp) > 1 else None
    if not key_m:
        raise SystemExit("ERROR: USPTO API key not found in vault")
    return dsn_candidates[0], key_m.group(1)


def clean(rec: dict) -> tuple:
    out = []
    for c in UPSERT_COLS:
        v = rec.get(c)
        if c in DATE_COLS and (not v or str(v).strip() in ("", "0000-00-00", "00000000", "0")):
            v = None
        out.append(v)
    return tuple(out)


def list_files(api_key: str, from_date: str, to_date: str) -> list[dict]:
    url = (f"{API_BASE}/products/{PRODUCT_ID}?includeFiles=true"
           f"&fileDataFromDate={from_date}&fileDataToDate={to_date}")
    data = json.loads(api_get(url, api_key, timeout=120))
    products = data.get("bulkDataProductBag", [])
    files = products[0].get("productFileBag", {}).get("fileDataBag", []) if products else []
    files = [f for f in files
             if str(f.get("fileName", "")).lower().startswith("apc")
             and str(f.get("fileName", "")).lower().endswith(".zip")]
    files.sort(key=lambda f: f.get("fileName", ""))  # chronological
    return files


def connect(dsn: str):
    conn = psycopg2.connect(dsn, connect_timeout=25)
    conn.autocommit = False
    cur = conn.cursor()
    cur.execute("SET statement_timeout=0")
    conn.commit()
    return conn


def upsert(conn, records: list[dict]) -> int:
    """One upsert of a batch. Raises OperationalError on a dropped connection;
    the caller rebuilds the connection and retries."""
    if not records:
        return 0
    rows = [clean(r) for r in records]
    # Only actually write a row when a status-relevant field changed. Unchanged
    # rows are skipped (no UPDATE, no index churn) — turns ~28M no-op upserts into
    # ~190k real writes, slashing runtime, bloat, and lock contention.
    sql = (
        f"INSERT INTO trademarks ({','.join(UPSERT_COLS)}) VALUES %s "
        f"ON CONFLICT (jurisdiction, serial_number, international_class) DO UPDATE SET "
        + ", ".join(f"{c}=EXCLUDED.{c}" for c in UPDATE_COLS)
        + " WHERE trademarks.status IS DISTINCT FROM EXCLUDED.status"
        + " OR trademarks.status_code IS DISTINCT FROM EXCLUDED.status_code"
        + " OR trademarks.registration_number IS DISTINCT FROM EXCLUDED.registration_number"
        + " OR trademarks.registration_date IS DISTINCT FROM EXCLUDED.registration_date"
        + " OR trademarks.wordmark_normalized IS DISTINCT FROM EXCLUDED.wordmark_normalized"
        + " OR trademarks.owner_name IS DISTINCT FROM EXCLUDED.owner_name"
        + " OR trademarks.mark_drawing_type IS DISTINCT FROM EXCLUDED.mark_drawing_type"
    )
    cur = conn.cursor()
    execute_values(cur, sql, rows, page_size=1000)
    conn.commit()
    return len(rows)


def count_live(conn) -> int:
    cur = conn.cursor()
    cur.execute("SELECT count(*) FROM trademarks WHERE jurisdiction='US' AND status='LIVE'")
    return int(cur.fetchone()[0])


def insert_sync_metadata(
    conn,
    sync_date: str,
    live_count: int,
    marks_added: int,
    duration: int,
    note: str,
) -> None:
    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO sync_metadata (
          sync_date, jurisdiction, source, live_mark_count, marks_added,
          marks_updated, marks_status_changed, sync_duration_seconds, status,
          error_message
        ) VALUES (%s, 'US', 'uspto', %s, %s, 0, 0, %s, 'completed', %s)
        """,
        (sync_date, live_count, marks_added, duration, note),
    )
    conn.commit()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Direct-DB USPTO daily-file backfill")
    parser.add_argument("from_date", nargs="?", default=DEFAULT_FROM)
    parser.add_argument("to_date", nargs="?", default=datetime.now(timezone.utc).date().isoformat())
    parser.add_argument(
        "--record-sync-metadata",
        action="store_true",
        help="Insert a completed US sync_metadata row after a fully successful run.",
    )
    parser.add_argument(
        "--skip-imported",
        action="store_true",
        help="Skip daily files already imported cleanly (local list, see imported_state_path()); the daily job uses it.",
    )
    return parser.parse_args()


# USPTO limits how often one daily file can be downloaded: on 2026-10-06 every file the 7-day window had already
# fetched several times answered HTTP 429 for minutes on end, while the new day's file downloaded fine. The daily job
# therefore remembers the files it imported cleanly and only downloads new ones. The list is machine-local runtime
# state, never in the repo or a synchronized folder.
def imported_state_path() -> Path:
    return Path(os.environ.get("TM_IMPORTED_FILES_STATE") or (Path.home() / ".iscale-listings" / "uspto-imported-files.json"))


def load_imported() -> set:
    try:
        # utf-8-sig: a list written by Windows PowerShell 5.1 starts with a BOM.
        return set(json.loads(imported_state_path().read_text(encoding="utf-8-sig")).get("files", []))
    except FileNotFoundError:
        return set()


def save_imported(names: set) -> None:
    path = imported_state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"files": sorted(names), "updated_at": datetime.now(timezone.utc).isoformat()}, indent=1),
                   encoding="utf-8")
    os.replace(tmp, path)


def main() -> int:
    args = parse_args()
    from_date = args.from_date
    to_date = args.to_date

    dsn, api_key = read_vault_creds()
    log("=" * 60)
    log(f"DIRECT BACKFILL  window {from_date} .. {to_date}  (chronological, regression-safe)")
    log("=" * 60)

    files = list_files(api_key, from_date, to_date)
    log(f"Found {len(files)} daily files in window")
    if not files:
        log("Nothing to do.")
        return 0

    conn = connect(dsn)
    start = time.time()
    total = 0
    errors = 0
    skipped_batches = 0
    live_before = count_live(conn)
    imported = load_imported() if args.skip_imported else set()
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        for i, fi in enumerate(files, 1):
            name = fi.get("fileName", "?")
            if name in imported:
                log(f"[{i}/{len(files)}] {name}: already imported, skipped")
                continue
            skipped_before = skipped_batches
            zip_path = download_file(fi, tmp, api_key)
            if not zip_path:
                errors += 1
                continue
            try:
                xmls = [str(p) for p in extract_suffixed_members(Path(zip_path), tmp, ".xml")]
            except zipfile.BadZipFile:
                log(f"  bad zip: {name}")
                errors += 1
                os.remove(str(zip_path))
                continue

            file_rows = 0
            for xp in xmls:
                recs = process_xml_to_records(xp)
                # A mark can appear more than once in a single daily file; ON CONFLICT
                # can't touch the same row twice in one statement. Keep the last
                # occurrence per (jurisdiction, serial_number, international_class).
                _seen: dict = {}
                for r in recs:
                    _seen[(r.get("jurisdiction"), r.get("serial_number"),
                           r.get("international_class"))] = r
                recs = list(_seen.values())
                for j in range(0, len(recs), 2000):
                    batch = recs[j:j + 2000]
                    try:
                        total += upsert(conn, batch)
                    except psycopg2.OperationalError as e:
                        log(f"  reconnect after: {str(e).strip()[:90]}")
                        try:
                            conn.close()
                        except Exception:  # noqa: BLE001, S110
                            pass
                        time.sleep(3)
                        conn = connect(dsn)
                        total += upsert(conn, batch)
                    except psycopg2.Error as e:
                        # Unexpected DB error on this batch: roll back so the
                        # connection stays usable, log loudly, skip, keep going —
                        # one bad batch must not kill a multi-hour run.
                        log(f"  SKIP batch {name}[{j}]: {type(e).__name__}: {str(e).strip()[:120]}")
                        skipped_batches += 1
                        try:
                            conn.rollback()
                        except Exception:  # noqa: BLE001
                            try:
                                conn.close()
                            except Exception:  # noqa: BLE001, S110
                                pass
                            conn = connect(dsn)
                    file_rows += len(batch)
                os.remove(xp)
            os.remove(str(zip_path))
            el = max(1, int(time.time() - start))
            log(f"[{i}/{len(files)}] {name}: {file_rows} rows | total={total:,} ~{total // el}/s")
            if args.skip_imported and skipped_batches == skipped_before:
                imported.add(name)
                save_imported(imported)

    duration = int(time.time() - start)
    log(f"DONE: {total:,} rows upserted, {errors} file errors, {duration}s")
    if errors or skipped_batches:
        log(f"Refusing completed sync_metadata (file_errors={errors} skipped_batches={skipped_batches})")
        return 1
    live = count_live(conn)
    if live_before > 0 and live < live_before * (1.0 - 0.10):
        log(f"LIVE-count cliff: before={live_before:,} after={live:,} — not recording completed sync")
        return 1
    if args.record_sync_metadata:
        insert_sync_metadata(
            conn,
            datetime.now(timezone.utc).date().isoformat(),
            live,
            total,
            duration,
            f"Direct daily catch-up via scripts/backfill_direct.py for {from_date}..{to_date}",
        )
        log(f"Recorded completed sync_metadata row: sync_date={datetime.now(timezone.utc).date().isoformat()} LIVE={live:,}")
    log("Now run: VACUUM (ANALYZE) trademarks;  -- reclaim UPDATE bloat")
    return 0


if __name__ == "__main__":
    sys.exit(main())
