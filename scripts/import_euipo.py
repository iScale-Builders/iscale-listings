"""
Import EUIPO Trademark Search API rows into the local trademarks table.

This script is ready for the EUIPO API Portal path, but it requires credentials
before it can run against live data.

Required environment variables:
    EUIPO_CLIENT_ID
    EUIPO_CLIENT_SECRET
    NEXT_PUBLIC_SUPABASE_URL
    SUPABASE_SERVICE_ROLE_KEY

Safe first run:
    python scripts/import_euipo.py --since 2026-01-01 --classes 25 --dry-run
    python scripts/import_euipo.py --since 2026-01-01 --classes 9,16,18,20,21,24,25 --page-limit 1 --dry-run

Real sample run:
    python scripts/import_euipo.py --since 2026-01-01 --classes 9,16,18,20,21,24,25 --source-updated-at 2026-05-27
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from text_normalize import normalize_text
from trademark_source_dates import normalize_official_source_date

DEFAULT_AUTH_URL = "https://euipo.europa.eu/cas-server-webapp/oidc/accessToken"
DEFAULT_API_BASE = "https://api.euipo.europa.eu/trademark-search"
# Large merge-duplicates upserts against the multi-million-row trademarks table
# hit Supabase/Postgres statement_timeout (SQLSTATE 57014). Production failures
# 2026-06-29 and 2026-07-27 both aborted mid-import on batch size 500. Prefer
# smaller batches; upsert_batch still auto-splits on timeout.
DEFAULT_BATCH_SIZE = 100
# Statement-timeout bodies from PostgREST / Postgres.
STATEMENT_TIMEOUT_MARKERS = (
    "57014",
    "statement timeout",
    "canceling statement due to statement timeout",
)
EUIPO_STATUSES = [
    "ACCEPTED",
    "APPEALED",
    "APPLICATION_PUBLISHED",
    "CANCELLATION_PENDING",
    "CANCELLED",
    "EXPIRED",
    "OPPOSITION_PENDING",
    "RECEIVED",
    "REFUSED",
    "REGISTERED",
    "REGISTRATION_PENDING",
    "REMOVED_FROM_REGISTER",
    "START_OF_OPPOSITION_PERIOD",
    "SURRENDERED",
    "UNDER_EXAMINATION",
    "WITHDRAWN",
]
EUIPO_LIVE_STATUSES = {
    "ACCEPTED",
    "APPLICATION_PUBLISHED",
    "CANCELLATION_PENDING",
    "OPPOSITION_PENDING",
    "RECEIVED",
    "REGISTERED",
    "REGISTRATION_PENDING",
    "START_OF_OPPOSITION_PERIOD",
    "UNDER_EXAMINATION",
}
# Explicitly-dead statuses. map_status() fails CLOSED against this set: anything
# NOT listed here (including APPEALED, an unknown new EUIPO status, or a missing
# status) is treated as LIVE so it still screens. Enumerating "dead" instead of
# "live" prevents a live-but-unrecognized mark from being silently excluded from
# include_dead=false queries — a false "clear", the worst screener failure.
EUIPO_DEAD_STATUSES = {
    "CANCELLED",
    "EXPIRED",
    "REFUSED",
    "REMOVED_FROM_REGISTER",
    "SURRENDERED",
    "WITHDRAWN",
}
EUIPO_STATUS_CODES = {
    "ACCEPTED": "ACCEPTED",
    "APPEALED": "APPEALED",
    "APPLICATION_PUBLISHED": "APP_PUB",
    "CANCELLATION_PENDING": "CANC_PEND",
    "CANCELLED": "CANCELLED",
    "EXPIRED": "EXPIRED",
    "OPPOSITION_PENDING": "OPP_PEND",
    "RECEIVED": "RECEIVED",
    "REFUSED": "REFUSED",
    "REGISTERED": "REG",
    "REGISTRATION_PENDING": "REG_PEND",
    "REMOVED_FROM_REGISTER": "REMOVED",
    "START_OF_OPPOSITION_PERIOD": "OPP_START",
    "SURRENDERED": "SURRENDER",
    "UNDER_EXAMINATION": "EXAM",
    "WITHDRAWN": "WITHDRAWN",
}


@dataclass(frozen=True)
class Config:
    euipo_client_id: str
    euipo_client_secret: str
    supabase_url: str
    supabase_service_key: str
    auth_url: str
    api_base: str
    # TM_DB_URL: write straight to PostgreSQL (self-hosted, no Supabase).
    db_url: str = ""


_DB_CONN: Any = None


def db_conn(config: Config) -> Any:
    """One autocommit psycopg2 connection per run (direct-PostgreSQL mode)."""
    global _DB_CONN
    if _DB_CONN is None:
        import psycopg2  # only needed in direct mode

        _DB_CONN = psycopg2.connect(config.db_url, connect_timeout=25)
        _DB_CONN.autocommit = True
    return _DB_CONN



def log(message: str) -> None:
    timestamp = datetime.now(UTC).strftime("%H:%M:%S")
    print(f"[{timestamp}] {message}", flush=True)


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        print(f"ERROR: {name} is required", file=sys.stderr)
        sys.exit(1)
    return value


def resolve_source_updated_at(value: str | None, dry_run: bool) -> str:
    if value and value.strip():
        return normalize_official_source_date(value, "--source-updated-at")
    if dry_run:
        return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
    print("ERROR: --source-updated-at is required for real imports", file=sys.stderr)
    print("Use the official EUIPO response/export, catalogue, or update date.", file=sys.stderr)
    sys.exit(1)


def load_config(dry_run: bool) -> Config:
    db_url = os.environ.get("TM_DB_URL", "").strip()
    direct = bool(db_url) or dry_run
    return Config(
        euipo_client_id=require_env("EUIPO_CLIENT_ID"),
        euipo_client_secret=require_env("EUIPO_CLIENT_SECRET"),
        supabase_url=("" if direct else require_env("NEXT_PUBLIC_SUPABASE_URL").rstrip("/")),
        supabase_service_key=("" if direct else require_env("SUPABASE_SERVICE_ROLE_KEY")),
        db_url=db_url,
        auth_url=os.environ.get("EUIPO_AUTH_URL", DEFAULT_AUTH_URL),
        api_base=os.environ.get("EUIPO_API_BASE", DEFAULT_API_BASE).rstrip("/"),
    )


def http_json(req: Request, timeout: int = 120) -> dict[str, Any]:
    try:
        with urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        print(f"HTTP {exc.code}: {body[:1000]}", file=sys.stderr)
        raise
    except URLError as exc:
        print(f"Network error: {exc}", file=sys.stderr)
        raise


def get_access_token(config: Config) -> str:
    body = urlencode(
        {
            "client_id": config.euipo_client_id,
            "client_secret": config.euipo_client_secret,
            "grant_type": "client_credentials",
            "scope": "uid",
        }
    ).encode("utf-8")

    req = Request(config.auth_url, data=body, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    data = http_json(req)
    token = data.get("access_token")
    if not isinstance(token, str) or not token:
        raise RuntimeError("EUIPO token response did not include access_token")
    return token


def build_query(since: str, class_filter: int | None, statuses: list[str]) -> str:
    parts = ["markFeature==WORD", f"updateDate>={since}"]
    if class_filter is not None:
        # EUIPO `all=(...)` is safe for a single class. For multiple classes the
        # importer runs one query per class so "any requested class" does not
        # accidentally become "every requested class".
        parts.append(f"niceClasses=all=({class_filter})")
    if statuses:
        parts.append(f"status=in=({','.join(statuses)})")
    return " and ".join(parts)


def search_page(
    config: Config,
    token: str,
    query: str,
    page: int,
    size: int,
) -> dict[str, Any]:
    params = {
        "query": query,
        "page": str(page),
        "size": str(size),
        "fields": (
            "trademarks(applicationNumber,markFeature,markKind,markBasis,"
            "niceClasses,wordMarkSpecification,status,applicationDate,"
            "registrationDate,expiryDate,applicants),page,size,totalElements,totalPages"
        ),
    }
    req = Request(f"{config.api_base}/trademarks?{urlencode(params)}", method="GET")
    req.add_header("Accept", "application/json")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("X-IBM-Client-Id", config.euipo_client_id)
    return http_json(req)


class PageUnavailable(RuntimeError):
    """A page could not be fetched after exhausting retries.

    EUIPO occasionally returns a persistent HTTP 5xx for one specific
    offset (a record their backend cannot serialize). That must not abort
    a multi-hour import, so the caller skips the page and continues.
    """

    def __init__(self, page: int, status_code: int) -> None:
        super().__init__(f"EUIPO page {page + 1} unavailable after retries (HTTP {status_code})")
        self.page = page
        self.status_code = status_code


def search_page_with_retries(
    config: Config,
    token_ref: list[str],
    query: str,
    page: int,
    size: int,
    retries: int,
    retry_delay_seconds: float,
) -> dict[str, Any]:
    attempt = 0
    while True:
        try:
            return search_page(config, token_ref[0], query, page, size)
        except HTTPError as exc:
            attempt += 1
            # The OAuth access token expires (typically ~1h) long before a full
            # multi-hour import finishes. Refresh it on 401/403 instead of
            # crashing, so a long run can complete without manual resume.
            if exc.code in (401, 403):
                if attempt > retries:
                    raise PageUnavailable(page, exc.code) from exc
                log(f"EUIPO page {page + 1} returned HTTP {exc.code}; refreshing access token (attempt {attempt}/{retries})")
                try:
                    token_ref[0] = get_access_token(config)
                except (HTTPError, URLError, RuntimeError) as refresh_exc:
                    if attempt > retries:
                        raise PageUnavailable(page, exc.code) from refresh_exc
                    log(f"EUIPO token refresh failed: {refresh_exc}; will retry")
                time.sleep(min(retry_delay_seconds * attempt, 30.0))
                continue
            if exc.code < 500 and exc.code != 429:
                raise
            if attempt > retries:
                raise PageUnavailable(page, exc.code) from exc
            delay = min(retry_delay_seconds * attempt, 90.0)
            log(f"EUIPO page {page + 1} returned HTTP {exc.code}; retry {attempt}/{retries} in {delay:.1f}s")
            time.sleep(delay)
        except (URLError, TimeoutError, OSError) as exc:
            # Network-level failure: read timeout, connection reset, DNS, etc.
            # EUIPO sometimes hangs mid-import; treat like a transient 5xx -
            # retry, then skip the page so one hang cannot kill the whole run.
            attempt += 1
            if attempt > retries:
                raise PageUnavailable(page, -1) from exc
            delay = min(retry_delay_seconds * attempt, 90.0)
            log(f"EUIPO page {page + 1} network error ({exc}); retry {attempt}/{retries} in {delay:.1f}s")
            time.sleep(delay)


def map_status(status: str | None) -> tuple[str, str | None]:
    # Fail closed: only an explicitly dead status maps to DEAD. A missing or
    # unrecognized status defaults to LIVE so it over-flags rather than silently
    # clearing. (EUIPO_LIVE_STATUSES is retained as the documented live set.)
    if not status:
        return "LIVE", None
    status_code = EUIPO_STATUS_CODES.get(status, status[:10])
    return ("DEAD" if status in EUIPO_DEAD_STATUSES else "LIVE", status_code)


def first_owner_name(item: dict[str, Any]) -> str | None:
    applicants = item.get("applicants")
    if not isinstance(applicants, list) or not applicants:
        return None
    first = applicants[0]
    if not isinstance(first, dict):
        return None
    name = first.get("name")
    return name if isinstance(name, str) and name.strip() else None


def to_records(
    item: dict[str, Any],
    source_updated_at: str,
    included_classes: set[int] | None,
) -> list[dict[str, Any]]:
    application_number = item.get("applicationNumber")
    wordmark = (item.get("wordMarkSpecification") or {}).get("verbalElement")
    nice_classes = item.get("niceClasses") or []

    if not application_number or not wordmark or not nice_classes:
        return []

    local_status, status_code = map_status(item.get("status"))
    base = {
        "jurisdiction": "EUIPO",
        "source": "euipo-trademark-search",
        "source_updated_at": source_updated_at,
        "serial_number": str(application_number),
        "registration_number": None,
        "wordmark": str(wordmark).strip(),
        "wordmark_normalized": normalize_text(str(wordmark)),
        "mark_drawing_type": item.get("markFeature") or "WORD",
        "status": local_status,
        "status_code": status_code,
        "filing_date": item.get("applicationDate"),
        "registration_date": item.get("registrationDate"),
        "owner_name": first_owner_name(item),
    }

    records = []
    for nice_class in nice_classes:
        if not isinstance(nice_class, int):
            continue
        if included_classes is not None and nice_class not in included_classes:
            continue
        records.append({**base, "international_class": str(nice_class).zfill(3)})
    return records


def append_unique_records(
    batch: list[dict[str, Any]],
    seen_keys: set[tuple[str, str, str]],
    records: list[dict[str, Any]],
) -> None:
    for record in records:
        key = (
            str(record["jurisdiction"]),
            str(record["serial_number"]),
            str(record["international_class"]),
        )
        if key in seen_keys:
            continue
        seen_keys.add(key)
        batch.append(record)


StartPageKey = tuple[int | None, str | None]


def parse_start_pages(values: list[str] | None) -> dict[StartPageKey, int]:
    result: dict[StartPageKey, int] = {}
    for value in values or []:
        if "=" not in value:
            raise ValueError("--start-page values must be CLASS=PAGE, CLASS:STATUS=PAGE, or all=PAGE")
        raw_scope, raw_page = value.split("=", 1)
        raw_scope_parts = raw_scope.split(":", 1)
        raw_class = raw_scope_parts[0].strip().lower()
        raw_status = raw_scope_parts[1].strip().upper() if len(raw_scope_parts) == 2 else None
        raw_class = raw_class.strip().lower()
        raw_page = raw_page.strip()
        if raw_class == "all":
            class_filter = None
        else:
            class_filter = int(raw_class)
        if raw_status is not None and raw_status not in EUIPO_STATUSES:
            raise ValueError(f"unknown --start-page status value: {raw_status}")
        page = int(raw_page)
        if page < 1:
            raise ValueError("--start-page PAGE values are 1-based and must be at least 1")
        result[(class_filter, raw_status)] = page - 1
    return result


def start_page_for(start_pages: dict[StartPageKey, int], class_filter: int | None, current_statuses: list[str]) -> int:
    status = current_statuses[0] if len(current_statuses) == 1 else None
    return start_pages.get((class_filter, status), start_pages.get((class_filter, None), 0))


def status_filters(statuses: list[str], partition: bool) -> list[list[str]]:
    selected = statuses or EUIPO_STATUSES
    if partition:
        return [[status] for status in selected]
    return [selected] if statuses else [[]]


def is_statement_timeout_body(body: str) -> bool:
    """True when a Supabase/PostgREST error body is a Postgres statement timeout."""
    lowered = body.lower()
    return any(marker in lowered for marker in STATEMENT_TIMEOUT_MARKERS)


def split_upsert_batch(records: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Bisect a batch so a timed-out upsert can retry as two smaller writes."""
    if len(records) < 2:
        raise ValueError("split_upsert_batch requires at least 2 records")
    mid = len(records) // 2
    return records[:mid], records[mid:]


