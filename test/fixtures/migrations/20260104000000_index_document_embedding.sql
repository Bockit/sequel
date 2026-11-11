-- sequel:no-transaction
-- An HNSW index for nearest-neighbour search on the embedding. The schema declares it as a
-- plain @@index with the same name and column; this file gives the real method and operator
-- class, which the schema language has no type for.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "document_embedding_idx" ON "document" USING hnsw ("embedding" vector_cosine_ops);
