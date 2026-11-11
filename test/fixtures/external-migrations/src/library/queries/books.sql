-- name: ListBooks :many
SELECT b.id, b.title, b.pages, b.status, b.updated_at, r.name AS reader_name
FROM book b
LEFT JOIN reader r ON r.id = b.reader_id
WHERE b.status = ANY(@statuses::book_status[])
ORDER BY b.updated_at DESC, b.id;

-- name: AddBook :one
INSERT INTO book (id, reader_id, title, pages, status, updated_at)
VALUES (@id, @reader_id, @title, @pages, @status, now())
RETURNING *;

-- name: StartReading :one
UPDATE book
SET status = 'reading', updated_at = now()
WHERE id = @id
RETURNING id, status, updated_at;

-- name: RemoveBook :execrows
DELETE FROM book WHERE id = @id;
