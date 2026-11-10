CREATE TYPE task_state AS ENUM ('todo', 'doing', 'done');
CREATE SCHEMA ops;
CREATE TYPE ops.severity AS ENUM ('low', 'high');

CREATE TABLE project (
  id serial PRIMARY KEY,
  name text NOT NULL,
  archived_at timestamptz
);

CREATE TABLE task (
  id bigserial PRIMARY KEY,
  project_id integer REFERENCES project (id),
  title text NOT NULL,
  state task_state NOT NULL DEFAULT 'todo',
  past_states task_state[] NOT NULL DEFAULT '{}',
  severity ops.severity,
  estimate numeric(6, 2),
  due_on date,
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
