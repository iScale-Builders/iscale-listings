"""
Download all USPTO trademark annual XML files using the ODP API.

Usage:
    python scripts/download_uspto.py --api-key YOUR_KEY --output-dir ./data/uspto

Rate limits (from USPTO):
- 5 files per 10 seconds from same IP
- 1 API call at a time per key (sequential only)
- Download URLs are signed and expire in 5 seconds — start immediately
"""

import argparse
import json
import os
import sys
import time
import zipfile
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from safe_zip import extract_suffixed_members

API_BASE = "https://api.uspto.gov/api/v1/datasets"
PRODUCT_ID = "TRTYRAP"


def api_get(url: str, api_key: str, timeout: int = 30) -> bytes:
    """Make an authenticated GET request."""
    req = Request(url)
    req.add_header("Accept", "application/json")
    req.add_header("x-api-key", api_key)
    with urlopen(req, timeout=timeout) as resp:
        return resp.read()


def get_all_files(api_key: str) -> list:
    """Fetch the complete file listing for TRTYRAP product."""
    print("Fetching file listing from USPTO API...")

    url = f"{API_BASE}/products/{PRODUCT_ID}?includeFileData=true"
    data = json.loads(api_get(url, api_key))

    # Response structure: bulkDataProductBag[0].productFileBag.fileDataBag[]
    products = data.get("bulkDataProductBag", [])
    if not products:
        print(f"No product data found. Response keys: {list(data.keys())}")
        return []

    product = products[0]
    file_bag = product.get("productFileBag", {})
    files = file_bag.get("fileDataBag", [])
    total = file_bag.get("count", len(files))

    print(f"  Product: {product.get('productTitleText', PRODUCT_ID)}")
    print(f"  Total files listed: {total}")

    # Filter to only .zip data files
    zip_files = [
        f for f in files
        if f.get("fileName", "").endswith(".zip")
        and f.get("fileTypeText", "") == "Data"
    ]
    print(f"  ZIP data files: {len(zip_files)}")

    return zip_files


def download_file(file_info: dict, output_dir: Path, api_key: str) -> bool:
    """Download a single file. Handles signed redirect URLs."""
    filename = file_info["fileName"]
    download_url = file_info.get("fileDownloadURI", file_info.get("downloadUrl", ""))
    expected_size = file_info.get("fileSize", 0)
    dest_path = output_dir / filename

    # Skip if already downloaded with correct size
    if dest_path.exists():
        existing_size = dest_path.stat().st_size
        if expected_size and abs(existing_size - expected_size) < 1024:
            return True  # Already downloaded

    # The API returns a signed redirect URL that expires in 5 seconds
    # So we need to follow the redirect immediately
    req = Request(download_url)
    req.add_header("x-api-key", api_key)

    try:
        with urlopen(req, timeout=600) as resp:
            total = int(resp.headers.get("Content-Length", expected_size))
            downloaded = 0

            with open(str(dest_path), "wb") as f:
                while True:
                    chunk = resp.read(1024 * 1024)  # 1MB chunks
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total:
                        pct = (downloaded / total) * 100
                        mb = downloaded / 1024 / 1024
                        total_mb = total / 1024 / 1024
                        print(f"\r  {mb:.1f}/{total_mb:.1f} MB ({pct:.0f}%)", end="", flush=True)

            print()
            return True

    except (HTTPError, URLError, TimeoutError) as e:
        print(f"\n  FAILED: {e}")
        if dest_path.exists():
            os.remove(str(dest_path))
        return False


def extract_zip(zip_path: Path, xml_dir: Path) -> int:
    """Extract XML files from a ZIP. Returns count of extracted files."""
    try:
        return len(extract_suffixed_members(zip_path, xml_dir, ".xml"))
    except zipfile.BadZipFile:
        print(f"  WARNING: Bad ZIP: {zip_path.name}")
    return 0


