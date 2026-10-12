-- Trademarks: exact match on normalized wordmark (primary lookup path)
CREATE INDEX idx_wordmark_norm ON trademarks(wordmark_normalized);

-- Trademarks: GIN trigram index for future fuzzy matching
CREATE INDEX idx_wordmark_gin ON trademarks USING gin(wordmark_normalized gin_trgm_ops);

-- Trademarks: status filter
CREATE INDEX idx_status ON trademarks(status);

-- Trademarks: class filter
CREATE INDEX idx_class ON trademarks(international_class);

-- Trademarks: composite index for main query filter path
CREATE INDEX idx_class_status_type ON trademarks(international_class, status, mark_drawing_type);

-- Trademarks: optimal composite index for match_trademarks RPC (covers entire WHERE clause)
CREATE INDEX idx_wordmark_class_status_type ON trademarks(wordmark_normalized, international_class, status, mark_drawing_type);

-- API keys: hash lookup
CREATE INDEX idx_api_key_hash ON api_keys(key_hash);

-- API keys: user lookup
CREATE INDEX idx_api_key_user ON api_keys(user_id);

-- Check history: user history with recent-first ordering
CREATE INDEX idx_history_user ON check_history(user_id, created_at DESC);

-- Check history: key history with recent-first ordering
CREATE INDEX idx_history_key ON check_history(api_key_id, created_at DESC);

-- Sync metadata: recent-first ordering
CREATE INDEX idx_sync_date ON sync_metadata(sync_date DESC);
