"""
Re-normalize stored wordmark_normalized after a change to the normalization rule.
Only rows whose normalization actually changes (non-ASCII wordmarks) need
recomputing. Uses the canonical scripts/text_normalize.normalize_text for exact
parity with the query path, and a batched RPC for fast server-side updates.
Idempotent: safe to re-run.

Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

Prerequisite — run this SQL once (Supabase SQL editor / MCP) to stage the affected
rows and create the bulk-update RPC; adjust the jurisdiction list as needed:

    DROP TABLE IF EXISTS renorm_pending;
    CREATE TABLE renorm_pending AS
      SELECT id, wordmark FROM trademarks
      WHERE jurisdiction IN ('US','EUIPO')
        AND octet_length(wordmark) <> length(wordmark);
    ALTER TABLE renorm_pending ADD PRIMARY KEY (id);

    CREATE OR REPLACE FUNCTION apply_renorm(updates jsonb)
    RETURNS integer LANGUAGE plpgsql AS $func$
    DECLARE n integer;
    BEGIN
      WITH u AS (
        SELECT (e->>'id')::bigint AS id, e->>'n' AS n
        FROM jsonb_array_elements(updates) AS e
      )
      UPDATE trademarks t SET wordmark_normalized = u.n FROM u WHERE t.id = u.id;
      GET DIAGNOSTICS n = ROW_COUNT;
      RETURN n;
    END;
    $func$;
    REVOKE EXECUTE ON FUNCTION apply_renorm(jsonb) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION apply_renorm(jsonb) TO service_role;
    NOTIFY pgrst, 'reload schema';

Teardown after the run:

    DROP TABLE IF EXISTS renorm_pending;
    DROP FUNCTION IF EXISTS apply_renorm(jsonb);
    NOTIFY pgrst, 'reload schema';
"""

import json
import os
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from text_normalize import normalize_text

BASE = os.environ["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/")
KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
HEADERS = {
    "apikey": KEY,
    "Authorization": f"Bearer {KEY}",
    "Content-Type": "application/json",
}
PAGE = 2000


def _with_retry(fn):
    for attempt in range(5):
        try:
            return fn()
        except (HTTPError, URLError, TimeoutError, OSError) as exc:
            if attempt == 4:
                raise
            print(f"  retry {attempt + 1}: {exc}", file=sys.stderr, flush=True)
            time.sleep(2 * (attempt + 1))


def fetch_batch(after_id):
    url = (
        f"{BASE}/rest/v1/renorm_pending?select=id,wordmark"
        f"&id=gt.{after_id}&order=id.asc&limit={PAGE}"
    )

    def go():
        req = Request(url, headers=dict(HEADERS), method="GET")
        with urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))

    return _with_retry(go)


def apply_updates(updates):
    payload = json.dumps({"updates": updates}).encode("utf-8")

    def go():
        req = Request(
            f"{BASE}/rest/v1/rpc/apply_renorm",
            data=payload,
            headers=dict(HEADERS),
            method="POST",
        )
        with urlopen(req, timeout=120) as resp:
            return resp.read().decode("utf-8")

    return _with_retry(go)


def main():
    after = 0
    total = 0
    while True:
        rows = fetch_batch(after)
        if not rows:
            break
        updates = [
            {"id": r["id"], "n": normalize_text(r["wordmark"])} for r in rows
        ]
        apply_updates(updates)
        total += len(updates)
        after = rows[-1]["id"]
        print(f"  re-normalized {total} rows (through id {after})", flush=True)
    print(f"DONE: {total} rows re-normalized")


if __name__ == "__main__":
    main()