def format_resume_hint(
    since: str,
    classes: list[int],
    class_filter: int | None,
    status_label: str,
    page_1_based: int,
    batch_size: int,
) -> str:
    """Human-readable re-run command after a mid-import write failure.

    Upserts are idempotent (on_conflict merge), so re-running from the failed
    class/status page is safe. Prefer a smaller --batch-size if timeouts persist.
    """
    status_scope = ""
    if status_label and status_label not in ("all statuses",):
        # Only a single status is used when --partition-statuses is on.
        first_status = status_label.split(",")[0].strip()
        if first_status and first_status in EUIPO_STATUSES:
            status_scope = f":{first_status}"
    start_page_arg = f"{class_filter if class_filter is not None else 'all'}{status_scope}={page_1_based}"
    smaller = max(1, min(batch_size, 25))
    class_arg = ",".join(str(c) for c in classes) if classes else "25"
    return (
        "Resume with a smaller write batch (upserts are idempotent):\n"
        f"  python scripts/import_euipo.py --since {since} "
        f"--classes {class_arg} --partition-statuses "
        f"--batch-size {smaller} --start-page {start_page_arg} "
        f"--source-updated-at <official-date>"
    )


def pg_trademark_upsert(config: Config, records: list[dict[str, Any]]) -> None:
    """Direct-PostgreSQL upsert with the same conflict key as the Supabase path."""
    from psycopg2.extras import execute_values

    cols = list(records[0].keys())
    key = ("jurisdiction", "serial_number", "international_class")
    updates = ", ".join(f"{c} = EXCLUDED.{c}" for c in cols if c not in key)
    sql = (
        f"INSERT INTO trademarks ({', '.join(cols)}) VALUES %s "
        f"ON CONFLICT ({', '.join(key)}) DO UPDATE SET {updates}"
    )
    # Last write wins when one page repeats a key (same as merge-duplicates).
    unique = {tuple(r[k] for k in key): r for r in records}
    with db_conn(config).cursor() as cur:
        execute_values(cur, sql, [tuple(r[c] for c in cols) for r in unique.values()], page_size=500)


