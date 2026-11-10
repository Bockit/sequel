-- name: NearestDocuments :many
SELECT id, title, embedding <=> @embedding::vector AS distance
FROM document
WHERE station_id = @station_id
ORDER BY distance
LIMIT @max_results;
