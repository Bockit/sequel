-- name: ListStations :many
-- Every station with its alert, display and sync settings, any of which it may lack.
SELECT s.id, s.name, a.enabled AS alerts_enabled, a.level AS alert_level, d.theme, d.compact,
  y.id IS NOT NULL AS has_sync, y.interval_minutes
FROM station s
LEFT JOIN station_alert_config a ON a.station_id = s.id
LEFT JOIN station_display_config d ON d.station_id = s.id
LEFT JOIN station_sync_config y ON y.station_id = s.id
ORDER BY s.name, s.id;

-- name: RankStationsByName :many
SELECT s.id, s.name, s.region_id,
  ROW_NUMBER() OVER (PARTITION BY s.region_id ORDER BY s.created_at, s.id) AS position
FROM station s
WHERE s.name = ANY(@names::text[])
ORDER BY s.region_id, position;
