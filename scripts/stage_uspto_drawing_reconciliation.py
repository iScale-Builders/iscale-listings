"""Build a resumable local stage for the USPTO drawing-code reconciliation.

The stage starts from the latest complete annual USPTO applications snapshot,
keeps only code 3 (words and design) and code 5 (stylized text), then replays
daily application files chronologically through the requested date. Downloads
are processed one at a time and deleted by default; production is not touched.

Usage:
    python scripts/stage_uspto_drawing_reconciliation.py stage \
      --state-db C:/safe/iscale-uspto-drawing-stage.sqlite3 \
      --work-dir C:/safe/iscale-uspto-downloads

    python scripts/stage_uspto_drawing_reconciliation.py summary \
      --state-db C:/safe/iscale-uspto-drawing-stage.sqlite3
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import time
import zipfile
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import BinaryIO, Iterator
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener, HTTPRedirectHandler

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from download_uspto import get_all_files as list_annual_files  # noqa: E402
from tm_splitter_adapted import extract_trademark  # noqa: E402


ANNUAL_PRODUCT_ID = "TRTYRAP"
DAILY_PRODUCT_ID = "TRTDXFAP"
API_BASE = "https://api.uspto.gov/api/v1/datasets"
STAGED_TYPES = frozenset({"words and design", "stylized text"})
ANNUAL_NAME_RE = re.compile(r"-(\d{8})-(\d+)\.zip$", re.IGNORECASE)
STAGE_COLUMNS = (
    "jurisdiction",
    "source",
    "serial_number",
    "registration_number",
    "wordmark",
    "wordmark_normalized",
    "mark_drawing_type",
    "status",
    "status_code",
    "filing_date",
    "registration_date",
    "owner_name",
    "international_class",
)


def log(message: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {message}", flush=True)


def connect_state(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA temp_store=MEMORY")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS stage_records (
          row_id INTEGER PRIMARY KEY AUTOINCREMENT,
          jurisdiction TEXT NOT NULL,
          source TEXT NOT NULL,
          serial_number TEXT NOT NULL,
          registration_number TEXT,
          wordmark TEXT NOT NULL,
          wordmark_normalized TEXT NOT NULL,
          mark_drawing_type TEXT NOT NULL,
          status TEXT NOT NULL,
          status_code TEXT,
          filing_date TEXT,
          registration_date TEXT,
          owner_name TEXT,
          international_class TEXT NOT NULL,
          UNIQUE (jurisdiction, serial_number, international_class)
        );

        CREATE INDEX IF NOT EXISTS stage_records_serial
          ON stage_records(serial_number);

        CREATE TABLE IF NOT EXISTS completed_files (
          file_name TEXT PRIMARY KEY,
          source_kind TEXT NOT NULL,
          source_date TEXT NOT NULL,
          expected_bytes INTEGER,
          case_files INTEGER NOT NULL,
          staged_rows INTEGER NOT NULL,
          processed_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS stage_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        """
    )
    conn.commit()
    return conn


def set_meta(conn: sqlite3.Connection, key: str, value: object) -> None:
    conn.execute(
        "INSERT INTO stage_meta(key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, str(value)),
    )


