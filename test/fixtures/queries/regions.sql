-- name: IsWithinRegion :one
WITH RECURSIVE ancestry AS (
  SELECT id, parent_id FROM region WHERE id = @region_id
  UNION ALL
  SELECT r.id, r.parent_id FROM region r JOIN ancestry a ON r.id = a.parent_id
)
SELECT EXISTS (SELECT 1 FROM ancestry WHERE id = @ancestor_id) AS within;
