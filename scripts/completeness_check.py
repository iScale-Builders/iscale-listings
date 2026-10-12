"""
Weekly trademark completeness monitor.

Two checks that would have caught the 2025-06..2026-02 coverage gap on day one
instead of months later:

  1. REGISTRATION CLIFF — any recent settled month whose registration count is far
     below the typical level. A sustained multi-month drop is the fingerprint of an
     ingestion gap (the real gap looked like 30k/mo -> 3-9k/mo).
  2. SYNC STALL — the daily US sync ran recently and didn't abort/fail.

Exits non-zero if anything looks wrong, so the GitHub Actions run FAILS loudly
(GitHub emails on a failed scheduled run). Read-only; safe to run anytime.

Creds: TM_DB_URL env (CI secret) or the local vault file (override path with TM_VAULT).
"""

import os
import re
import sys
import datetime
from pathlib import Path

import psycopg2

VAULT = os.environ.get("TM_VAULT")  # optional path to a file containing the connection string
CLIFF_FRACTION = 0.5   # a month under this fraction of the median is "low"
MIN_LOW_MONTHS = 2     # need >=2 low months to call it a gap (1 = normal reporting lag)
SYNC_MAX_AGE_DAYS = 3  # daily sync should have run within this many days


def dsn() -> str:
    url = os.environ.get("TM_DB_URL")
    if url:
        return url
    if not VAULT:
        sys.exit("ERROR: set TM_DB_URL, or TM_VAULT to a file containing the connection string")
    text = Path(VAULT).read_text(encoding="utf-8", errors="replace")
    # Pick the postgresql URL from the vault; TM_DB_REF disambiguates if it holds
    # several (default: first match). No project ref is hardcoded here.
    ref = os.environ.get("TM_DB_REF", "")
    for candidate in re.findall(r"postgresql://[^\s`]+", text):
        if ref in candidate:
            return candidate
    sys.exit("ERROR: no DB URL found in the vault (set TM_DB_URL, or TM_DB_REF to disambiguate)")


def main() -> int:
    conn = psycopg2.connect(dsn(), connect_timeout=25)
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute("SET statement_timeout=0")
    problems: list[str] = []

    # --- Check 1: registration cliff over the last 7 complete months ---
    cur.execute(
        """
        SELECT to_char(date_trunc('month', registration_date), 'YYYY-MM') AS m, count(*)
        FROM trademarks
        WHERE jurisdiction = 'US' AND registration_number !~ '^0*$'
          AND registration_date >= (date_trunc('month', now()) - interval '7 months')
          AND registration_date <  date_trunc('month', now())
        GROUP BY 1 ORDER BY 1
        """
    )
    rows = cur.fetchall()
    counts = [c for _, c in rows]
    if len(counts) >= 4:
        srt = sorted(counts)
        median = srt[len(srt) // 2]
        threshold = CLIFF_FRACTION * median
        low = [(m, c) for m, c in rows if c < threshold]
        print("Monthly US registrations (last 7 complete months):")
        for m, c in rows:
            print(f"  {m}: {c:,}{'   <-- LOW' if c < threshold else ''}")
        print(f"  median={median:,}  cliff-threshold={int(threshold):,}")
        if len(low) >= MIN_LOW_MONTHS:
            problems.append(
                f"REGISTRATION CLIFF: {len(low)} months below {int(threshold):,} "
                "(possible ingestion gap): " + ", ".join(f"{m}={c:,}" for m, c in low)
            )
    else:
        print(f"Only {len(counts)} complete months available — skipping cliff check.")

    # --- Check 2: daily sync health ---
    cur.execute(
        "SELECT sync_date, status FROM sync_metadata "
        "WHERE jurisdiction = 'US' ORDER BY created_at DESC LIMIT 1"
    )
    r = cur.fetchone()
    if not r:
        problems.append("SYNC: no US sync_metadata rows found")
    else:
        last_date, status = r
        age = (datetime.date.today() - last_date).days
        print(f"\nLast US sync: {last_date}  (status={status}, {age}d ago)")
        if age > SYNC_MAX_AGE_DAYS:
            problems.append(f"SYNC STALE: last sync was {age} days ago ({last_date})")
        if status in ("aborted", "failed"):
            problems.append(f"SYNC {status.upper()}: the latest run did not complete cleanly")

    conn.close()

    if problems:
        print("\n=== COMPLETENESS ALERT ===")
        for p in problems:
            print("  ! " + p)
        return 1
    print("\nOK: no registration cliffs or sync stalls detected.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
