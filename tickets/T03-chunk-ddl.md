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

- **Status 2026-09-08: files DONE, deploy BLOCKED on admin grants.**
- `migrate deploy` fails: `permission denied for schema public` (PG15+ hardened `public`; `clic_app` owns the DB but has no CREATE on the schema) + `vector`/`azure_ai` still not installed.
- **Admin action (as server admin, connected to `clic_chat`):**
  ```sql
  GRANT CREATE ON SCHEMA public TO clic_app;
  CREATE EXTENSION IF NOT EXISTS vector;
  CREATE EXTENSION IF NOT EXISTS azure_ai;
  ```
  Then re-run `npx prisma migrate deploy` as `clic_app`.

- **Status 2026-09-08: DONE.** Baseline `20260908000000_baseline` deployed; `clic_chunks` + `judgment_chunks` verified (PKs, FKs → ClicPage/Judgment CASCADE, `embedding vector`, `tsv`, `cjk_tokens`).
- Lesson: keep `CREATE EXTENSION` out of migrations — untrusted extensions (`vector`) fail as `clic_app`; provision as infra (T01) instead. A `resolve --rolled-back` + header removal fixed P3009.
