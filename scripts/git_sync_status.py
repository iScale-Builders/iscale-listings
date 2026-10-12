"""
Report Git sync readiness without fetching, staging, committing, or pushing.

This command is intentionally read-only. It uses local Git refs to show whether
the current branch has an upstream, whether local refs are ahead/behind, and how
much dirty state must be reviewed before the one clean GitHub push package.
"""

from __future__ import annotations

import argparse
import json
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class GitSyncStatus:
    ok: bool
    branch: str | None
    upstream: str | None
    ahead: int | None
    behind: int | None
    clean: bool
    dirty_count: int
    staged_count: int
    unstaged_count: int
    untracked_count: int
    deleted_count: int
    latest_commit: str | None
    ready_for_final_git_package: bool
    blockers: list[str]
    changed_files: list[dict[str, str]]


def run_git(args: list[str], root: Path, *, allow_fail: bool = False) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(
        ["git", *args],
        cwd=root,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        shell=False,
        check=False,
    )
    if completed.returncode != 0 and not allow_fail:
        raise RuntimeError(completed.stderr.strip() or completed.stdout.strip())
    return completed


def optional_git_output(args: list[str], root: Path) -> str | None:
    completed = run_git(args, root, allow_fail=True)
    if completed.returncode != 0:
        return None
    value = completed.stdout.strip()
    return value or None


def parse_status_porcelain(output: str) -> list[dict[str, str]]:
    files: list[dict[str, str]] = []
    for line in output.splitlines():
        if not line:
            continue
        if line.startswith("?? "):
            files.append({"index": "?", "worktree": "?", "path": line[3:]})
            continue
        files.append({"index": line[0], "worktree": line[1], "path": line[3:]})
    return files


def compute_ahead_behind(upstream: str | None, root: Path) -> tuple[int | None, int | None]:
    if not upstream:
        return None, None
    completed = run_git(["rev-list", "--left-right", "--count", f"HEAD...{upstream}"], root, allow_fail=True)
    if completed.returncode != 0:
        return None, None
    parts = completed.stdout.strip().split()
    if len(parts) != 2:
        return None, None
    return int(parts[0]), int(parts[1])


def build_status(root: Path) -> GitSyncStatus:
    branch = optional_git_output(["branch", "--show-current"], root)
    upstream = optional_git_output(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], root)
    ahead, behind = compute_ahead_behind(upstream, root)
    latest_commit = optional_git_output(["log", "-1", "--pretty=%H %s"], root)
    changed_files = parse_status_porcelain(run_git(["status", "--porcelain"], root).stdout)

    staged_count = sum(1 for item in changed_files if item["index"] not in {" ", "?"})
    unstaged_count = sum(1 for item in changed_files if item["worktree"] not in {" ", "?"})
    untracked_count = sum(1 for item in changed_files if item["index"] == "?" and item["worktree"] == "?")
    deleted_count = sum(1 for item in changed_files if "D" in {item["index"], item["worktree"]})
    dirty_count = len(changed_files)

    blockers: list[str] = []
    if not branch:
        blockers.append("no current branch")
    if not upstream:
        blockers.append("no upstream configured")
    if behind is None:
        blockers.append("upstream comparison unavailable")
    elif behind > 0:
        blockers.append(f"local branch is behind upstream by {behind} commit(s)")
    if dirty_count > 0:
        blockers.append(f"working tree has {dirty_count} changed/untracked file(s)")

    ready = not blockers

    return GitSyncStatus(
        ok=ready,
        branch=branch,
        upstream=upstream,
        ahead=ahead,
        behind=behind,
        clean=dirty_count == 0,
        dirty_count=dirty_count,
        staged_count=staged_count,
        unstaged_count=unstaged_count,
        untracked_count=untracked_count,
        deleted_count=deleted_count,
        latest_commit=latest_commit,
        ready_for_final_git_package=ready,
        blockers=blockers,
        changed_files=changed_files,
    )


def print_table(status: GitSyncStatus) -> None:
    print(f"Git sync status: {'READY' if status.ready_for_final_git_package else 'NOT READY'}")
    print(f"Branch: {status.branch or '(none)'}")
    print(f"Upstream: {status.upstream or '(none)'}")
    print(f"Ahead/behind: {status.ahead if status.ahead is not None else '?'} ahead, {status.behind if status.behind is not None else '?'} behind")
    print(f"Working tree: {'clean' if status.clean else 'dirty'} ({status.dirty_count} changed/untracked)")
    if status.blockers:
        print()
        print("Blocking Git package readiness:")
        for blocker in status.blockers:
            print(f"- {blocker}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Report read-only Git sync readiness")
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of a table")
    parser.add_argument(
        "--root",
        default=None,
        help="Repository root to inspect (defaults to this repo). Mainly for test isolation.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    root = Path(args.root).resolve() if args.root else REPO_ROOT
    status = build_status(root)
    if args.json:
        print(json.dumps(asdict(status), indent=2))
    else:
        print_table(status)
    if not status.ok:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
