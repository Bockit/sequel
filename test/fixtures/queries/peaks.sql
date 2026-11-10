-- name: RecordPeak :one
-- Keeps the highest value seen for a station's metric on a day.
INSERT INTO daily_peak (station_id, day, metric, peak, updated_at)
VALUES (@station_id, @day, @metric, @peak, now())
ON CONFLICT (station_id, day, metric) DO UPDATE
SET peak = GREATEST(daily_peak.peak, EXCLUDED.peak),
  samples = daily_peak.samples + 1,
  updated_at = now()
RETURNING *;

-- name: PeakSummary :many
SELECT station_id, metric, COUNT(*)::int AS days, MAX(updated_at) AS last_updated,
  COALESCE(SUM(samples), 0)::bigint AS total_samples
FROM daily_peak
WHERE day >= @since
GROUP BY station_id, metric
ORDER BY station_id, metric;
