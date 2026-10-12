-- Harden match_trademarks (the US-only RPC used for single-jurisdiction US
-- checks): add an explicit jurisdiction = 'US' filter and align its
-- drawing-type allow-list with match_trademarks_by_jurisdiction (006) by adding
-- 'WORD'.
--
-- Why: 004 has NO jurisdiction filter. It is currently correct only by accident
-- — its drawing-type filter ('text','typeset','standard character') matches
-- USPTO marks only, because EUIPO and the other importers store 'WORD' /
-- 'FIGURATIVE' / etc. That coupling is fragile: adding 'WORD' to the list, or
-- loading US rows via the generic CSV importer (which defaults
-- mark_drawing_type to 'WORD'), would let a US-only query leak cross-jurisdiction
-- matches. An explicit jurisdiction = 'US' filter makes the scoping robust and
-- lets the drawing-type list safely match 006 so the two RPCs cannot drift.
--
-- Behavior-neutral on today's data: no US row currently has drawing_type 'WORD'
-- (tm_splitter never emits it), and EUIPO rows were already excluded by the old
-- drawing-type filter. This is defensive alignment, not a live-bug fix.
--
-- jurisdiction was added in 006, so this migration must run after it. Safe to
-- apply on its own (CREATE OR REPLACE, signature unchanged — the live app keeps
-- calling match_trademarks the same way).
CREATE OR REPLACE FUNCTION match_trademarks(
  candidate_list TEXT[],
  class_list TEXT[],
  include_dead BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
  serial_number VARCHAR,
  registration_number VARCHAR,
  wordmark TEXT,
  wordmark_normalized TEXT,
  international_class VARCHAR,
  owner_name TEXT,
  status VARCHAR,
  status_code VARCHAR,
  filing_date DATE
)
LANGUAGE sql STABLE
SET statement_timeout = '5s'
AS $$
  SELECT serial_number, registration_number, wordmark,
         wordmark_normalized, international_class, owner_name,
         status, status_code, filing_date
  FROM trademarks
  WHERE wordmark_normalized = ANY(candidate_list)
    AND jurisdiction = 'US'
    AND (status = 'LIVE' OR include_dead)
    AND international_class = ANY(class_list)
    AND mark_drawing_type IN ('text', 'typeset', 'standard character', 'WORD');
$$;
