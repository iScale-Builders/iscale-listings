-- Enable RLS on all tables
ALTER TABLE trademarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE check_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_metadata ENABLE ROW LEVEL SECURITY;

-- Trademarks: public read, no client writes
CREATE POLICY "trademarks_public_select"
  ON trademarks FOR SELECT
  USING (true);

-- API keys & check_history: all access goes through service role client
-- (which bypasses RLS). Auth (API key or anonymous) is validated in middleware, not at DB level.
-- No row-level policies needed — the service role key is only used server-side.

-- Sync metadata: public read
CREATE POLICY "sync_metadata_public_select"
  ON sync_metadata FOR SELECT
  USING (true);