def main():
    parser = argparse.ArgumentParser(
        description="Download USPTO trademark annual XML via ODP API"
    )
    parser.add_argument("--api-key", default=os.environ.get('USPTO_API_KEY'), help="Prefer USPTO_API_KEY in the private environment")
    parser.add_argument("--manifest-only", action="store_true", help="List current file count/bytes without downloading, extracting or creating folders")
    parser.add_argument("--output-dir", default="./data/uspto", help="Output directory")
    parser.add_argument("--no-extract", action="store_true", help="Skip ZIP extraction")
    parser.add_argument("--start-from", type=int, default=0, help="Start from file index N (for resuming)")

    args = parser.parse_args()
    if not args.api_key:
        parser.error('Set USPTO_API_KEY privately; no key is printed')

    output_dir = Path(args.output_dir)
    zip_dir = output_dir / "zips"
    xml_dir = output_dir / "xml"
    if not args.manifest_only:
        zip_dir.mkdir(parents=True, exist_ok=True)
        xml_dir.mkdir(parents=True, exist_ok=True)

    print("=" * 60)
    print("USPTO Trademark Annual Data Downloader")
    print("=" * 60)

    # Get file listing
    files = get_all_files(args.api_key)

    if not files:
        print("No files found. Check API key and try again.")
        sys.exit(1)

    total_size = sum(f.get("fileSize", 0) for f in files)
    print(f"Manifest compressed bytes: {total_size}; this excludes XML, database, indexes and scratch space")
    if args.manifest_only:
        return
    print(f"\nTotal: {len(files)} files, {total_size / 1024 / 1024 / 1024:.1f} GB")
    print(f"Saving ZIPs to: {zip_dir}")
    print(f"Extracting XML to: {xml_dir}")
    print()

    # Download all files
    start_time = time.time()
    downloaded = 0
    skipped = 0
    failed = 0
    total_xml = 0
    download_times = []

    for i, file_info in enumerate(files):
        if i < args.start_from:
            continue

        filename = file_info["fileName"]
        size_mb = file_info.get("fileSize", 0) / 1024 / 1024

        print(f"[{i + 1}/{len(files)}] {filename} ({size_mb:.1f} MB)")

        dest = zip_dir / filename
        if dest.exists() and dest.stat().st_size > 0:
            file_size = file_info.get("fileSize", 0)
            if file_size and abs(dest.stat().st_size - file_size) < 1024:
                print("  Already downloaded, skipping")
                skipped += 1
                if not args.no_extract:
                    count = extract_zip(dest, xml_dir)
                    total_xml += count
                    if count == 0:
                        failed += 1
                continue

        dl_start = time.time()
        success = download_file(file_info, zip_dir, args.api_key)
        dl_time = time.time() - dl_start

        if success:
            downloaded += 1
            download_times.append(dl_time)

            if not args.no_extract:
                print("  Extracting...", end=" ")
                count = extract_zip(zip_dir / filename, xml_dir)
                total_xml += count
                if count == 0:
                    failed += 1
                print(f"{count} XML files")

            # Rate limit: max 5 files per 10 seconds
            if len(download_times) >= 5:
                recent = download_times[-5:]
                elapsed = sum(recent)
                if elapsed < 10:
                    wait = 10 - elapsed
                    print(f"  Rate limiting: waiting {wait:.1f}s...")
                    time.sleep(wait)
        else:
            failed += 1
            time.sleep(5)  # Wait before retrying next file

    duration = time.time() - start_time
    hours = duration / 3600

    print(f"\n{'=' * 60}")
    print("DOWNLOAD FAILED" if failed else "DOWNLOAD COMPLETE")
    print(f"  Downloaded: {downloaded}")
    print(f"  Skipped (existing): {skipped}")
    print(f"  Failed: {failed}")
    print(f"  XML files extracted: {total_xml}")
    print(f"  Duration: {hours:.1f} hours")
    if failed:
        print("Download/extraction failed; repair failed files before loading.", file=sys.stderr)
        sys.exit(1)
    print("\nNext step — run the bulk loader:")
    print(f"  python scripts/load_uspto.py {xml_dir}  # uses private TM_DB_URL environment")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    main()
