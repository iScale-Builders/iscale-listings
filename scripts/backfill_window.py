"""
Backfill USPTO daily delta files over a historical date window.

Fixes the coverage gap where daily files were never ingested, leaving
registrations / abandonments in that window stale (e.g. OUTING registered
Jul-2025 still showed pending; GRUNGE abandoned Oct-2025 still showed live).

Evidence (monthly US registration counts in our DB): normal ~30k/mo through
2025-05, then collapses to 3-10k/mo from 2025-06 through 2026-01, recovering by
2026-03. => missing window ~2025-06-01 .. 2026-02-25.

Reuses sync_daily_delta.py's download/parse/upsert helpers. Re-running is SAFE
and idempotent: it upserts on (jurisdiction, serial_number, international_class)
with merge-duplicates, so already-ingested days are harmless to reprocess.

Usage:
    USPTO_API_KEY=... NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
        python scripts/backfill_window.py [FROM_DATE] [TO_DATE]

Defaults: FROM=2025-06-01  TO=2026-02-25

Notes:
  - Needs USPTO_API_KEY (USPTO ODP). Daily files older than the ODP retention
    window may not be downloadable; if a chunk 404s, the alternative source is the
    next USPTO annual full-data file (TRTYRAP) once published.
  - Hundreds of thousands of UPDATEs will create dead tuples — run VACUUM
    (ANALYZE) on `trademarks` afterward to reclaim bloat.
"""

import json
import os
import sys
import tempfile
import time
import zipfile
from pathlib import Path

# Reuse the proven helpers from the daily sync.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from safe_zip import extract_suffixed_members
from sync_daily_delta import (
    API_BASE,
    PRODUCT_ID,
    api_get,
    download_file,
    log,
    make_rest_helpers,
    process_xml_to_records,
)

DEFAULT_FROM = "2025-06-01"
DEFAULT_TO = "2026-02-25"


def list_files_in_window(api_key: str, from_date: str, to_date: str) -> list[dict]:
    """Query the ODP API for daily (apc*.zip) files with data date in [from,to]."""
    url = (
        f"{API_BASE}/products/{PRODUCT_ID}?includeFiles=true"
        f"&fileDataFromDate={from_date}&fileDataToDate={to_date}"
    )
    data = json.loads(api_get(url, api_key, timeout=120))
    products = data.get("bulkDataProductBag", [])
    files: list[dict] = []
    if products:
        files = products[0].get("productFileBag", {}).get("fileDataBag", [])
    return [
        f
        for f in files
        if str(f.get("fileName", "")).lower().startswith("apc")
        and str(f.get("fileName", "")).lower().endswith(".zip")
    ]


def main() -> None:
    api_key = os.environ.get("USPTO_API_KEY", "")
    supabase_url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not (api_key and supabase_url and service_key):
        log("ERROR: USPTO_API_KEY / NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY must be set")
        sys.exit(1)

    from_date = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_FROM
    to_date = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_TO

    upsert_batch, count_live, insert_meta, _ = make_rest_helpers(supabase_url, service_key)

    log("=" * 60)
    log(f"USPTO BACKFILL  window {from_date} .. {to_date}")
    log("=" * 60)

    files = list_files_in_window(api_key, from_date, to_date)
    files.sort(key=lambda f: f.get("fileName", ""))
    log(f"Found {len(files)} daily files in window")
    if not files:
        log("Nothing to do (no files returned for window).")
        return

    start = time.time()
    total = 0
    errors = 0
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        for i, fi in enumerate(files, 1):
            name = fi.get("fileName", "?")
            log(f"[{i}/{len(files)}] {name}")
            zip_path = download_file(fi, tmp, api_key)
            if not zip_path:
                errors += 1
                continue

            xml_files: list[str] = []
            try:
                xml_files = [str(p) for p in extract_suffixed_members(Path(zip_path), tmp, ".xml")]
            except zipfile.BadZipFile:
                log(f"  bad zip: {name}")
                errors += 1
                os.remove(str(zip_path))
                continue

            for xp in xml_files:
                recs = process_xml_to_records(xp)
                for j in range(0, len(recs), 500):
                    total += upsert_batch(recs[j : j + 500])
                os.remove(xp)
            os.remove(str(zip_path))

            if i % 10 == 0:
                log(f"  ... {total:,} records upserted so far ({i}/{len(files)} files)")

    dur = int(time.time() - start)
    live = count_live()
    insert_meta(
        live if live is not None else 0,
        total,
        0,
        0,
        dur,
        "completed",
        f"backfill {from_date}..{to_date}",
    )
    log(f"DONE: {total:,} records upserted, {errors} file errors, {dur}s, LIVE={live}")
    log("Reminder: run VACUUM (ANALYZE) on `trademarks` to reclaim UPDATE bloat.")


if __name__ == "__main__":
    main()
