-- name: GetTask :one
-- Fetches one task with its project's name.
SELECT t.id, t.title, t.state, t.past_states, t.estimate, t.due_on, p.name, p.id IS NOT NULL AS has_project
FROM task t LEFT JOIN project p ON p.id = t.project_id
WHERE t.id = $1;

-- name: ListTasks :many
SELECT * FROM task WHERE project_id = @project_id AND state = ANY(@states::task_state[]) ORDER BY id LIMIT $3;

-- name: CreateTask :one
INSERT INTO task (project_id, title, severity, meta) VALUES ($1, $2, sqlc.narg(severity), @meta) RETURNING id, created_at;

-- name: ArchiveProject :execrows
UPDATE project SET archived_at = now() WHERE id = @id AND archived_at IS NULL;

-- name: DeleteTask :exec
DELETE FROM task WHERE id = $1;

-- name: CountByState :many
SELECT state, count(*) AS total, count(*)::int AS total_int, max(created_at) AS latest, sum(estimate) AS estimated
FROM task GROUP BY state;