def post_trademark_upsert(config: Config, records: list[dict[str, Any]]) -> None:
    """POST one upsert payload to Supabase. Raises HTTPError on non-2xx."""
    if config.db_url:
        pg_trademark_upsert(config, records)
        return
    url = (
        f"{config.supabase_url}/rest/v1/trademarks"
        "?on_conflict=jurisdiction,serial_number,international_class"
    )
    body = json.dumps(records).encode("utf-8")
    req = Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("apikey", config.supabase_service_key)
    req.add_header("Authorization", f"Bearer {config.supabase_service_key}")
    req.add_header("Prefer", "resolution=merge-duplicates")
    with urlopen(req, timeout=120) as resp:
        resp.read()


def upsert_batch(
    config: Config,
    records: list[dict[str, Any]],
    dry_run: bool,
    *,
    post_fn: Any | None = None,
    depth: int = 0,
) -> int:
    """Upsert records, auto-splitting on Postgres statement_timeout.

    Production root cause (GitHub Actions weekly EUIPO refresh, run
    30264959876 on 2026-07-27 and 28373763132 on 2026-06-29): a single
    merge-duplicates POST of ~500 rows returned HTTP 500 / SQLSTATE 57014 and
    aborted the whole import before sync_metadata could be written, leaving
    EUIPO freshness stale. On timeout we bisect the batch and retry; a final
    single-row timeout still fails loud.
    """
    if not records:
        return 0
    if dry_run:
        return len(records)

    writer = post_fn or post_trademark_upsert
    try:
        writer(config, records)
        return len(records)
    except HTTPError as exc:
        body_text = exc.read().decode("utf-8", errors="replace")
        timed_out = is_statement_timeout_body(body_text)
        if timed_out and len(records) > 1:
            left, right = split_upsert_batch(records)
            log(
                f"Supabase upsert statement_timeout on {len(records)} rows "
                f"(depth {depth}); splitting into {len(left)}+{len(right)}"
            )
            return upsert_batch(
                config, left, dry_run, post_fn=writer, depth=depth + 1
            ) + upsert_batch(
                config, right, dry_run, post_fn=writer, depth=depth + 1
            )
        print(
            f"ERROR: Supabase trademark upsert returned HTTP {exc.code}: {body_text[:1000]}",
            file=sys.stderr,
        )
        raise


