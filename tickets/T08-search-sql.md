# T08 — Postgres fusion search (replace Azure hybrid, no zhparser; in-DB embeddings)

- **Goal:** `searchClic()` / `searchJudgmentSummary()` run on pg with same top-k contract minus Azure-only fields; query-time embedding happens **in-DB** via `azure_ai` where possible.
- **Scope/files:** `src/app/api/chat/helper.ts` (rewrite) + shared `cjkTokens()` (from `scripts/cjk.ts`); query embedding via `azure_openai.create_embeddings` (primary) with app `getEmbeddings()` fallback.
- **Steps:**
  1. Per rewritten query (≤3 as today): lexical LIMIT 15 + vector LIMIT 15, in parallel; carry `languageCode` + `topic` filter (`topic = ANY`).
  2. Query embedding (NEW): `... ORDER BY embedding <=> azure_openai.create_embeddings('<DEPLOYMENT>', $query)::vector LIMIT 15` — single round-trip, no app→OpenAI hop. Fallback: app `getEmbeddings()` → pass vector as `$emb` (keep this path for when DB settings/timeouts fail). Watch ext default `timeout_ms := 3600000` vs app statement timeout — set explicitly.
  3. Lexical branch by language:
     - en: `ts_rank(tsv, plainto_tsquery('english', query))`.
     - sc/tc: `ts_rank(to_tsvector('simple', cjk_tokens), plainto_tsquery('simple', cjkTokens(query)))` blended with `cjk_tokens % query` trgm similarity.
  4. Fuse with RRF `1/(60+rank)` (SQL or app), dedupe `(nid,chunk_no)` / `(judgmentId,chunk_no)` as today.
  5. Emit top-30 to reranker; snippet via `ts_headline(content, query)` (lexical) / `left(content,300)` (vector-only).
  6. Return `{..., lexical_rank, vector_distance, rrf_score, snippet}`; drop `rerankerScore/captionHighlights` at this layer.
- **Acceptance:** top-30 per query; dedupe holds; `topic`/`languageCode` filters work; sc/tc path returns rows (ex-501 fixed); in-DB vs app-embed paths return equivalent top-15 on 10 sample queries.
- **Depends on:** T07 (+ T01 settings for in-DB path). **Blocks:** T09, T10.
- **Size:** L.
