-- halfvec embeddings (T17 unblock): pgvector HNSW on full-precision `vector` caps at
-- 2000 dims ("column cannot have more than 2000 dimensions for hnsw index"), but our
-- text-embedding-3-large vectors are 3072-d. halfvec(3072) (float16, cosine-equivalent
-- for normalized embeddings) supports HNSW up to 4000 dims. Requires vector ext >= 0.7 (T01: 0.8.2).
-- clic/judgment tables are still empty (T05/T06 pending) — converted now so T07 doesn't hit the same wall.
ALTER TABLE "clic_chunks" ALTER COLUMN "embedding" TYPE halfvec(3072) USING "embedding"::halfvec(3072);
ALTER TABLE "judgment_chunks" ALTER COLUMN "embedding" TYPE halfvec(3072) USING "embedding"::halfvec(3072);
ALTER TABLE "legislation_chunks" ALTER COLUMN "embedding" TYPE halfvec(3072) USING "embedding"::halfvec(3072);
