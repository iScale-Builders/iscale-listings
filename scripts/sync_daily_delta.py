"""
Daily USPTO trademark sync.

Downloads the latest daily delta XML from USPTO, parses text-based marks,
and upserts into Supabase via REST API.

Designed to run as a GitHub Actions cron job.

Usage:
    USPTO_API_KEY=xxx NEXT_PUBLIC_SUPABASE_URL=xxx SUPABASE_SERVICE_ROLE_KEY=xxx \
        python scripts/sync_daily_delta.py

Environment variables:
    USPTO_API_KEY           - USPTO ODP API key (from ID.me)
    NEXT_PUBLIC_SUPABASE_URL - Supabase project URL
    SUPABASE_SERVICE_ROLE_KEY - Supabase service role key (server-side only)
"""

import json
import os
import sys
import tempfile
import time
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

# Add scripts dir to path for imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lxml import etree
from safe_zip import extract_suffixed_members
from tm_splitter_adapted import extract_trademark

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

API_BASE = "https://api.uspto.gov/api/v1/datasets"
PRODUCT_ID = "TRTDXFAP"  # Daily Applications (not TRTYRAP which is annual)
SAFETY_DROP_THRESHOLD = 0.10  # abort if LIVE count drops > 10%


# ---------------------------------------------------------------------------
# USPTO API helpers
# ---------------------------------------------------------------------------

def api_get(url: str, api_key: str, timeout: int = 30) -> bytes:
    req = Request(url)
    req.add_header("Accept", "application/json")
    req.add_header("x-api-key", api_key)
    with urlopen(req, timeout=timeout) as resp:
        return resp.read()


def find_daily_files(api_key: str, lookback_days: int = 3) -> list[dict]:
    """
    Find recent daily delta files from the USPTO ODP API.
    Daily files are named apcYYMMDD.zip (2-digit year).
    Published Tuesday–Saturday. Looks back up to `lookback_days` to catch weekends/missed days.
    """
    log("Fetching file listing from USPTO API...")

    # Use date-filtered query to only get recent files
    from_date = (datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=lookback_days)).strftime("%Y-%m-%d")
    to_date = datetime.now(timezone.utc).replace(tzinfo=None).strftime("%Y-%m-%d")
    url = (f"{API_BASE}/products/{PRODUCT_ID}"
           f"?includeFiles=true"
           f"&fileDataFromDate={from_date}"
           f"&fileDataToDate={to_date}")

    data = json.loads(api_get(url, api_key))

    # Try multiple possible response shapes from the ODP API
    files = []
    products = data.get("bulkDataProductBag", [])
    if products:
        product = products[0]
        file_bag = product.get("productFileBag", {})
        files = file_bag.get("fileDataBag", [])

    if not files:
        # Try alternate response shape
        files = data.get("productFiles", data.get("files", []))

    if not files:
        log(f"No files found in response. Keys: {list(data.keys())}")
        # Fallback: try without date filter
        log("Retrying without date filter...")
        url_fallback = f"{API_BASE}/products/{PRODUCT_ID}?includeFiles=true"
        data = json.loads(api_get(url_fallback, api_key))
        products = data.get("bulkDataProductBag", [])
        if products:
            product = products[0]
            file_bag = product.get("productFileBag", {})
            files = file_bag.get("fileDataBag", [])

    # Build expected daily filenames for the lookback window
    # Daily files use 2-digit year: apcYYMMDD.zip
    expected_names = set()
    for days_ago in range(lookback_days + 1):
        d = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=days_ago)
        expected_names.add(f"apc{d.strftime('%y%m%d')}.zip")

    daily_files = []
    for f in files:
        filename = f.get("fileName", "")
        if not filename.endswith(".zip"):
            continue

        # Match by expected daily filename pattern
        if filename in expected_names:
            daily_files.append(f)
            continue

        # Also accept if file was released/modified within lookback window
        for date_field in ("fileReleaseDate", "lastModifiedDate"):
            date_val = f.get(date_field, "")
            if date_val:
                try:
                    mod_date = datetime.fromisoformat(date_val.replace("Z", "+00:00"))
                    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=lookback_days)
                    if mod_date.replace(tzinfo=None) >= cutoff:
                        if filename not in [df.get("fileName") for df in daily_files]:
                            daily_files.append(f)
                        break
                except (ValueError, TypeError):
                    pass

    log(f"Found {len(daily_files)} recent files (last {lookback_days} days)")
    for f in daily_files:
        log(f"  -> {f.get('fileName', '?')}")
    return daily_files


