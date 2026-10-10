-- Expired sessions and login throttle rows are pruned by time on the scheduled tick.
CREATE INDEX IF NOT EXISTS idx_ops_sessions_expires ON ops_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_ops_auth_throttle_reset ON ops_auth_throttle(reset_at);
