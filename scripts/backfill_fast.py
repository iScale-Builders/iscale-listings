"""Fast, resilient one-off backfill: US LIVE->DEAD for abandoned/cancelled codes.

Strategy:
  1. ensure a CONCURRENT partial index on the target rows (instant row-finding),
  2. flip in small subquery-driven batches (no giant arrays), committing each,
  3. reconnect automatically if the pooler drops the connection (multi-hour safe),
  4. drop the index when done.
Only ever sets DEAD; idempotent (status='LIVE' predicate). Creds via env
(TM_DB_HOST/TM_DB_PORT/TM_DB_USER/TM_DB_PW/TM_DB_NAME); never hard-coded.
"""

import os
import sys
import time

DEAD_CODES = [
    "600", "601", "602", "603", "604", "605", "606", "607", "608", "609",
    "614", "618", "622", "626", "690",
    "710", "711", "712", "713", "714", "716",
    "763", "764", "766", "779",
]
IDX = "idx_tm_deadset_tmp"
BATCH = 25_000
CODES_SQL = "(" + ",".join("'%s'" % c for c in DEAD_CODES) + ")"  # literals only


def params():
    return dict(
        host=os.environ["TM_DB_HOST"], port=int(os.environ.get("TM_DB_PORT", "5432")),
        user=os.environ.get("TM_DB_USER", "postgres"), password=os.environ["TM_DB_PW"],
        dbname=os.environ.get("TM_DB_NAME", "postgres"), connect_timeout=25,
    )


def main() -> int:
    if not os.environ.get("TM_DB_HOST") or not os.environ.get("TM_DB_PW"):
        print("ERROR: TM_DB_HOST / TM_DB_PW not set", flush=True)
        return 2
    import psycopg2

    # 1. Ensure the partial index (no-op if already built+valid).
    c = psycopg2.connect(**params())
    c.autocommit = True
    cur = c.cursor()
    cur.execute("SET statement_timeout=0")
    print("ensuring partial index...", flush=True)
    cur.execute(
        f"CREATE INDEX CONCURRENTLY IF NOT EXISTS {IDX} ON trademarks(id) "
        f"WHERE jurisdiction='US' AND status='LIVE' AND status_code IN {CODES_SQL}"
    )
    c.close()
    print("index ready", flush=True)

    # 2/3. Flip loop with auto-reconnect.
    total = 0
    t1 = time.time()
    conn = None
    while True:
        try:
            if conn is None:
                conn = psycopg2.connect(**params())
                conn.autocommit = False
                cur = conn.cursor()
                cur.execute("SET statement_timeout=0")
                # Force index plans on this connection: the planner otherwise
                # misjudged the batch on the bloated table and seq-scanned the
                # whole heap per batch (~8 min/25k). The CTE SELECT uses the
                # partial index; the UPDATE...FROM cte joins on the PK.
                cur.execute("SET enable_seqscan=off")
                conn.commit()
            # Materialize the batch's ids via the partial index in a CTE, then
            # join on the PK to update. Avoids the `id IN (subquery)` semi-join
            # plan, which the planner runs as a full-table seq scan PER BATCH
            # (~8 min/25k). The CTE join is an index nested loop (~rows/sec bound
            # only). FOR UPDATE SKIP LOCKED keeps it deadlock-free if anything
            # else touches the table.
            cur.execute(
                f"WITH cte AS ("
                f"  SELECT id FROM trademarks WHERE jurisdiction='US' AND status='LIVE' "
                f"  AND status_code IN {CODES_SQL} LIMIT {BATCH} FOR UPDATE SKIP LOCKED) "
                f"UPDATE trademarks t SET status='DEAD' FROM cte WHERE t.id=cte.id"
            )
            n = cur.rowcount
            conn.commit()
            if n == 0:
                break
            total += n
            el = max(1, int(time.time() - t1))
            print(f"[{el}s] +{n} total={total} ~{total//el}/s", flush=True)
        except psycopg2.OperationalError as e:
            print(f"reconnect after: {str(e).strip()[:90]}", flush=True)
            try:
                conn.close()
            except Exception:
                pass
            conn = None
            time.sleep(3)
    print(f"FLIP DONE total={total} in {int(time.time()-t1)}s", flush=True)

    # 4. Drop the temp index.
    c2 = psycopg2.connect(**params())
    c2.autocommit = True
    cur2 = c2.cursor()
    cur2.execute("SET statement_timeout=0")
    cur2.execute(f"DROP INDEX CONCURRENTLY IF EXISTS {IDX}")
    c2.close()
    print("index dropped; backfill complete", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
