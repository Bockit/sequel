-- name: LatestReadings :many
-- The latest reading of each metric, for each station asked for.
SELECT DISTINCT ON (station_id, metric) *
FROM reading
WHERE station_id = ANY(@station_ids::int[])
ORDER BY station_id, metric, recorded_at DESC;
