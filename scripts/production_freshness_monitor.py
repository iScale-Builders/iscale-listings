"""
Monitor production trademark database freshness.

This is intentionally narrower than check_international_readiness.py. It checks
the jurisdictions that are live in production today and optional automation
secret presence, then writes a concise Markdown summary suitable for GitHub
Actions issues.
"""

from __future__ import annotations

import argparse
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

DEFAULT_REQUIRED_JURISDICTIONS = ["US", "EUIPO"]
DEFAULT_SENTINEL_TEXT = "vintage cat dad shirt"
DEFAULT_SENTINEL_CLASS = "025"
DEFAULT_REQUIRED_ENV = [
    "USPTO_API_KEY",
    "TM_DB_URL",
    "EUIPO_CLIENT_ID",
    "EUIPO_CLIENT_SECRET",
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
]


@dataclass(frozen=True)
class MonitorCheck:
    name: str
    status: str
    detail: str


def parse_csv(value: str) -> list[str]:
    return [part.strip() for part in value.split(",") if part.strip()]


def add_api_key(req: Request) -> None:
    """Private deployments (REQUIRE_API_KEY=true) answer only keyed requests."""
    key = os.environ.get("TRADEMARK_API_KEY", "").strip()
    if key:
        req.add_header("X-API-Key", key)


def fetch_health(base_url: str, timeout: int) -> tuple[int, dict[str, Any] | None, str | None]:
    req = Request(f"{base_url.rstrip('/')}/api/v1/health", method="GET")
    req.add_header("Accept", "application/json")
    add_api_key(req)
    try:
        with urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8")), None
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return exc.code, None, body[:500]
    except (TimeoutError, URLError) as exc:
        return 0, None, str(exc)


def fetch_screening_check(
    base_url: str,
    text: str,
    trademark_class: str,
    jurisdictions: list[str],
    timeout: int,
) -> tuple[int, dict[str, Any] | None, str | None]:
    body = json.dumps(
        {
            "text": text,
            "classes": [trademark_class],
            "jurisdictions": jurisdictions,
            "include_dead": False,
        }
    ).encode("utf-8")
    req = Request(f"{base_url.rstrip('/')}/api/v1/check", data=body, method="POST")
    req.add_header("Accept", "application/json")
    add_api_key(req)
    req.add_header("Content-Type", "application/json")
    try:
        with urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8")), None
    except HTTPError as exc:
        response_body = exc.read().decode("utf-8", errors="replace")
        return exc.code, None, response_body[:500]
    except (TimeoutError, URLError) as exc:
        return 0, None, str(exc)


def env_checks(required_env: list[str]) -> list[MonitorCheck]:
    checks: list[MonitorCheck] = []
    for name in required_env:
        if os.environ.get(name, "").strip():
            checks.append(MonitorCheck(f"secret {name}", "pass", "present"))
        else:
            checks.append(MonitorCheck(f"secret {name}", "fail", "missing or empty in workflow env"))
    return checks


def health_checks(base_url: str, required_jurisdictions: list[str], timeout: int) -> list[MonitorCheck]:
    status, data, error = fetch_health(base_url, timeout)
    if status != 200 or not data:
        return [MonitorCheck("production health endpoint", "fail", error or f"HTTP {status}")]

    checks = [
        MonitorCheck(
            "production health endpoint",
            "pass" if data.get("status") == "ok" else "fail",
            f"status={data.get('status', 'missing')}",
        )
    ]

    schema_ready = data.get("multi_jurisdiction_schema_ready")
    if schema_ready is not None:
        checks.append(
            MonitorCheck(
                "multi-jurisdiction schema",
                "pass" if schema_ready else "fail",
                "ready" if schema_ready else "not ready",
            )
        )

    jurisdiction_rows = {
        item.get("jurisdiction"): item
        for item in data.get("jurisdictions", [])
        if isinstance(item, dict)
    }
    for jurisdiction in required_jurisdictions:
        item = jurisdiction_rows.get(jurisdiction)
        if not item:
            checks.append(MonitorCheck(f"{jurisdiction} freshness", "fail", "missing health row"))
            continue
        checks.append(jurisdiction_check(jurisdiction, item))

    return checks


def screening_checks(
    base_url: str,
    required_jurisdictions: list[str],
    sentinel_text: str,
    sentinel_class: str,
    timeout: int,
) -> list[MonitorCheck]:
    status, data, error = fetch_screening_check(
        base_url,
        sentinel_text,
        sentinel_class,
        required_jurisdictions,
        timeout,
    )
    if status != 200 or not data:
        return [MonitorCheck("production screening endpoint", "fail", error or f"HTTP {status}")]

    matches = data.get("matches")
    if not isinstance(matches, list):
        return [MonitorCheck("production screening endpoint", "fail", "malformed response: matches is not a list")]

    checks = [MonitorCheck("production screening endpoint", "pass", f"HTTP {status}")]

    raw_checked = data.get("jurisdictions_checked")
    checked = {
        value
        for value in raw_checked if isinstance(value, str)
    } if isinstance(raw_checked, list) else set()
    missing_checked = [jurisdiction for jurisdiction in required_jurisdictions if jurisdiction not in checked]
    checks.append(
        MonitorCheck(
            "screening jurisdiction coverage",
            "fail" if missing_checked else "pass",
            f"missing={','.join(missing_checked)}" if missing_checked else f"checked={','.join(sorted(checked))}",
        )
    )

    checks.append(
        MonitorCheck(
            "screening response freshness",
            "fail" if data.get("data_stale") else "pass",
            "stale" if data.get("data_stale") else "current",
        )
    )

    match_jurisdictions: set[str] = set()
    for match in matches:
        if not isinstance(match, dict):
            continue
        jurisdiction = match.get("jurisdiction", "US")
        if isinstance(jurisdiction, str):
            match_jurisdictions.add(jurisdiction)
    missing_matches = [
        jurisdiction
        for jurisdiction in required_jurisdictions
        if jurisdiction not in match_jurisdictions
    ]
    checks.append(
        MonitorCheck(
            "screening canary matches",
            "fail" if missing_matches else "pass",
            (
                f"sentinel class={sentinel_class}; missing match jurisdictions={','.join(missing_matches)}"
                if missing_matches
                else f"sentinel class={sentinel_class}; match jurisdictions={','.join(sorted(match_jurisdictions))}"
            ),
        )
    )

    official_actions = data.get("official_lookup_actions")
    fallback_count = len(official_actions) if isinstance(official_actions, list) else 0
    checks.append(
        MonitorCheck(
            "screening local-database routing",
            "fail" if fallback_count else "pass",
            f"official lookup fallbacks={fallback_count}",
        )
    )

    return checks


