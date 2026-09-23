-- Backfill unique indexes declared in schema.prisma (@@unique) but missing from
-- the T03 baseline, so T07 ON CONFLICT loaders are idempotent. IF NOT EXISTS:
-- safe on the already-migrated halfvec tables (no column rewrite, metadata only).
CREATE UNIQUE INDEX IF NOT EXISTS "clic_chunks_nid_language_code_chunk_no_key" ON "clic_chunks"("nid", "language_code", "chunk_no");
CREATE UNIQUE INDEX IF NOT EXISTS "judgment_chunks_judgment_id_chunk_no_key" ON "judgment_chunks"("judgment_id", "chunk_no");
