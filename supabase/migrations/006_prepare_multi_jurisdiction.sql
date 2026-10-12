-- Prepare the USPTO trademark mirror for non-US sources.
--
-- This migration is intentionally additive except for replacing the old USPTO-only
-- uniqueness constraint with a jurisdiction-aware one. Existing rows default to US.

ALTER TABLE trademarks
  ADD COLUMN IF NOT EXISTS jurisdiction VARCHAR(10) NOT NULL DEFAULT 'US',
  ADD COLUMN IF NOT EXISTS source VARCHAR(40) NOT NULL DEFAULT 'uspto',
  ADD COLUMN IF NOT EXISTS source_updated_at TIMESTAMPTZ;

ALTER TABLE sync_metadata
  ADD COLUMN IF NOT EXISTS jurisdiction VARCHAR(10) NOT NULL DEFAULT 'US',
  ADD COLUMN IF NOT EXISTS source VARCHAR(40) NOT NULL DEFAULT 'uspto',
  ADD COLUMN IF NOT EXISTS source_updated_at TIMESTAMPTZ;

ALTER TABLE trademarks
  DROP CONSTRAINT IF EXISTS trademarks_serial_number_international_class_key;

ALTER TABLE trademarks
  DROP CONSTRAINT IF EXISTS trademarks_serial_class_key;

ALTER TABLE trademarks
  ADD CONSTRAINT trademarks_jurisdiction_serial_class_key
  UNIQUE (jurisdiction, serial_number, international_class);

CREATE INDEX IF NOT EXISTS idx_jurisdiction_wordmark_norm
  ON trademarks(jurisdiction, wordmark_normalized);

CREATE INDEX IF NOT EXISTS idx_jurisdiction_wordmark_class_status_type
  ON trademarks(jurisdiction, wordmark_normalized, international_class, status, mark_drawing_type);

CREATE INDEX IF NOT EXISTS idx_sync_jurisdiction_date
  ON sync_metadata(jurisdiction, created_at DESC);

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
    AND mark_drawing_type IN ('text', 'typeset', 'standard character', 'WORD');
$$;
