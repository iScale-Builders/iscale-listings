"""
Standalone loader script — run in background to load all XML files into Supabase.
Usage: python scripts/run_load.py
"""
import time
import sys
import os
import glob

# Add scripts dir to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from load_uspto import make_rest_inserter, process_xml_rest

SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
XML_DIR = os.environ.get("XML_DIR", "./data/uspto/xml")
LOG_FILE = os.environ.get("LOAD_LOG", "./data/uspto/load.log")

def log(msg):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    with open(LOG_FILE, "a") as f:
        f.write(line + "\n")

def main():
    upsert_batch, count_live, insert_meta = make_rest_inserter(SUPABASE_URL, SERVICE_KEY)

    xml_files = sorted(glob.glob(os.path.join(XML_DIR, "*.xml")))
    log(f"Found {len(xml_files)} XML files")
    log(f"Current LIVE marks: {count_live()}")

    total_inserted = 0
    total_errors = 0
    start = time.time()

    for i, f in enumerate(xml_files):
        basename = os.path.basename(f)
        size_mb = os.path.getsize(f) / 1024 / 1024
        log(f"[{i+1}/{len(xml_files)}] {basename} ({size_mb:.0f} MB)")
        file_start = time.time()

        stats = process_xml_rest(f, upsert_batch, batch_size=500)

        elapsed = time.time() - file_start
        total_inserted += stats["inserted"]
        total_errors += stats["errors"]
        rate = stats["inserted"] / elapsed if elapsed > 0 else 0
        log(f"  {stats['inserted']:,} inserted, {stats['skipped']:,} skipped, "
            f"{stats['errors']:,} errors in {elapsed:.0f}s ({rate:.0f} rec/s)")

    total_time = time.time() - start
    live = count_live()

    log(f"\n{'='*60}")
    log("LOAD COMPLETE")
    log(f"  Total inserted: {total_inserted:,}")
    log(f"  Total errors: {total_errors:,}")
    log(f"  Duration: {total_time/3600:.1f} hours")
    log(f"  LIVE marks: {live:,}")

    # Record baseline
    insert_meta(live, total_inserted, int(total_time))
    log("Baseline recorded in sync_metadata")
    log(f"{'='*60}")


if __name__ == "__main__":
    main()
