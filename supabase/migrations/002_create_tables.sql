-- USPTO trademark mirror
-- NOTE: goods_services intentionally omitted (8GB storage budget)
CREATE TABLE trademarks (
  id            BIGSERIAL PRIMARY KEY,
  serial_number VARCHAR(20) NOT NULL,
  registration_number VARCHAR(20),
  wordmark      TEXT NOT NULL,
  wordmark_normalized TEXT NOT NULL,
  mark_drawing_type VARCHAR(20),
  status        VARCHAR(20) NOT NULL,
  status_code   VARCHAR(10),
  filing_date   DATE,
  registration_date DATE,
  owner_name    TEXT,
  international_class VARCHAR(10),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (serial_number, international_class)
);

-- API keys (raw key never stored, only SHA-256 hash)
CREATE TABLE api_keys (
  id            BIGSERIAL PRIMARY KEY,
  key_hash      VARCHAR(64) UNIQUE NOT NULL,
  key_prefix    VARCHAR(16) NOT NULL,
  user_id       TEXT,
  name          VARCHAR(100),
  tier          VARCHAR(20) NOT NULL DEFAULT 'free',
  rate_limit    INTEGER NOT NULL DEFAULT 30,
  is_active     BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ
);

-- Check history audit trail
CREATE TABLE check_history (
  id              BIGSERIAL PRIMARY KEY,
  user_id         TEXT,
  api_key_id      BIGINT REFERENCES api_keys(id) ON DELETE SET NULL,
  input_text      TEXT NOT NULL,
  classes_checked VARCHAR(50),
  match_count     INTEGER,
  query_time_ms   INTEGER,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Sync audit trail
CREATE TABLE sync_metadata (
  id                    BIGSERIAL PRIMARY KEY,
  sync_date             DATE NOT NULL,
  live_mark_count       INTEGER NOT NULL,
  marks_added           INTEGER DEFAULT 0,
  marks_updated         INTEGER DEFAULT 0,
  marks_status_changed  INTEGER DEFAULT 0,
  sync_duration_seconds INTEGER,
  status                VARCHAR(20) NOT NULL,
  error_message         TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);
