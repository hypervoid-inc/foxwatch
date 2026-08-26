-- Per-day latency range for public tick tooltips (min / avg / max).
ALTER TABLE daily_uptime ADD COLUMN latency_min INTEGER;
ALTER TABLE daily_uptime ADD COLUMN latency_max INTEGER;
