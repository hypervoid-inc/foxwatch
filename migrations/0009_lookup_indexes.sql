-- Lookups that ran as full table scans: updates of an incident (every snapshot
-- build and public incident page), a component's maintenance windows, and the
-- token of an incoming heartbeat ping.
CREATE INDEX IF NOT EXISTS idx_incident_updates_incident ON incident_updates(incident_id, created_at);
CREATE INDEX IF NOT EXISTS idx_maintenance_component ON maintenance(component_id, end_at);
CREATE INDEX IF NOT EXISTS idx_heartbeats_token ON heartbeats(token_hash);
