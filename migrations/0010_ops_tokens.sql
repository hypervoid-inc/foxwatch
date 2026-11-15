-- API tokens for agents and scripts. Each acts as its owner with the admin role
-- at most. Only a SHA-256 hash of the token is kept.
CREATE TABLE IF NOT EXISTS ops_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_ops_tokens_user ON ops_tokens(user_id);
