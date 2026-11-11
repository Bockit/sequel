-- sequel:no-transaction
-- A partial index, an extra the schema language can't express. Noted on the job model. Built
-- concurrently, so it doesn't block writes to job, which needs a file of its own outside a
-- transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "job_live_run_after_idx" ON "job"("run_after", "id") WHERE "state" <> 'cancelled';
