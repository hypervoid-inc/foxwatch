-- Per-day latency totals for the 90-day public bar sparkline.
ALTER TABLE daily_uptime ADD COLUMN latency_sum INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_uptime ADD COLUMN latency_count INTEGER NOT NULL DEFAULT 0;
