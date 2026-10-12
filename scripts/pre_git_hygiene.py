"""
Run pre-Git hygiene checks before staging, committing, pushing, or deploying.

The check is intentionally conservative and redacted. It verifies that local
ignore rules cover expected secret/runtime artifacts, then scans changed files
for dangerous paths and high-confidence secret patterns.

Examples:
    python scripts/pre_git_hygiene.py
    python scripts/pre_git_hygiene.py --staged-only
    python scripts/pre_git_hygiene.py --json
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]

REQUIRED_GITIGNORE_PATTERNS = [
    ".env",
    ".env.*",
    ".env.local",
    ".env.*.local",
    "!.env.local.example",
    "credentials.md",
    "credentials/",
    "*.pem",
    "*.key",
    "*.p8",
    "*.p12",
    "service-account*.json",
    "*-service-account.json",
    "*.service-account.json",
    ".vercel",
    "*.log",
    "*.db",
    "*.sqlite",
    "*.sqlite3",
    "storage-state*.json",
    ".playwright/.auth/",
    ".playwright-mcp/",
    "playwright-report/",
    "test-results/",
    "screenshots/",
    "*.har",
    "data/deliveries/",
    "source-deliveries/",
    "import-deliveries/",
    "downloads/",
    "tmp/",
    "temp/",
]

FORBIDDEN_PATH_PARTS = [
    ".env",
    "credentials.md",
    "credentials/",
    ".vercel/",
    ".playwright/.auth/",
    ".playwright-mcp/",
    "storage-state",
    "source-deliveries/",
    "import-deliveries/",
    "downloads/",
    "tmp/",
    "temp/",
]

FORBIDDEN_SUFFIXES = (
    ".pem",
    ".key",
    ".p8",
    ".p12",
    ".db",
    ".sqlite",
    ".sqlite3",
    ".har",
)

SECRET_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("private key block", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----")),
    ("OpenAI/Stripe-style secret key", re.compile(r"\b(?:sk|rk)[_-](?:live|test|proj)[_-][A-Za-z0-9_-]{20,}\b")),
    ("Supabase JWT", re.compile(r"\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b")),
    ("GitHub token", re.compile(r"\bgh(?:p|o|u|s|r)_[A-Za-z0-9_]{20,}\b")),
    ("Google API key", re.compile(r"\bAIza[0-9A-Za-z_-]{25,}\b")),
    ("Vercel token", re.compile(r"\b[A-Za-z0-9]{24}_[A-Za-z0-9]{24}\b")),
]


@dataclass(frozen=True)
class Finding:
    kind: str
    path: str
    detail: str


def run_git(args: list[str], root: Path, *, check: bool = True) -> bytes:
    result = subprocess.run(
        ["git", *args],
        cwd=root,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if check and result.returncode != 0:
        raise RuntimeError(result.stderr.decode("utf-8", errors="replace").strip())
    return result.stdout


def normalize_path(path: str) -> str:
    return path.replace("\\", "/").lstrip("/")


def gitignore_findings(root: Path) -> list[Finding]:
    gitignore_path = root / ".gitignore"
    if not gitignore_path.exists():
        return [Finding("missing-gitignore", ".gitignore", "missing .gitignore")]

    lines = {
        line.strip()
        for line in gitignore_path.read_text(encoding="utf-8", errors="replace").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    }
    missing = [
        Finding("missing-ignore-pattern", ".gitignore", pattern)
        for pattern in REQUIRED_GITIGNORE_PATTERNS
        if pattern not in lines
    ]
    return missing


def changed_paths(staged_only: bool, root: Path) -> list[str]:
    if staged_only:
        raw = run_git(["diff", "--cached", "--name-only", "-z"], root)
    else:
        raw = (
            run_git(["diff", "--name-only", "-z"], root)
            + run_git(["diff", "--cached", "--name-only", "-z"], root)
            + run_git(["ls-files", "--others", "--exclude-standard", "-z"], root)
        )
    paths = []
    seen = set()
    for item in raw.decode("utf-8", errors="replace").split("\0"):
        path = normalize_path(item)
        if path and path not in seen:
            paths.append(path)
            seen.add(path)
    return paths


def path_findings(paths: list[str]) -> list[Finding]:
    findings = []
    for path in paths:
        lowered = path.lower()
        if lowered.endswith(FORBIDDEN_SUFFIXES):
            findings.append(Finding("forbidden-path", path, "forbidden secret/runtime file suffix"))
            continue
        for part in FORBIDDEN_PATH_PARTS:
            if part in lowered:
                allowed_example = Path(path).name == ".env.local.example"
                if not allowed_example:
                    findings.append(Finding("forbidden-path", path, f"matched {part}"))
                break
    return findings


def read_changed_file(path: str, staged_only: bool, root: Path) -> str | None:
    if staged_only:
        result = subprocess.run(
            ["git", "show", f":{path}"],
            cwd=root,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if result.returncode != 0:
            return None
        data = result.stdout
    else:
        file_path = root / path
        if not file_path.exists() or not file_path.is_file():
            return None
        data = file_path.read_bytes()

    if b"\0" in data[:4096]:
        return None
    if len(data) > 2_000_000:
        return None
    return data.decode("utf-8", errors="replace")


def content_findings(paths: list[str], staged_only: bool, root: Path) -> list[Finding]:
    findings: list[Finding] = []
    for path in paths:
        text = read_changed_file(path, staged_only, root)
        if text is None:
            continue
        for label, pattern in SECRET_PATTERNS:
            if pattern.search(text):
                findings.append(Finding("secret-looking-content", path, label))
    return findings


def collect_findings(staged_only: bool, root: Path) -> tuple[list[str], list[Finding]]:
    paths = changed_paths(staged_only, root)
    findings = [
        *gitignore_findings(root),
        *path_findings(paths),
        *content_findings(paths, staged_only, root),
    ]
    return paths, findings


def print_table(paths: list[str], findings: list[Finding], staged_only: bool) -> None:
    scope = "staged files" if staged_only else "changed and untracked files"
    print(f"Pre-Git hygiene check ({scope})")
    print(f"Files inspected: {len(paths)}")
    if not findings:
        print("Status: PASS")
        return
    print("Status: FAIL")
    for finding in findings:
        print(f"- {finding.kind}: {finding.path} ({finding.detail})")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run secret/path hygiene checks before Git operations")
    parser.add_argument("--staged-only", action="store_true", help="Scan only staged files")
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of a table")
    parser.add_argument(
        "--root",
        default=None,
        help="Repository root to scan (defaults to this repo). Mainly for test isolation.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    root = Path(args.root).resolve() if args.root else REPO_ROOT
    try:
        paths, findings = collect_findings(args.staged_only, root)
    except RuntimeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(2) from None

    if args.json:
        print(
            json.dumps(
                {
                    "ok": not findings,
                    "staged_only": args.staged_only,
                    "files_inspected": len(paths),
                    "findings": [asdict(finding) for finding in findings],
                },
                indent=2,
            )
        )
    else:
        print_table(paths, findings, args.staged_only)

    if findings:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
