-- Degradation and recovery are confirmed over consecutive runs, like failures.
ALTER TABLE monitors ADD COLUMN consecutive_changes INTEGER NOT NULL DEFAULT 0;

-- Incident and alert side effects owed for a status change are stored with the
-- change itself and delivered until they succeed.
ALTER TABLE component_state ADD COLUMN pending_json TEXT;
ALTER TABLE component_state ADD COLUMN pending_lease INTEGER;

-- Run history is pruned by time on the scheduled tick.
CREATE INDEX IF NOT EXISTS idx_check_runs_time ON check_runs(checked_at);
