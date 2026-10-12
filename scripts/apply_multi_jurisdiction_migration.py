"""
Apply the multi-jurisdiction Supabase migration through the Supabase Management API.

This runner is intentionally narrow: it only applies
supabase/migrations/006_prepare_multi_jurisdiction.sql from this repository.

Required for execution:
    SUPABASE_ACCESS_TOKEN
    SUPABASE_PROJECT_REF

Dry run:
    python scripts/apply_multi_jurisdiction_migration.py

Execute after approval:
    python scripts/apply_multi_jurisdiction_migration.py --execute
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


REPO_ROOT = Path(__file__).resolve().parents[1]
MIGRATION_PATH = REPO_ROOT / "supabase" / "migrations" / "006_prepare_multi_jurisdiction.sql"
SUPABASE_API_BASE = "https://api.supabase.com/v1"


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        print(f"ERROR: {name} is required with --execute", file=sys.stderr)
        sys.exit(1)
    return value


def migration_sql() -> str:
    if not MIGRATION_PATH.exists():
        raise FileNotFoundError(MIGRATION_PATH)
    return MIGRATION_PATH.read_text(encoding="utf-8")


def fingerprint(sql: str) -> str:
    return hashlib.sha256(sql.encode("utf-8")).hexdigest()[:16]


def execute_query(project_ref: str, access_token: str, sql: str) -> str:
    url = f"{SUPABASE_API_BASE}/projects/{project_ref}/database/query"
    body = json.dumps({"query": sql, "read_only": False}).encode("utf-8")
    req = Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", f"Bearer {access_token}")

    try:
        with urlopen(req, timeout=120) as resp:
            payload = resp.read().decode("utf-8", errors="replace")
            return f"HTTP {resp.status}: {payload[:500]}"
    except HTTPError as exc:
        payload = exc.read().decode("utf-8", errors="replace")
        return f"HTTP {exc.code}: {payload[:1000]}"
    except (URLError, TimeoutError) as exc:
        return f"ERROR: {exc}"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Apply migration 006 via Supabase Management API")
    parser.add_argument("--execute", action="store_true", help="Actually run the migration")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    sql = migration_sql()
    print(f"Migration: {MIGRATION_PATH.relative_to(REPO_ROOT)}")
    print(f"Bytes: {len(sql.encode('utf-8'))}")
    print(f"SHA256 prefix: {fingerprint(sql)}")

    if not args.execute:
        print("Dry run only. Re-run with --execute after production DB approval.")
        return

    project_ref = require_env("SUPABASE_PROJECT_REF")
    access_token = require_env("SUPABASE_ACCESS_TOKEN")
    result = execute_query(project_ref, access_token, sql)
    print(result)


if __name__ == "__main__":
    main()
