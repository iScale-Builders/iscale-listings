-- Core trademark matching function
-- Called from API routes via supabase.rpc('match_trademarks', {...})
-- STABLE: does not modify data, safe for read replicas
-- statement_timeout: prevents runaway queries
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
    AND (status = 'LIVE' OR include_dead)
    AND international_class = ANY(class_list)
    AND mark_drawing_type IN ('text', 'typeset', 'standard character');
$$;
