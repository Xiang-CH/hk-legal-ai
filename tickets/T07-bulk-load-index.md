# T07 — COPY chunks + build HNSW/GIN/tsv (no zhparser)

- **Goal:** chunks queryable: vectors + lexical + trgm indexed (indexes AFTER load). 4GB box: keep `maintenance_work_mem` ≤1GB or temp scale-up.
- **Scope/files:** raw SQL migration/script, `clic_chunks`, `judgment_chunks`, shared `scripts/cjk.ts`.
- **Steps:**
  1. `COPY` chunk JSONs into both tables (fresh + cached EN).
  2. Populate columns:
     - `tsv = to_tsvector('english', title || ' ' || content)` for en rows.
     - `tsv = to_tsvector('simple', title || ' ' || content)` for sc/tc rows (no stemming), PLUS `cjk_tokens = cjkTokens(title || ' ' || content)` via reference impl:
       ```ts
       function cjkTokens(s: string): string {
         const cjk = s.match(/[一-鿿㐀-䶿豈-﫿]+/g) ?? [];
         const grams = cjk.flatMap(w => w.length < 2 ? [w] : Array.from({length: w.length-1}, (_,i)=>w.slice(i,i+2)));
         const words = s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
         return [...grams, ...words].join(' ');
       }
       ```
  3. After COPY: `CREATE INDEX USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64)`, `GIN(tsv)`, `GIN(cjk_tokens gin_trgm_ops)`, `GIN(content gin_trgm_ops)` per table.
  4. Revert `maintenance_work_mem`; `ANALYZE` both tables.
- **Acceptance:** `\di` shows indexes; `COUNT(*)` matches JSON totals; `cjk_tokens` non-null on sc/tc rows; sample vector + lexical queries <500ms.
- **Depends on:** T01, T03, T06. **Blocks:** T08.
- **Size:** M.
