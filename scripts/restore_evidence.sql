-- Read-only evidence for source and scratch restore; keep stdout private.
-- Pause imports around the source dump/evidence so the snapshots are comparable.
-- Invoke with psql --no-psqlrc --set ON_ERROR_STOP=1 --tuples-only --no-align --file scripts/restore_evidence.sql
BEGIN TRANSACTION READ ONLY;
WITH counts AS (
  SELECT jurisdiction, count(*) AS total_rows,
    count(*) FILTER (WHERE status = 'LIVE') AS live_rows
  FROM public.trademarks GROUP BY jurisdiction ORDER BY jurisdiction
), sync AS (
  SELECT jurisdiction, source, max(sync_date) AS latest_sync_date,
    max(live_mark_count) FILTER (WHERE status = 'completed') AS completed_live_count
  FROM public.sync_metadata GROUP BY jurisdiction, source ORDER BY jurisdiction, source
), columns AS (
  SELECT table_name, column_name, data_type, is_nullable, ordinal_position
  FROM information_schema.columns WHERE table_schema = 'public'
  ORDER BY table_name, ordinal_position
), functions AS (
  SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS arguments,
    md5(pg_get_functiondef(p.oid)) AS definition_hash
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('match_trademarks', 'match_trademarks_by_jurisdiction')
  ORDER BY p.proname, arguments
), lookups AS (
  SELECT jurisdiction, serial_number, wordmark_normalized, international_class, status
  FROM public.match_trademarks_by_jurisdiction(
    ARRAY['nike', 'just do it'], ARRAY['025'], FALSE, ARRAY['US', 'EUIPO'])
  ORDER BY jurisdiction, serial_number, international_class, wordmark_normalized, status
)
SELECT jsonb_build_object(
  'counts', (SELECT coalesce(jsonb_agg(to_jsonb(counts) ORDER BY jurisdiction), '[]'::jsonb) FROM counts),
  'sync', (SELECT coalesce(jsonb_agg(to_jsonb(sync) ORDER BY jurisdiction, source), '[]'::jsonb) FROM sync),
  'columns', (SELECT coalesce(jsonb_agg(to_jsonb(columns) ORDER BY table_name, ordinal_position), '[]'::jsonb) FROM columns),
  'functions', (SELECT coalesce(jsonb_agg(to_jsonb(functions) ORDER BY proname, arguments), '[]'::jsonb) FROM functions),
  'knownLookups', (SELECT coalesce(jsonb_agg(to_jsonb(lookups) ORDER BY jurisdiction, serial_number, international_class, wordmark_normalized, status), '[]'::jsonb) FROM lookups)
);
ROLLBACK;
