# T06 — Re-embed all chunks (batch, resumable; app-side or in-DB)

- **Goal:** every chunk has a 3072-d vector; EN cache used to save cost.
- **Scope/files:** index scripts (`getEmbeddingsByBatch`, batch 100, `text-embedding-3-large`) AND/OR in-DB `azure_openai.create_embeddings`, `scripts/index-output/*.json`.
- **Steps:**
  1. First load cached `chunks-en.json` (3244) + `judgment-summaries.json` (217); diff `nid/chunk_no` vs T05 output — reuse hits, queue misses.
  2. Embed the misses + all sc/tc, EITHER path (spike both, pick one per language):
     - **Option A (app-side, existing):** batch-100 calls via `getEmbeddingsByBatch` with per-batch JSON checkpoint (resumable: kill + resume loses ≤1 batch).
     - **Option B (in-DB, NEW via azure_ai):** after T01 settings, backfill directly: `UPDATE clic_chunks SET embedding = azure_openai.create_embeddings('<DEPLOYMENT>', content)::vector WHERE embedding IS NULL;` (same for `judgment_chunks`). In-DB batch overload defaults to `batch_size := 100`, `timeout_ms := 3600000`, `throw_on_error := true`, `max_attempts := 1`; pass explicit `dimensions` for 3-large only if ext ≥ 1.1.0 (verify via T01 signature discovery). Resumability = the `WHERE embedding IS NULL` predicate — rerun until zero rows.
  3. Budget before full run: 100K chunks ≈ 1000+ calls — record time + spend; run per language.
- **Acceptance:** zero chunks with null/zero-length `embedding`; spot-check 10 vectors dim=3072; run is resumable (kill + resume loses ≤1 batch, either path).
- **Depends on:** T05 (+ T01 settings for Option B). **Blocks:** T07.
- **Size:** L (time/cost, not code).
