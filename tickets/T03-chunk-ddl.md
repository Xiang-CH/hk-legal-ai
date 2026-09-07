# T03 — Chunk tables DDL + fresh baseline migration

- **Goal:** `clic_chunks` + `judgment_chunks` exist with pg-native search columns (no zhparser).
- **Scope/files:** `prisma/schema.prisma` (new models), `prisma/migrations/*` (fresh baseline), raw SQL for indexes.
- **Steps:**
  1. Add `ClicChunk(nid, chunk_no, title, content, url, topic, context, embedding Unsupported("vector(3072)"), tsv tsvector, cjk_tokens Text?, @@id([nid, chunk_no]), @@index([nid]))` + FK to parent.
  2. Add `JudgmentChunk(judgmentId, chunk_no, neutralCitation, courtName, year, date, parties, summary, summarySource, url, embedding, tsv, cjk_tokens?, @@id([judgmentId, chunk_no]))` + FK.
  3. `embedding`: Prisma `Unsupported("vector(3072)")`; HNSW/GIN via raw SQL migration (NOT Prisma attributes):
     - `GIN(tsv)`, `GIN(to_tsvector('simple', cjk_tokens))`, `GIN(cjk_tokens gin_trgm_ops)`, `GIN(content gin_trgm_ops)` per table.
  4. Shared tokenizer (new `scripts/cjk.ts`, reused by T05/T06/T08): CJK → overlapping bigrams + keep alnum words (see T07 for reference impl).
  5. Fresh `prisma migrate` baseline on empty server (do not replay SQL Server migrations).
- **Acceptance:** `\d clic_chunks`, `\d judgment_chunks` show PKs/FKs + `cjk_tokens`; baseline applies cleanly on fresh DB.
- **Depends on:** T01, T02. **Blocks:** T07.
- **Size:** S/M.