def download_file(file_info: dict, dest_dir: Path, api_key: str) -> Path | None:
    """Download a single file. Returns path or None on failure.

    The ODP API returns a 307 redirect to a CDN URL for file downloads.
    We use the canonical download path: /products/files/{PRODUCT_ID}/{filename}
    """
    filename = file_info["fileName"]
    # Prefer the canonical API download path (handles redirects properly).
    # Manifest-supplied hosts must be uspto.gov so a poisoned listing cannot
    # send the ODP API key to an attacker URL.
    candidate = file_info.get("fileDownloadURI") or file_info.get("downloadUrl") or ""
    canonical = f"{API_BASE}/products/files/{PRODUCT_ID}/{filename}"
    if candidate:
        host = (urlparse(candidate).hostname or "").lower()
        if not host.endswith("uspto.gov"):
            log(f"  refusing non-uspto.gov download host: {host or '(none)'}")
            download_url = canonical
        else:
            download_url = candidate
    else:
        download_url = canonical
    dest_path = dest_dir / filename

    if dest_path.exists():
        return dest_path

    log(f"  Downloading {filename} from {download_url[:80]}...")

    # Use a redirect-following opener for 307 redirects to CDN
    import urllib.request
    opener = urllib.request.build_opener(urllib.request.HTTPRedirectHandler)

    # USPTO answers HTTP 429 (rate limit) when several daily files are fetched back to back; on 2026-10-06
    # 5 of 7 files failed that way and the whole sync refused to complete. Retry 429/503 after the server's
    # Retry-After (capped) or 30, 60, 120, 240 s.
    for attempt in range(len(RETRY_WAITS_S) + 1):
        req = Request(download_url)
        req.add_header("x-api-key", api_key)
        req.add_header("Accept", "application/zip")
        try:
            with opener.open(req, timeout=600) as resp, open(str(dest_path), "wb") as f:
                while True:
                    chunk = resp.read(1024 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
            size_mb = dest_path.stat().st_size / 1024 / 1024
            log(f"  Downloaded {filename} ({size_mb:.1f} MB)")
            return dest_path
        except (HTTPError, URLError, TimeoutError) as e:
            if dest_path.exists():
                os.remove(str(dest_path))
            if isinstance(e, HTTPError) and e.code in RETRY_STATUS and attempt < len(RETRY_WAITS_S):
                wait = retry_wait_seconds(e, attempt)
                log(f"  {filename}: HTTP {e.code}, retry {attempt + 1}/{len(RETRY_WAITS_S)} in {wait}s")
                time.sleep(wait)
                continue
            log(f"  FAILED to download {filename}: {e}")
            return None
    return None


RETRY_STATUS = (429, 503)
RETRY_WAITS_S = (30, 60, 120, 240)
RETRY_AFTER_CAP_S = 300


def retry_wait_seconds(err: HTTPError, attempt: int) -> int:
    """Seconds to wait before retry `attempt` (0-based): the server's numeric Retry-After, capped, else the backoff table."""
    header = err.headers.get("Retry-After") if getattr(err, "headers", None) else None
    if header and str(header).strip().isdigit():
        return min(int(str(header).strip()), RETRY_AFTER_CAP_S)
    return RETRY_WAITS_S[min(attempt, len(RETRY_WAITS_S) - 1)]


# ---------------------------------------------------------------------------
# Supabase REST helpers
# ---------------------------------------------------------------------------

def make_rest_helpers(supabase_url: str, service_key: str):
    """Create helper functions for Supabase REST API calls."""
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates",
    }
    table_url = f"{supabase_url}/rest/v1/trademarks"
    meta_url = f"{supabase_url}/rest/v1/sync_metadata"

    def upsert_batch(records: list[dict]) -> tuple[int, int]:
        """Upsert records. Returns (count inserted, count failed)."""
        if not records:
            return 0, 0
        body = json.dumps(records).encode("utf-8")
        url = f"{table_url}?on_conflict=jurisdiction,serial_number,international_class"
        req = Request(url, data=body, method="POST")
        for k, v in headers.items():
            req.add_header(k, v)
        try:
            with urlopen(req, timeout=30) as resp:
                resp.read()
            return len(records), 0
        except HTTPError as e:
            error_body = e.read().decode() if hasattr(e, 'read') else str(e)
            log(f"  Upsert error: {e.code} — {error_body[:200]}")
            if len(records) > 50 and (e.code >= 500 or "57014" in error_body):
                mid = len(records) // 2
                left_inserted, left_failed = upsert_batch(records[:mid])
                right_inserted, right_failed = upsert_batch(records[mid:])
                return left_inserted + right_inserted, left_failed + right_failed
            return 0, len(records)

    def count_live() -> int | None:
        """Count LIVE marks in the database. Returns None on failure."""
        url = f"{table_url}?jurisdiction=eq.US&status=eq.LIVE&select=id"
        for attempt in range(3):
            req = Request(url)
            req.add_header("apikey", service_key)
            req.add_header("Authorization", f"Bearer {service_key}")
            req.add_header("Prefer", "count=estimated")
            req.add_header("Range", "0-0")
            try:
                with urlopen(req, timeout=120) as resp:
                    content_range = resp.headers.get("Content-Range", "")
                    # Format: "0-0/12345"
                    if "/" in content_range:
                        return int(content_range.split("/")[1])
            except Exception as e:  # noqa: BLE001
                log(f"  Count error (attempt {attempt + 1}/3): {e}")
                if attempt < 2:
                    time.sleep(5)
        return None

    def insert_meta(live_count: int, added: int, updated: int, status_changed: int,
                    duration: int, status: str, error_msg: str | None = None):
        """Record sync metadata."""
        record = {
            "sync_date": datetime.now(timezone.utc).replace(tzinfo=None).strftime("%Y-%m-%d"),
            "jurisdiction": "US",
            "source": "uspto",
            "live_mark_count": live_count,
            "marks_added": added,
            "marks_updated": updated,
            "marks_status_changed": status_changed,
            "sync_duration_seconds": duration,
            "status": status,
            "error_message": error_msg,
        }
        body = json.dumps(record).encode("utf-8")
        req = Request(meta_url, data=body, method="POST")
        for k, v in headers.items():
            req.add_header(k, v)
        try:
            with urlopen(req, timeout=30) as resp:
                resp.read()
        except HTTPError as e:
            log(f"  Meta insert error: {e}")

    def get_previous_live_count() -> int:
        """Get the last completed sync's LIVE count."""
        url = (f"{meta_url}?status=eq.completed"
               f"&select=live_mark_count"
               f"&order=created_at.desc&limit=1")
        req = Request(url)
        req.add_header("apikey", service_key)
        req.add_header("Authorization", f"Bearer {service_key}")
        try:
            with urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read())
                if data:
                    return data[0].get("live_mark_count", 0)
        except Exception as e:  # noqa: BLE001
            log(f"  Previous count error: {e}")
        return 0

    return upsert_batch, count_live, insert_meta, get_previous_live_count


