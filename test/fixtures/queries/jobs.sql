-- name: ClaimJobs :many
-- Claims up to batch_size queued jobs that are due, skipping any another worker holds.
WITH claimed AS (
  SELECT id FROM job
  WHERE state = 'queued' AND run_after <= now()
  ORDER BY run_after, id
  LIMIT @batch_size
  FOR UPDATE SKIP LOCKED
)
UPDATE job
SET state = 'running', claimed_by = @worker::text, claimed_at = now(), attempts = job.attempts + 1
FROM claimed
WHERE job.id = claimed.id
RETURNING job.id, job.kind, job.payload, job.attempts, job.claimed_at;
