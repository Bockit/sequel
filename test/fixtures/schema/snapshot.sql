-- Postgres features outside Prisma's schema language, as the test database has them.
-- Written by `sequel extras`. A record for review: it is never run.

-- Extensions
CREATE EXTENSION vector;

-- Database settings
-- (none)

-- Functions
-- (none)

-- Triggers
-- (none)

-- CHECK, exclusion and deferrable constraints
-- (none)

-- Partial, expression and non-btree indexes
CREATE INDEX document_embedding_idx ON public.document USING hnsw (embedding vector_cosine_ops);
CREATE INDEX job_live_run_after_idx ON public.job USING btree (run_after, id) WHERE (state <> 'cancelled'::job_state);

-- Generated columns
-- (none)

-- Views
-- (none)

-- Column collations
-- (none)