def get_meta(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM stage_meta WHERE key=?", (key,)).fetchone()
    return str(row[0]) if row else None


def select_latest_annual_files(files: list[dict]) -> tuple[str, list[dict]]:
    parsed: list[tuple[str, int, dict]] = []
    for info in files:
        match = ANNUAL_NAME_RE.search(str(info.get("fileName", "")))
        if match:
            parsed.append((match.group(1), int(match.group(2)), info))
    if not parsed:
        raise RuntimeError("USPTO annual listing contained no recognized ZIP parts")
    cutoff_raw = max(item[0] for item in parsed)
    selected = [item for item in parsed if item[0] == cutoff_raw]
    selected.sort(key=lambda item: item[1])
    cutoff = datetime.strptime(cutoff_raw, "%Y%m%d").date().isoformat()
    return cutoff, [item[2] for item in selected]


def case_serial_number(case_file: object) -> str | None:
    serial = case_file.find("serial-number")  # type: ignore[attr-defined]
    if serial is None:
        serial = case_file.find(".//case-file-header/serial-number")  # type: ignore[attr-defined]
    text = getattr(serial, "text", None)
    return text.strip() if text and text.strip() else None


def iter_case_files(stream: BinaryIO, backend: str = "lxml") -> Iterator[object]:
    if backend == "lxml":
        try:
            from lxml import etree
        except ImportError as exc:
            raise RuntimeError("lxml is required for production-scale staging") from exc
        for _, elem in etree.iterparse(stream, events=("end",), tag="case-file"):
            yield elem
        return

    if backend != "stdlib":
        raise ValueError(f"unknown parser backend: {backend}")
    from xml.etree import ElementTree

    for _, elem in ElementTree.iterparse(stream, events=("end",)):
        if str(elem.tag).rsplit("}", 1)[-1] == "case-file":
            yield elem


def clear_element(elem: object) -> None:
    elem.clear()  # type: ignore[attr-defined]
    get_previous = getattr(elem, "getprevious", None)
    get_parent = getattr(elem, "getparent", None)
    if callable(get_previous) and callable(get_parent):
        while elem.getprevious() is not None:  # type: ignore[attr-defined]
            del elem.getparent()[0]  # type: ignore[attr-defined]


def upsert_stage_record(conn: sqlite3.Connection, record: dict) -> None:
    values = [record.get(column) for column in STAGE_COLUMNS]
    placeholders = ",".join("?" for _ in STAGE_COLUMNS)
    updates = ",".join(
        f"{column}=excluded.{column}"
        for column in STAGE_COLUMNS
        if column not in {"jurisdiction", "serial_number", "international_class"}
    )
    conn.execute(
        f"INSERT INTO stage_records ({','.join(STAGE_COLUMNS)}) "
        f"VALUES ({placeholders}) "
        "ON CONFLICT(jurisdiction, serial_number, international_class) "
        f"DO UPDATE SET {updates}",
        values,
    )


def process_zip(
    conn: sqlite3.Connection,
    zip_path: Path,
    source_kind: str,
    source_date: str,
    expected_bytes: int | None = None,
    parser_backend: str = "lxml",
) -> dict[str, int]:
    if source_kind not in {"annual", "daily"}:
        raise ValueError("source_kind must be annual or daily")
    already = conn.execute(
        "SELECT 1 FROM completed_files WHERE file_name=?", (zip_path.name,)
    ).fetchone()
    if already:
        return {"case_files": 0, "staged_rows": 0, "skipped": 1}

    case_count = 0
    staged_count = 0
    conn.execute("BEGIN IMMEDIATE")
    try:
        with zipfile.ZipFile(zip_path) as archive:
            xml_names = [name for name in archive.namelist() if name.lower().endswith(".xml")]
            if not xml_names:
                raise RuntimeError(f"{zip_path.name} contains no XML files")
            for name in xml_names:
                with archive.open(name) as stream:
                    for case_file in iter_case_files(stream, backend=parser_backend):
                        case_count += 1
                        serial = case_serial_number(case_file)
                        if source_kind == "daily" and serial:
                            conn.execute(
                                "DELETE FROM stage_records WHERE jurisdiction='US' AND serial_number=?",
                                (serial,),
                            )
                        records = extract_trademark(case_file)
                        if records:
                            for record in records:
                                if record["mark_drawing_type"] in STAGED_TYPES:
                                    upsert_stage_record(conn, record)
                                    staged_count += 1
                        clear_element(case_file)
        conn.execute(
            """
            INSERT INTO completed_files (
              file_name, source_kind, source_date, expected_bytes,
              case_files, staged_rows, processed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                zip_path.name,
                source_kind,
                source_date,
                expected_bytes,
                case_count,
                staged_count,
                datetime.now(UTC).isoformat(timespec="seconds"),
            ),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return {"case_files": case_count, "staged_rows": staged_count, "skipped": 0}


def expected_size(info: dict) -> int | None:
    value = info.get("fileSize")
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def download_source_file(
    info: dict,
    product_id: str,
    work_dir: Path,
    api_key: str,
) -> Path:
    work_dir.mkdir(parents=True, exist_ok=True)
    name = str(info["fileName"])
    destination = work_dir / name
    size = expected_size(info)
    if destination.exists() and (size is None or destination.stat().st_size == size):
        return destination

    uri = (
        info.get("fileDownloadURI")
        or info.get("downloadUrl")
        or f"{API_BASE}/products/files/{product_id}/{name}"
    )
    partial = destination.with_suffix(destination.suffix + ".part")
    if partial.exists():
        partial.unlink()
    request = Request(str(uri), headers={"x-api-key": api_key, "Accept": "application/zip"})
    opener = build_opener(HTTPRedirectHandler)
    try:
        with opener.open(request, timeout=600) as response, partial.open("wb") as handle:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                handle.write(chunk)
    except (HTTPError, URLError, TimeoutError):
        if partial.exists():
            partial.unlink()
        raise
    if size is not None and partial.stat().st_size != size:
        actual = partial.stat().st_size
        partial.unlink()
        raise RuntimeError(f"download size mismatch for {name}: expected {size}, got {actual}")
    # Windows virus scanners and indexers can briefly retain a handle after the
    # download stream closes. Retry the atomic rename instead of discarding a
    # fully downloaded 100+ MB USPTO part.
    for attempt in range(10):
        try:
            partial.replace(destination)
            break
        except PermissionError:
            if attempt == 9:
                raise
            time.sleep(min(0.25 * (attempt + 1), 2.0))
    return destination


def source_api_key() -> str:
    key = os.environ.get("USPTO_API_KEY", "").strip()
    if key:
        return key
    from backfill_direct import read_vault_creds

    _, key = read_vault_creds()
    return key


def daily_source_files(api_key: str, from_date: str, through_date: str) -> list[dict]:
    from backfill_direct import list_files

    return list_files(api_key, from_date, through_date)


def stage_sources(
    state_db: Path,
    work_dir: Path,
    through_date: str,
    keep_downloads: bool = False,
) -> dict:
    requested_date = date.fromisoformat(through_date)
    if requested_date > date.today():
        raise ValueError("through-date cannot be in the future")
    api_key = source_api_key()
    conn = connect_state(state_db)
    started = time.time()
    try:
        cutoff, annual_files = select_latest_annual_files(list_annual_files(api_key))
        existing_cutoff = get_meta(conn, "annual_cutoff")
        if existing_cutoff and existing_cutoff != cutoff:
            raise RuntimeError(
                f"stage was built from annual cutoff {existing_cutoff}; current source is {cutoff}"
            )
        set_meta(conn, "annual_cutoff", cutoff)
        set_meta(conn, "stage_complete", "false")
        conn.commit()

        log(f"Annual cutoff {cutoff}: {len(annual_files)} ZIP parts")
        for index, info in enumerate(annual_files, 1):
            name = str(info["fileName"])
            if conn.execute(
                "SELECT 1 FROM completed_files WHERE file_name=?", (name,)
            ).fetchone():
                continue
            log(f"Annual [{index}/{len(annual_files)}] download {name}")
            path = download_source_file(info, ANNUAL_PRODUCT_ID, work_dir, api_key)
            result = process_zip(conn, path, "annual", cutoff, expected_size(info))
            log(
                f"Annual [{index}/{len(annual_files)}] processed "
                f"cases={result['case_files']:,} staged={result['staged_rows']:,}"
            )
            if not keep_downloads:
                path.unlink(missing_ok=True)

        daily_start = (date.fromisoformat(cutoff) + timedelta(days=1)).isoformat()
        daily_files = daily_source_files(api_key, daily_start, through_date)
        log(f"Daily replay {daily_start}..{through_date}: {len(daily_files)} ZIP files")
        for index, info in enumerate(daily_files, 1):
            name = str(info["fileName"])
            if conn.execute(
                "SELECT 1 FROM completed_files WHERE file_name=?", (name,)
            ).fetchone():
                continue
            log(f"Daily [{index}/{len(daily_files)}] download {name}")
            path = download_source_file(info, DAILY_PRODUCT_ID, work_dir, api_key)
            result = process_zip(conn, path, "daily", through_date, expected_size(info))
            log(
                f"Daily [{index}/{len(daily_files)}] processed "
                f"cases={result['case_files']:,} staged={result['staged_rows']:,}"
            )
            if not keep_downloads:
                path.unlink(missing_ok=True)

        set_meta(conn, "daily_through", through_date)
        set_meta(conn, "stage_complete", "true")
        set_meta(conn, "stage_completed_at", datetime.now(UTC).isoformat(timespec="seconds"))
        conn.commit()
        result = stage_summary(conn)
        result["duration_seconds"] = int(time.time() - started)
        return result
    finally:
        conn.close()


def stage_summary(conn: sqlite3.Connection) -> dict:
    counts = {
        row["mark_drawing_type"]: int(row["rows"])
        for row in conn.execute(
            "SELECT mark_drawing_type, count(*) AS rows "
            "FROM stage_records GROUP BY mark_drawing_type ORDER BY mark_drawing_type"
        )
    }
    file_counts = {
        row["source_kind"]: int(row["files"])
        for row in conn.execute(
            "SELECT source_kind, count(*) AS files "
            "FROM completed_files GROUP BY source_kind ORDER BY source_kind"
        )
    }
    total, max_row_id = conn.execute(
        "SELECT count(*), COALESCE(max(row_id), 0) FROM stage_records"
    ).fetchone()
    return {
        "stage_complete": get_meta(conn, "stage_complete") == "true",
        "annual_cutoff": get_meta(conn, "annual_cutoff"),
        "daily_through": get_meta(conn, "daily_through"),
        "record_count": int(total),
        "max_row_id": int(max_row_id),
        "records_by_type": counts,
        "completed_files": file_counts,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    stage = subparsers.add_parser("stage", help="Download and build/resume the local stage")
    stage.add_argument("--state-db", type=Path, required=True)
    stage.add_argument("--work-dir", type=Path, required=True)
    stage.add_argument("--through-date", default=date.today().isoformat())
    stage.add_argument("--keep-downloads", action="store_true")

    summary = subparsers.add_parser("summary", help="Print stage state as JSON")
    summary.add_argument("--state-db", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.command == "stage":
        result = stage_sources(
            args.state_db,
            args.work_dir,
            args.through_date,
            keep_downloads=args.keep_downloads,
        )
    else:
        conn = connect_state(args.state_db)
        try:
            result = stage_summary(conn)
        finally:
            conn.close()
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