def jurisdiction_check(jurisdiction: str, item: dict[str, Any]) -> MonitorCheck:
    live_mark_count = item.get("live_mark_count") or 0
    sync_date = item.get("sync_date") or "n/a"
    source_updated_at = item.get("source_updated_at") or "n/a"
    last_synced_at = item.get("last_synced_at") or "n/a"
    max_age_hours = item.get("freshness_max_age_hours")
    detail = (
        f"sync_date={sync_date}; live_mark_count={live_mark_count}; "
        f"last_synced_at={last_synced_at}; source_updated_at={source_updated_at}; "
        f"max_age_hours={max_age_hours}"
    )

    if not item.get("local_database"):
        return MonitorCheck(f"{jurisdiction} freshness", "fail", f"no local database; {detail}")
    if item.get("status") != "completed":
        return MonitorCheck(f"{jurisdiction} freshness", "fail", f"status={item.get('status')}; {detail}")
    if item.get("data_stale"):
        return MonitorCheck(f"{jurisdiction} freshness", "fail", f"stale; {detail}")
    if live_mark_count <= 0:
        return MonitorCheck(f"{jurisdiction} freshness", "fail", f"empty live count; {detail}")
    return MonitorCheck(f"{jurisdiction} freshness", "pass", detail)


def failing_checks(checks: list[MonitorCheck]) -> list[MonitorCheck]:
    return [check for check in checks if check.status != "pass"]


def markdown_summary(base_url: str, checks: list[MonitorCheck]) -> str:
    failures = failing_checks(checks)
    lines = [
        "# Trademark Production Freshness Monitor",
        "",
        f"Production base URL: `{base_url.rstrip('/')}`",
        f"Status: `{'FAIL' if failures else 'PASS'}`",
        "",
        "| Check | Status | Detail |",
        "| --- | --- | --- |",
    ]
    for check in checks:
        lines.append(f"| {check.name} | {check.status.upper()} | {escape_markdown_table(check.detail)} |")
    if failures:
        lines.extend(
            [
                "",
                "## Action Needed",
                "",
                "The backend automation is not fully healthy. Check the failed rows above, then rerun the relevant sync workflow after fixing the underlying secret, source, or import issue.",
            ]
        )
    else:
        lines.extend(["", "All monitored production trademark sources are fresh."])
    return "\n".join(lines) + "\n"


def escape_markdown_table(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Monitor production trademark database freshness")
    parser.add_argument(
        "--base-url",
        required=True,
        help="Base URL of the trademark API deployment to monitor",
    )
    parser.add_argument(
        "--require-jurisdictions",
        default=",".join(DEFAULT_REQUIRED_JURISDICTIONS),
        help="Comma-separated jurisdictions that must be fresh",
    )
    parser.add_argument(
        "--require-env",
        default=",".join(DEFAULT_REQUIRED_ENV),
        help="Comma-separated env vars that must be present; use empty string to skip",
    )
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument(
        "--sentinel-text",
        default=DEFAULT_SENTINEL_TEXT,
        help="Known text expected to produce matches in every required jurisdiction",
    )
    parser.add_argument(
        "--sentinel-class",
        default=DEFAULT_SENTINEL_CLASS,
        help="International class used for the end-to-end screening canary",
    )
    parser.add_argument(
        "--skip-screening-canary",
        action="store_true",
        help="Skip the POST /api/v1/check end-to-end canary",
    )
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--markdown-output", help="Write Markdown summary to this path")
    parser.add_argument("--summary-output", help="Write one-line PASS/FAIL summary to this path")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    required_jurisdictions = parse_csv(args.require_jurisdictions)
    required_env = parse_csv(args.require_env)
    checks = [*env_checks(required_env), *health_checks(args.base_url, required_jurisdictions, args.timeout)]
    if not args.skip_screening_canary:
        checks.extend(
            screening_checks(
                args.base_url,
                required_jurisdictions,
                args.sentinel_text,
                args.sentinel_class,
                args.timeout,
            )
        )
    failures = failing_checks(checks)

    summary = markdown_summary(args.base_url, checks)
    if args.markdown_output:
        Path(args.markdown_output).write_text(summary, encoding="utf-8")
    if args.summary_output:
        status = "FAIL" if failures else "PASS"
        Path(args.summary_output).write_text(f"Trademark production freshness monitor {status}\n", encoding="utf-8")

    if args.json:
        print(
            json.dumps(
                {
                    "ok": not failures,
                    "checks": [check.__dict__ for check in checks],
                    "failures": [check.__dict__ for check in failures],
                },
                indent=2,
            )
        )
    else:
        print(summary)

    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