# ---------------------------------------------------------------------------
# XML Processing
# ---------------------------------------------------------------------------

def process_xml_to_records(xml_path: str) -> list[dict]:
    """Parse a USPTO XML file and return records ready for upsert."""
    records = []
    context = etree.iterparse(xml_path, events=("end",), tag="case-file")

    for event, elem in context:
        try:
            extracted = extract_trademark(elem)
            if extracted:
                for record in extracted:
                    records.append({
                        "jurisdiction": "US",
                        "source": "uspto",
                        "serial_number": record["serial_number"],
                        "registration_number": record["registration_number"],
                        "wordmark": record["wordmark"],
                        "wordmark_normalized": record["wordmark_normalized"],
                        "mark_drawing_type": record["mark_drawing_type"],
                        "status": record["status"],
                        "status_code": record["status_code"],
                        "filing_date": record["filing_date"],
                        "registration_date": record["registration_date"],
                        "owner_name": record["owner_name"],
                        "international_class": record["international_class"],
                    })
        except Exception:  # noqa: BLE001, S110
            pass  # Skip malformed records

        elem.clear()
        while elem.getprevious() is not None:
            del elem.getparent()[0]

    return records


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

def log(msg: str):
    timestamp = datetime.now(timezone.utc).replace(tzinfo=None).strftime("%H:%M:%S")
    print(f"[{timestamp}] {msg}", flush=True)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    api_key = os.environ.get("USPTO_API_KEY", "")
    supabase_url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

    if not api_key:
        log("ERROR: USPTO_API_KEY not set")
        sys.exit(1)
    if not supabase_url or not service_key:
        log("ERROR: Supabase env vars not set")
        sys.exit(1)

    log("=" * 60)
    log("USPTO Daily Trademark Sync")
    log("=" * 60)

    upsert_batch, count_live, insert_meta, get_previous_live_count = \
        make_rest_helpers(supabase_url, service_key)

    start_time = time.time()
    previous_count = get_previous_live_count()
    log(f"Previous LIVE count: {previous_count:,}")

    # Find and download recent daily delta files. Lookback is wider than the
    # cadence on purpose: re-upserting recent days is idempotent (merge-duplicates),
    # and the cushion means a few missed cron runs self-heal instead of leaving a
    # permanent coverage hole (cf. the 2025-06..2026-02 gap backfilled separately).
    daily_files = find_daily_files(api_key, lookback_days=int(os.environ.get("SYNC_LOOKBACK_DAYS", "7")))

    if not daily_files:
        log("No recent daily files found. Nothing to sync.")
        duration = int(time.time() - start_time)
        live = count_live()
        insert_meta(live, 0, 0, 0, duration, "completed", "No new files")
        log(f"LIVE marks: {live:,}")
        return

    total_inserted = 0
    total_errors = 0

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp_path = Path(tmpdir)

        for file_info in daily_files:
            filename = file_info["fileName"]
            log(f"Processing: {filename}")

            # Download
            zip_path = download_file(file_info, tmp_path, api_key)
            if not zip_path:
                total_errors += 1
                continue

            # Extract XML from ZIP
            xml_files = []
            try:
                xml_files = [str(p) for p in extract_suffixed_members(Path(zip_path), tmp_path, ".xml")]
            except zipfile.BadZipFile:
                log(f"  Bad ZIP file: {filename}")
                total_errors += 1
                continue

            log(f"  Extracted {len(xml_files)} XML files")

            # Parse and upsert
            for xml_file in xml_files:
                records = process_xml_to_records(xml_file)
                log(f"  Parsed {len(records):,} records from {os.path.basename(xml_file)}")

                # Upsert in batches of 500
                batch_size = 500
                for i in range(0, len(records), batch_size):
                    batch = records[i:i + batch_size]
                    inserted, failed = upsert_batch(batch)
                    total_inserted += inserted
                    total_errors += failed

                    if total_inserted % 5000 == 0 and total_inserted > 0:
                        log(f"  Progress: {total_inserted:,} records upserted")

                # Clean up XML file
                os.remove(xml_file)

            # Clean up ZIP
            os.remove(str(zip_path))

    # Safety check
    duration = int(time.time() - start_time)
    current_live = count_live()

    if total_errors > 0:
        live = current_live if current_live is not None else previous_count
        msg = f"{total_errors} records failed to upsert"
        log(f"SYNC FAILED: {msg}")
        insert_meta(live, total_inserted, 0, 0, duration, "failed", msg)
        sys.exit(1)

    if current_live is None:
        log("WARNING: Could not verify LIVE count (query timed out). Data was upserted successfully.")
        insert_meta(previous_count, total_inserted, 0, 0, duration, "completed",
                    "Count verification timed out — upsert succeeded")
    elif previous_count > 0 and current_live < previous_count * (1 - SAFETY_DROP_THRESHOLD):
        log(f"SAFETY ABORT: LIVE count dropped from {previous_count:,} to {current_live:,}")
        insert_meta(current_live, total_inserted, 0, 0, duration, "aborted",
                    f"LIVE count dropped {previous_count} -> {current_live}")
        sys.exit(1)
    else:
        # Record success
        insert_meta(current_live, total_inserted, 0, 0, duration, "completed")

    live_display = f"{current_live:,}" if current_live is not None else "unknown (count timed out)"
    log(f"\n{'=' * 60}")
    log("SYNC COMPLETE")
    log(f"  Records upserted: {total_inserted:,}")
    log(f"  Errors: {total_errors}")
    log(f"  LIVE marks: {live_display}")
    log(f"  Duration: {duration}s")
    log(f"{'=' * 60}")


if __name__ == "__main__":
    main()
