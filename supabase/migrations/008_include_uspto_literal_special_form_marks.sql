-- Correct the text-screening scope for USPTO mark drawing codes.
--
-- USPTO codes 3 (words, letters, and/or numbers plus design) and 5 (stylized
-- letters and/or numbers) contain searchable literal wording and must be
-- screened. Code 2 is design-only and must not be screened as text. Historical
-- versions of the importer mislabeled code 2 as "text" and excluded codes 3
-- and 5; this migration deliberately drops "text" from the allow-list.
--
-- Applying these functions does not repair historical rows. Run the separately
-- approved historical data reconciliation before treating coverage as complete.

CREATE OR REPLACE FUNCTION match_trademarks_by_jurisdiction(
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
    AND mark_drawing_type IN (
      'typeset',
      'standard character',
      'words and design',
      'stylized text',
      'WORD'
    );
$$;
