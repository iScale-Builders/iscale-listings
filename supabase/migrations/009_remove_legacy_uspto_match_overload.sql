-- Finish the USPTO drawing-code matching correction and remove the obsolete
-- two-argument match_trademarks overload left behind by migration 004.
--
-- The application calls the three-argument overload. Keeping the old overload
-- would let older clients continue using the stale drawing-type allow-list and
-- its missing jurisdiction filter.

DROP FUNCTION IF EXISTS public.match_trademarks(TEXT[], TEXT[]);

CREATE OR REPLACE FUNCTION public.match_trademarks_by_jurisdiction(
  candidate_list TEXT[],
  class_list TEXT[],
  include_dead BOOLEAN DEFAULT FALSE,
  jurisdiction_list TEXT[] DEFAULT ARRAY['US']
)
RETURNS TABLE (
  jurisdiction VARCHAR,
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
  SELECT jurisdiction, serial_number, registration_number, wordmark,
         wordmark_normalized, international_class, owner_name,
         status, status_code, filing_date
  FROM trademarks
  WHERE jurisdiction = ANY(jurisdiction_list)
    AND wordmark_normalized = ANY(candidate_list)
    AND (status = 'LIVE' OR include_dead)
    AND international_class = ANY(class_list)
    AND mark_drawing_type IN (
      'typeset',
      'standard character',
      'words and design',
      'stylized text',
      'WORD'
    );
$$;

CREATE OR REPLACE FUNCTION public.match_trademarks(
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
    AND mark_drawing_type IN (
      'typeset',
      'standard character',
      'words and design',
      'stylized text',
      'WORD'
    );
$$;
