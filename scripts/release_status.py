"""
Summarize current release readiness without mutating files, Git, or deployments.

This wraps the quick final preflight and turns its gate output into a compact
status report for the one-clean-push/deploy package.
"""

from __future__ import annotations

import argparse
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class ReleaseBlocker:
    gate: str
    detail: str


def run_quick_preflight(base_url: str, as_of: str | None = None) -> tuple[int, dict[str, Any]]:
    command = [
        "python",
        "scripts/final_preflight.py",
        "--base-url",
        base_url,
        "--skip-heavy",
        "--keep-going",
        "--json",
    ]
    if as_of:
        command.extend(["--as-of", as_of])

    completed = subprocess.run(
        command,
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError:
        payload = {
            "ok": False,
            "results": [
                {
                    "name": "final preflight",
                    "status": "fail",
                    "detail": (completed.stdout + "\n" + completed.stderr).strip(),
                }
            ],
        }
    return completed.returncode, payload


def collect_blockers(payload: dict[str, Any]) -> list[ReleaseBlocker]:
    blockers: list[ReleaseBlocker] = []
    for result in payload.get("results", []):
        if result.get("status") == "fail":
            blockers.append(
                ReleaseBlocker(
                    gate=str(result.get("name", "unknown")),
                    detail=str(result.get("detail", "")).strip(),
                )
            )
    return blockers


def print_table(payload: dict[str, Any], blockers: list[ReleaseBlocker]) -> None:
    print(f"Release status: {'READY' if not blockers else 'NOT READY'}")
    print()
    for result in payload.get("results", []):
        status = str(result.get("status", "unknown")).upper()
        name = str(result.get("name", "unknown"))
        print(f"- {name}: {status}")
    if blockers:
        print()
        print("Blocking gates:")
        for blocker in blockers:
            print(f"- {blocker.gate}")
            if blocker.detail:
                for line in actionable_detail_lines(blocker.detail):
                    print(f"  {line}")


def actionable_detail_lines(detail: str, limit: int = 4) -> list[str]:
    skipped_prefixes = ("ok:", "complete:", "as_of:")
    lines = [
        line
        for line in detail.splitlines()
        if line.strip() and not line.strip().startswith(skipped_prefixes)
    ]
    selected = lines[:limit] or [line for line in detail.splitlines() if line.strip()][:limit]
    if len(lines) > limit:
        selected.append(f"... {len(lines) - limit} more detail line(s)")
    return selected


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Summarize release readiness without mutating state")
    parser.add_argument("--base-url", default="http://localhost:3000", help="Your trademark API, for the US + EU data freshness gate")
    parser.add_argument("--as-of", help="Recorded in the output (no gate depends on it any more)")
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of a table")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    exit_code, payload = run_quick_preflight(args.base_url, args.as_of)
    blockers = collect_blockers(payload)
    output = {
        "ready": not blockers,
        "preflight_exit_code": exit_code,
        "base_url": payload.get("base_url", args.base_url),
        "as_of": payload.get("as_of", args.as_of),
        "blockers": [blocker.__dict__ for blocker in blockers],
        "results": payload.get("results", []),
    }

    if args.json:
        print(json.dumps(output, indent=2))
    else:
        print_table(payload, blockers)

    if blockers:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
