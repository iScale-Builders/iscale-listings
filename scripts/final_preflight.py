"""
Run the final iScale Listings release/deploy preflight.

This is the command to use before the one clean GitHub push/deploy package. It
does not stage, commit, push, or deploy anything. It only runs gates and reports
which ones passed, failed, or were skipped.

Examples:
    python scripts/final_preflight.py --keep-going
    python scripts/final_preflight.py --skip-heavy --keep-going --json
    python scripts/final_preflight.py --list
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
NPM = "npm.cmd" if os.name == "nt" else "npm"


@dataclass(frozen=True)
class Gate:
    name: str
    command: list[str]
    heavy: bool = False


@dataclass(frozen=True)
class GateResult:
    name: str
    status: str
    exit_code: int | None
    command: str
    detail: str


def build_gates(base_url: str, as_of: str | None = None) -> list[Gate]:
    # US + EU only (Jose, 2026-10-01): the national-source gates (access waits,
    # follow-ups, delivery manifests, international completion) were removed.
    # `as_of` is accepted for compatibility; no remaining gate uses it.
    return [
        Gate("migration dry-run", [NPM, "run", "db:migration:dry-run"]),
        Gate("git hygiene", [NPM, "run", "git:hygiene", "--", "--json"]),
        Gate("git sync status", [NPM, "run", "git:status", "--", "--json"]),
        Gate(
            "data freshness (US + EU)",
            [
                "python",
                "scripts/production_freshness_monitor.py",
                "--base-url",
                base_url,
                "--require-jurisdictions",
                "US,EUIPO",
                "--require-env",
                "",
                "--json",
            ],
        ),
        Gate("unit/type/sdk verification", [NPM, "run", "test:verify"], heavy=True),
        Gate("production build", [NPM, "run", "build"], heavy=True),
        Gate("browser e2e", [NPM, "run", "test:e2e"], heavy=True),
    ]


def command_text(command: list[str]) -> str:
    return " ".join(command)


def extract_json_object(text: str) -> dict[str, Any] | None:
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end < start:
        return None
    try:
        payload = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None
    return payload if isinstance(payload, dict) else None


def summarize_json_payload(payload: dict[str, Any]) -> str | None:
    lines: list[str] = []

    if "ok" in payload:
        lines.append(f"ok: {str(bool(payload.get('ok'))).lower()}")
    if "complete" in payload:
        lines.append(f"complete: {str(bool(payload.get('complete'))).lower()}")
    if isinstance(payload.get("as_of"), str):
        lines.append(f"as_of: {payload['as_of']}")

    failures = payload.get("failures")
    if isinstance(failures, list):
        lines.extend(summarize_failure_items(failures))

    findings = payload.get("findings")
    if isinstance(findings, list):
        lines.extend(summarize_finding_items(findings))

    blockers = payload.get("blockers")
    if isinstance(blockers, list):
        lines.extend(f"blocker: {blocker}" for blocker in blockers[:8])
        if len(blockers) > 8:
            lines.append(f"... {len(blockers) - 8} more blocker(s)")

    due_count = payload.get("due_count")
    if isinstance(due_count, int):
        lines.append(f"due_count: {due_count}")

    packets = payload.get("packets")
    if isinstance(packets, list):
        lines.extend(summarize_packet_items(packets))

    if not lines:
        return None

    return "\n".join(lines)


def summarize_failure_items(failures: list[Any]) -> list[str]:
    lines: list[str] = []
    for failure in failures[:8]:
        if not isinstance(failure, dict):
            continue
        jurisdiction = failure.get("jurisdiction")
        request_state = failure.get("request_state")
        missing_options = failure.get("missing_options")
        next_action = failure.get("next_action")
        expected_response = failure.get("expected_response")
        follow_up_at = failure.get("follow_up_at")
        follow_up_status = failure.get("follow_up_status")

        if jurisdiction and request_state and isinstance(missing_options, list):
            missing = " or ".join(str(option) for option in missing_options)
            lines.append(f"{jurisdiction}: {request_state}; missing {missing}")
            if follow_up_at and follow_up_status:
                lines.append(f"{jurisdiction} follow-up: {follow_up_status} on {follow_up_at}")
            if expected_response:
                lines.append(f"{jurisdiction} expected: {expected_response}")
            continue

        name = failure.get("name") or failure.get("field") or failure.get("jurisdiction") or "failure"
        detail = failure.get("detail") or next_action or failure.get("status") or "failed"
        lines.append(f"{name}: {detail}")

    if len(failures) > 8:
        lines.append(f"... {len(failures) - 8} more failure(s)")

    return lines


def summarize_finding_items(findings: list[Any]) -> list[str]:
    lines: list[str] = []
    for finding in findings[:8]:
        if not isinstance(finding, dict):
            continue
        index = finding.get("index")
        field = finding.get("field") or "finding"
        detail = finding.get("detail") or "failed"
        if isinstance(index, int) and index >= 0:
            lines.append(f"deliveries[{index}].{field}: {detail}")
        else:
            lines.append(f"{field}: {detail}")
    if len(findings) > 8:
        lines.append(f"... {len(findings) - 8} more finding(s)")
    return lines


def summarize_packet_items(packets: list[Any]) -> list[str]:
    lines: list[str] = []
    for packet in packets[:8]:
        if not isinstance(packet, dict):
            continue
        jurisdiction = packet.get("jurisdiction") or "source"
        follow_up_status = packet.get("follow_up_status") or "unknown"
        follow_up_at = packet.get("follow_up_at") or "n/a"
        recipient = packet.get("recipient") or "manual action"
        request_state = packet.get("request_state")
        lines.append(f"{jurisdiction}: {follow_up_status}; follow-up {follow_up_at}; to {recipient}")
        if request_state:
            lines.append(f"{jurisdiction} state: {request_state}")
    if len(packets) > 8:
        lines.append(f"... {len(packets) - 8} more packet(s)")
    return lines


def summarize_output(stdout: str, stderr: str) -> str:
    combined = "\n".join(part for part in [stdout.strip(), stderr.strip()] if part)
    if not combined:
        return ""
    json_summary = summarize_json_payload(extract_json_object(combined) or {})
    if json_summary:
        return json_summary
    lines = combined.splitlines()
    interesting = [
        line
        for line in lines
        if any(
            token in line.lower()
            for token in [
                "fail",
                "missing",
                "stale",
                "error",
                "passed",
                "complete",
                "unauthorized",
                "blocker",
                "dirty",
                "behind",
                "working tree",
            ]
        )
    ]
    selected = interesting[:12] or lines[-8:]
    return "\n".join(selected)


def run_gate(gate: Gate) -> GateResult:
    result = subprocess.run(
        gate.command,
        cwd=REPO_ROOT,
        capture_output=True,
        shell=False,
        check=False,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return GateResult(
        name=gate.name,
        status="pass" if result.returncode == 0 else "fail",
        exit_code=result.returncode,
        command=command_text(gate.command),
        detail=summarize_output(result.stdout, result.stderr),
    )


def skipped_result(gate: Gate) -> GateResult:
    return GateResult(
        name=gate.name,
        status="skipped",
        exit_code=None,
        command=command_text(gate.command),
        detail="skipped by --skip-heavy",
    )


def print_results(results: list[GateResult]) -> None:
    # Windows shells can expose a cp1252 stdout even when a child gate emits
    # Unicode tree/table characters. Keep a failed gate report printable instead
    # of crashing while formatting the evidence.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    width = max(len(result.name) for result in results)
    for result in results:
        print(f"{result.name.ljust(width)}  {result.status.upper().ljust(7)}  {result.command}")
        if result.detail:
            for line in result.detail.splitlines():
                print(f"{''.ljust(width)}           {line}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run final preflight gates before GitHub/deploy")
    parser.add_argument("--base-url", default="http://localhost:3000", help="App base URL for db completion gate")
    parser.add_argument("--as-of", help="Recorded in the output (no gate depends on it any more)")
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of a table")
    parser.add_argument("--keep-going", action="store_true", help="Run every selected gate even after failures")
    parser.add_argument("--skip-heavy", action="store_true", help="Skip test/build/e2e gates for a quick readiness pass")
    parser.add_argument("--list", action="store_true", help="List gates without running them")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    gates = build_gates(args.base_url, args.as_of)

    if args.list:
        results = [
            GateResult(
                name=gate.name,
                status="listed",
                exit_code=None,
                command=command_text(gate.command),
                detail="heavy" if gate.heavy else "standard",
            )
            for gate in gates
        ]
    else:
        results: list[GateResult] = []
        for gate in gates:
            if args.skip_heavy and gate.heavy:
                results.append(skipped_result(gate))
                continue
            result = run_gate(gate)
            results.append(result)
            if result.status == "fail" and not args.keep_going:
                break

    ok = all(result.status in {"pass", "listed", "skipped"} for result in results)
    payload = {
        "ok": ok,
        "base_url": args.base_url,
        "as_of": args.as_of,
        "results": [asdict(result) for result in results],
    }

    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print_results(results)

    if not args.list and not ok:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
