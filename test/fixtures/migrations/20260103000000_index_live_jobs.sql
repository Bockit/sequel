-- A partial index, an extra the schema language can't express. Noted on the job model.
CREATE INDEX "job_live_run_after_idx" ON "job"("run_after", "id") WHERE "state" <> 'cancelled';
