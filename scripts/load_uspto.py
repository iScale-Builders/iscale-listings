"""
Initial bulk load of USPTO trademark data into Supabase PostgreSQL.

Usage (via REST API — no database password needed):
    python scripts/load_uspto.py <xml_directory> \
        --supabase-url https://xxxxx.supabase.co \
        --service-key eyJ...

Usage (via direct PostgreSQL connection — faster):
    python scripts/load_uspto.py <xml_directory> \
        --db-url postgresql://postgres:PASSWORD@db.xxxxx.supabase.co:5432/postgres

This script:
1. Scans a directory for USPTO bulk XML files
2. Processes each file using tm_splitter_adapted.py
3. Inserts text-based marks into the trademarks table
4. Validates the final count (expects 3M+ LIVE text marks)
5. Records the baseline in sync_metadata

WARNING: This takes 4-8 hours. Run locally, NOT in serverless.
"""

import os
import sys
import time
import json
import argparse
import glob
from urllib.request import Request, urlopen
from urllib.error import HTTPError


def make_rest_inserter(supabase_url: str, service_key: str):
    """Create a batch inserter that uses the Supabase REST API (PostgREST)."""
    base_url = supabase_url.rstrip("/")

    def upsert_batch(table: str, rows: list[dict]) -> int:
        """Upsert a batch of rows via PostgREST. Returns count inserted."""
        url = f"{base_url}/rest/v1/{table}?on_conflict=jurisdiction,serial_number,international_class"
        data = json.dumps(rows).encode("utf-8")

        req = Request(url, data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("apikey", service_key)
        req.add_header("Authorization", f"Bearer {service_key}")
        # Upsert on serial_number conflict
        req.add_header("Prefer", "resolution=merge-duplicates")

        try:
            with urlopen(req, timeout=120):
                return len(rows)
        except HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            print(f"  REST API error {e.code}: {body[:200]}", file=sys.stderr)
            return 0

    def execute_sql(sql: str, params: tuple = ()) -> list:
        """Execute raw SQL via Supabase RPC (for count queries, metadata inserts)."""
        # This won't work directly — we'll use the MCP or a workaround
        # For now, count via REST filter
        raise NotImplementedError("Use count_live_marks() instead")

    def count_live_marks() -> int:
        """Count LIVE marks via REST API."""
        url = f"{base_url}/rest/v1/trademarks?jurisdiction=eq.US&status=eq.LIVE&select=id"
        req = Request(url, method="HEAD")
        req.add_header("apikey", service_key)
        req.add_header("Authorization", f"Bearer {service_key}")
        req.add_header("Prefer", "count=exact")

        try:
            with urlopen(req, timeout=30) as resp:
                content_range = resp.headers.get("Content-Range", "")
                # Format: "0-24/12345" or "*/12345"
                if "/" in content_range:
                    return int(content_range.split("/")[1])
        except HTTPError as e:
            print(f"  Count error: {e}", file=sys.stderr)
        return -1

    def insert_sync_metadata(live_count: int, marks_added: int, duration: int):
        """Record sync baseline via REST API."""
        url = f"{base_url}/rest/v1/sync_metadata"
        row = {
            "sync_date": time.strftime("%Y-%m-%d"),
            "jurisdiction": "US",
            "source": "uspto",
            "live_mark_count": live_count,
            "marks_added": marks_added,
            "marks_updated": 0,
            "marks_status_changed": 0,
            "sync_duration_seconds": duration,
            "status": "completed",
        }
        data = json.dumps(row).encode("utf-8")
        req = Request(url, data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("apikey", service_key)
        req.add_header("Authorization", f"Bearer {service_key}")

        try:
            with urlopen(req, timeout=30):
                return True
        except HTTPError as e:
            print(f"  Sync metadata error: {e}", file=sys.stderr)
            return False

    return upsert_batch, count_live_marks, insert_sync_metadata


def process_xml_rest(xml_path: str, upsert_batch, batch_size: int = 500) -> dict:
    """Process a USPTO XML file and insert via REST API."""
    from lxml import etree
    from tm_splitter_adapted import extract_trademark

    stats = {"processed": 0, "inserted": 0, "skipped": 0, "errors": 0}
    batch = []

    context = etree.iterparse(xml_path, events=("end",), tag="case-file")

    for event, elem in context:
        stats["processed"] += 1

        try:
            records = extract_trademark(elem)
            if records is None:
                stats["skipped"] += 1
            else:
                batch.extend(records)

                if len(batch) >= batch_size:
                    count = upsert_batch("trademarks", batch)
                    if count > 0:
                        stats["inserted"] += count
                    else:
                        stats["errors"] += len(batch)
                    batch = []

                    if stats["inserted"] % 10000 == 0 and stats["inserted"] > 0:
                        print(f"    {stats['inserted']:,} inserted...")

        except Exception as e:
            stats["errors"] += 1
            if stats["errors"] <= 10:
                print(f"  Error: {e}", file=sys.stderr)

        elem.clear()
        while elem.getprevious() is not None:
            del elem.getparent()[0]

    # Insert remaining batch
    if batch:
        count = upsert_batch("trademarks", batch)
        if count > 0:
            stats["inserted"] += count
        else:
            stats["errors"] += len(batch)

    return stats


def process_xml_psycopg2(xml_path: str, conn, batch_size: int = 1000) -> dict:
    """Process a USPTO XML file and insert via direct PostgreSQL."""
    from tm_splitter_adapted import process_xml_file
    return process_xml_file(xml_path, conn, batch_size=batch_size)


def main():
    parser = argparse.ArgumentParser(
        description="Bulk load USPTO trademark data into Supabase PostgreSQL"
    )
    parser.add_argument(
        "xml_dir",
        help="Directory containing USPTO bulk XML files",
    )
    parser.add_argument(
        "--db-url",
        default=os.environ.get("TM_DB_URL") or os.environ.get("SUPABASE_DB_URL"),
        help="Direct PostgreSQL connection string (faster)",
    )
    parser.add_argument(
        "--supabase-url",
        default=os.environ.get("NEXT_PUBLIC_SUPABASE_URL"),
        help="Supabase project URL (for REST API mode)",
    )
    parser.add_argument(
        "--service-key",
        default=os.environ.get("SUPABASE_SERVICE_ROLE_KEY"),
        help="Supabase service role key (for REST API mode)",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=500,
        help="Batch insert size (default: 500)",
    )
    parser.add_argument(
        "--start-from",
        type=int,
        default=0,
        help="Start from file index N (for resuming)",
    )

    args = parser.parse_args()

    use_rest = False
    conn = None

    if args.db_url:
        import psycopg2
        conn = psycopg2.connect(args.db_url)
        print("Connected to database (direct PostgreSQL)")
    elif args.supabase_url and args.service_key:
        use_rest = True
        print(f"Using REST API mode: {args.supabase_url}")
    else:
        print(
            "Error: provide either --db-url or both --supabase-url and --service-key",
            file=sys.stderr,
        )
        sys.exit(1)

    if use_rest:
        upsert_batch, count_live_marks, insert_sync_metadata = make_rest_inserter(
            args.supabase_url, args.service_key
        )

    # Find XML files
    xml_files = sorted(glob.glob(os.path.join(args.xml_dir, "*.xml")))

    if not xml_files:
        print(f"No XML files found in {args.xml_dir}", file=sys.stderr)
        sys.exit(1)

    print(f"Found {len(xml_files)} XML files to process")

    total_stats = {"processed": 0, "inserted": 0, "skipped": 0, "errors": 0}
    start_time = time.time()

    for i, xml_file in enumerate(xml_files):
        if i < args.start_from:
            continue

        file_size_mb = os.path.getsize(xml_file) / 1024 / 1024
        print(f"\n[{i + 1}/{len(xml_files)}] {os.path.basename(xml_file)} ({file_size_mb:.0f} MB)")
        file_start = time.time()

        if use_rest:
            stats = process_xml_rest(xml_file, upsert_batch, batch_size=args.batch_size)
        else:
            stats = process_xml_psycopg2(xml_file, conn, batch_size=args.batch_size)

        file_duration = time.time() - file_start
        print(
            f"  Done in {file_duration:.0f}s: "
            f"{stats['processed']:,} processed, "
            f"{stats['inserted']:,} inserted, "
            f"{stats['skipped']:,} skipped, "
            f"{stats['errors']:,} errors"
        )

        for key in total_stats:
            total_stats[key] += stats[key]

    total_duration = time.time() - start_time

    print(f"\n{'='*60}")
    print("LOAD COMPLETE")
    print(f"  Processed: {total_stats['processed']:,}")
    print(f"  Inserted:  {total_stats['inserted']:,}")
    print(f"  Skipped:   {total_stats['skipped']:,}")
    print(f"  Errors:    {total_stats['errors']:,}")
    print(f"  Duration:  {total_duration / 3600:.1f} hours")

    # Count LIVE marks
    if use_rest:
        live_count = count_live_marks()
    else:
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM trademarks WHERE jurisdiction = 'US' AND status = 'LIVE'")
        live_count = cursor.fetchone()[0]
        cursor.close()

    print(f"\nLIVE mark count: {live_count:,}")

    MIN_EXPECTED = 3_000_000
    if total_stats["errors"] > 0 or live_count < MIN_EXPECTED:
        print(
            f"REFUSED: Expected at least {MIN_EXPECTED:,} US LIVE rows and zero errors; "
            f"got {live_count:,} rows and {total_stats['errors']:,} errors. No completed baseline recorded.",
            file=sys.stderr,
        )
        if conn:
            conn.close()
        sys.exit(1)

    # Record baseline
    if use_rest:
        if not insert_sync_metadata(live_count, total_stats["inserted"], int(total_duration)):
            sys.exit(1)
    else:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO sync_metadata (
                sync_date, jurisdiction, source, live_mark_count, marks_added, marks_updated,
                marks_status_changed, sync_duration_seconds, status
            ) VALUES (CURRENT_DATE, 'US', 'uspto', %s, %s, 0, 0, %s, 'completed')
            """,
            (live_count, total_stats["inserted"], int(total_duration)),
        )
        conn.commit()
        cursor.close()

    print("Baseline recorded in sync_metadata")

    if conn:
        conn.close()

    print(f"{'='*60}")


if __name__ == "__main__":
    main()