def insert_sync_metadata(
    config: Config,
    live_count: int,
    marks_added: int,
    duration: int,
    source_updated_at: str,
    dry_run: bool,
) -> None:
    if dry_run:
        return

    record = {
        "sync_date": datetime.now(UTC).strftime("%Y-%m-%d"),
        "jurisdiction": "EUIPO",
        "source": "euipo-trademark-search",
        "source_updated_at": source_updated_at,
        "live_mark_count": live_count,
        "marks_added": marks_added,
        "marks_updated": 0,
        "marks_status_changed": 0,
        "sync_duration_seconds": duration,
        "status": "completed",
    }
    if config.db_url:
        cols = list(record.keys())
        with db_conn(config).cursor() as cur:
            cur.execute(
                f"INSERT INTO sync_metadata ({', '.join(cols)}) VALUES ({', '.join(['%s'] * len(cols))})",
                [record[c] for c in cols],
            )
        return
    body = json.dumps(record).encode("utf-8")
    req = Request(f"{config.supabase_url}/rest/v1/sync_metadata", data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("apikey", config.supabase_service_key)
    req.add_header("Authorization", f"Bearer {config.supabase_service_key}")
    try:
        with urlopen(req, timeout=60) as resp:
            resp.read()
    except HTTPError as exc:
        body_text = exc.read().decode("utf-8", errors="replace")
        print(f"ERROR: Supabase sync_metadata insert returned HTTP {exc.code}: {body_text[:1000]}", file=sys.stderr)
        raise


def count_live(config: Config, dry_run: bool) -> int:
    if dry_run:
        return 0
    # Use an ESTIMATED count. An exact count over the (now large) EUIPO LIVE set
    # exceeds Supabase's statement timeout and returns HTTP 500, which previously
    # crashed the run *after* all data was imported but *before* sync_metadata was
    # written - leaving the data present with no completed sync row. Estimated
    # count is fast, and any failure here is non-fatal so the completed sync row
    # is always recorded.
    if config.db_url:
        import psycopg2

        try:
            with db_conn(config).cursor() as cur:
                cur.execute("SELECT count(*) FROM trademarks WHERE jurisdiction = 'EUIPO' AND status = 'LIVE'")
                return int(cur.fetchone()[0])
        except (psycopg2.Error, OSError, ValueError) as exc:  # non-fatal, same as the Supabase path
            log(f"WARNING: EUIPO live count failed ({exc}); recording sync with live_count=0")
            return 0
    url = (
        f"{config.supabase_url}/rest/v1/trademarks"
        "?jurisdiction=eq.EUIPO&status=eq.LIVE&select=serial_number&limit=1"
    )
    req = Request(url, method="GET")
    req.add_header("apikey", config.supabase_service_key)
    req.add_header("Authorization", f"Bearer {config.supabase_service_key}")
    req.add_header("Prefer", "count=estimated")
    try:
        with urlopen(req, timeout=120) as resp:
            resp.read()
            content_range = resp.headers.get("Content-Range", "")
            tail = content_range.split("/")[-1] if "/" in content_range else ""
            return int(tail) if tail.isdigit() else 0
    except (HTTPError, URLError, OSError, ValueError) as exc:
        log(f"WARNING: EUIPO live count failed ({exc}); recording sync with live_count=0")
        return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Import EUIPO trademark records")
    parser.add_argument("--since", required=True, help="Minimum updateDate, yyyy-MM-dd")
    parser.add_argument("--classes", default="25", help="Comma-separated Nice classes, e.g. 9,18,25")
    parser.add_argument("--statuses", default="", help="Comma-separated EUIPO statuses; empty imports all statuses")
    parser.add_argument(
        "--partition-statuses",
        action="store_true",
        help="Run one query per status; useful when EUIPO all-status pagination fails",
    )
    parser.add_argument("--page-size", type=int, default=100, help="EUIPO page size")
    parser.add_argument("--page-limit", type=int, default=0, help="Maximum pages to import; 0 means all")
    parser.add_argument(
        "--batch-size",
        type=int,
        default=DEFAULT_BATCH_SIZE,
        help=(
            f"Supabase upsert batch size (default {DEFAULT_BATCH_SIZE}; "
            "auto-splits further on statement_timeout)"
        ),
    )
    parser.add_argument("--log-every", type=int, default=1, help="Log every N pages per class")
    parser.add_argument("--retries", type=int, default=5, help="Retries for transient EUIPO page fetch failures")
    parser.add_argument("--retry-delay-seconds", type=float, default=5.0, help="Base retry delay for transient EUIPO failures")
    parser.add_argument(
        "--start-page",
        action="append",
        help="Resume at a 1-based EUIPO page, e.g. --start-page 9=1000 or --start-page 9:REGISTERED=1200",
    )
    parser.add_argument("--source-updated-at", help="ISO timestamp/date from the official EUIPO source")
    parser.add_argument(
        "--max-consecutive-failures",
        type=int,
        default=3,
        help="Abort if this many pages fail in a row after retries (likely an EUIPO outage, not isolated bad pages)",
    )
    parser.add_argument("--dry-run", action="store_true", help="Fetch and map data but do not write to Supabase")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.page_limit and not args.dry_run:
        print(
            "ERROR: --page-limit is only allowed with --dry-run; real EUIPO imports must not write partial datasets",
            file=sys.stderr,
        )
        sys.exit(1)
    if args.page_size < 1 or args.page_size > 100:
        print("ERROR: --page-size must be between 1 and 100 for EUIPO Trademark Search", file=sys.stderr)
        sys.exit(1)
    if args.log_every < 1:
        print("ERROR: --log-every must be at least 1", file=sys.stderr)
        sys.exit(1)
    if args.retries < 0:
        print("ERROR: --retries must not be negative", file=sys.stderr)
        sys.exit(1)
    if args.retry_delay_seconds < 0:
        print("ERROR: --retry-delay-seconds must not be negative", file=sys.stderr)
        sys.exit(1)
    if args.batch_size < 1:
        print("ERROR: --batch-size must be at least 1", file=sys.stderr)
        sys.exit(1)
    try:
        start_pages = parse_start_pages(args.start_page)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
    source_updated_at = resolve_source_updated_at(args.source_updated_at, args.dry_run)
    classes = [int(part) for part in args.classes.split(",") if part.strip()]
    included_classes = set(classes) if classes else None
    class_filters: list[int | None] = classes or [None]
    statuses = [part.strip() for part in args.statuses.split(",") if part.strip()]
    unknown_statuses = sorted(set(statuses) - set(EUIPO_STATUSES))
    if unknown_statuses:
        print(f"ERROR: unknown EUIPO status value(s): {', '.join(unknown_statuses)}", file=sys.stderr)
        print(f"Allowed values: {', '.join(EUIPO_STATUSES)}", file=sys.stderr)
        sys.exit(1)
    per_status_filters = status_filters(statuses, args.partition_statuses)
    config = load_config(args.dry_run)
    token_ref = [get_access_token(config)]

    start = time.time()
    total_records = 0
    batch: list[dict[str, Any]] = []
    seen_keys: set[tuple[str, str, str]] = set()
    skipped_pages: list[tuple[int | None, str, int, int]] = []
    consecutive_skips = 0
    # Progress cursor for resume hints if a write still fails after splitting.
    progress_class: int | None = None
    progress_status = "all statuses"
    progress_page_1_based = 1

    try:
        for class_filter in class_filters:
            for current_statuses in per_status_filters:
                query = build_query(args.since, class_filter, current_statuses)
                status_label = ",".join(current_statuses) if current_statuses else "all statuses"
                progress_class = class_filter
                progress_status = status_label
                log(f"EUIPO query: {query}")
                page = start_page_for(start_pages, class_filter, current_statuses)
                if page:
                    log(
                        f"Resuming class {class_filter if class_filter is not None else 'all'} "
                        f"status {status_label} at page {page + 1}"
                    )

                class_label = f"class {class_filter}" if class_filter is not None else "all classes"
                total_pages = 0
                while True:
                    progress_page_1_based = page + 1
                    try:
                        result = search_page_with_retries(
                            config,
                            token_ref,
                            query,
                            page,
                            args.page_size,
                            args.retries,
                            args.retry_delay_seconds,
                        )
                    except PageUnavailable as exc:
                        # A persistent EUIPO 5xx on one offset must not kill the whole
                        # import. Skip the page, record the gap, and continue. Abort
                        # only if many pages fail in a row (a real outage).
                        log(
                            f"SKIPPING {class_label} {status_label} page {page + 1} "
                            f"after retries (HTTP {exc.status_code})"
                        )
                        skipped_pages.append((class_filter, status_label, page + 1, exc.status_code))
                        consecutive_skips += 1
                        if consecutive_skips > args.max_consecutive_failures:
                            print(
                                f"ERROR: aborting after {consecutive_skips} consecutive page failures "
                                f"(likely an EUIPO outage, not isolated bad pages)",
                                file=sys.stderr,
                            )
                            sys.exit(1)
                        page += 1
                        if args.page_limit and page >= args.page_limit:
                            break
                        if total_pages and page >= total_pages:
                            break
                        continue

                    consecutive_skips = 0
                    trademarks = result.get("trademarks") or []
                    total_pages = int(result.get("totalPages") or total_pages)
                    if (
                        page == 0
                        or ((page + 1) % args.log_every == 0)
                        or (total_pages and page + 1 >= total_pages)
                    ):
                        log(
                            f"{class_label} {status_label} page {page + 1}/"
                            f"{total_pages or '?'}: {len(trademarks)} trademarks"
                        )

                    for item in trademarks:
                        append_unique_records(
                            batch, seen_keys, to_records(item, source_updated_at, included_classes)
                        )
                        if len(batch) >= args.batch_size:
                            total_records += upsert_batch(config, batch, args.dry_run)
                            batch = []

                    page += 1
                    if args.page_limit and page >= args.page_limit:
                        break
                    if total_pages and page >= total_pages:
                        break
                    if not trademarks:
                        break

        if batch:
            total_records += upsert_batch(config, batch, args.dry_run)
    except HTTPError:
        print(
            format_resume_hint(
                args.since,
                classes,
                progress_class,
                progress_status,
                progress_page_1_based,
                args.batch_size,
            ),
            file=sys.stderr,
        )
        raise

    live_count = count_live(config, args.dry_run)
    duration = int(time.time() - start)
    insert_sync_metadata(config, live_count, total_records, duration, source_updated_at, args.dry_run)
    log(f"Imported records: {total_records:,}")
    log(f"EUIPO live count: {live_count:,}")
    log(f"Duration seconds: {duration}")
    if skipped_pages:
        log(f"WARNING: {len(skipped_pages)} page(s) skipped after exhausted retries (EUIPO server errors):")
        for cf, st, pg, code in skipped_pages:
            log(f"  - class {cf if cf is not None else 'all'} status {st} page {pg} (HTTP {code})")
        log("These pages were not imported. Counts above exclude them; re-run later to backfill.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, HTTPError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
