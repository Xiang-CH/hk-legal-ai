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

---

## Implementation (2026-09-22, branch `migration-single-postgres`, uncommitted)

Deviates from the draft in two deliberate ways:
- **One round-trip per (query × corpus), mixed lanes**: `language_code = ANY($langs)` with
  per-row `CASE ON language_code` instead of one query per `$lang` (see `src/lib/pg-search.ts`).
  Lanes auto-detect: CJK query → `['sc','tc']`, else `['en']`; overridable via `languageCodes`.
- **App-side embeddings only**: caller (`route.ts`) embeds each rewritten query ONCE via
  `getEmbeddings()` and shares the 3072-d vector across clic/judgment (/legislation in T10).
  No `azure_openai.create_embeddings` in-DB path — avoids DB outbound + timeout coupling.

Files:
- `src/lib/cjk.ts` (new) — `cjkTokens()` copy of `scripts/cjk.ts` (do NOT import scripts/ into
  the Next bundle) + `containsCjk()` lane detector. Keep both files in sync.
- `src/lib/pg-search.ts` (new) — `searchClicChunks` / `searchJudgmentChunks` /
  `searchLegislationChunks` (`$1 query, $2 cjkquery, $3 emb::halfvec(3072), $4 langs[]`, `[$5 topics]`
  clic-only). Explicit `::int` / `::float8` casts so raw pg `bigint`/`numeric` never leak to JSON.
- `src/app/api/chat/helper.ts` — `searchClic` / `searchJudgmentSummary` rewritten as thin pg
  generators (yield shape unchanged: `score`←`rrf_score`, `caption`←snippet; `rerankerScore` /
  `captionHighlights` dropped). New `searchLegislation` (resolves `capTitle` via one Prisma
  lookup) — implemented, **not wired into route.ts yet (T10)**.
- `src/app/api/chat/route.ts` — Azure `SearchClient` construction + missing-env throws deleted
  (they crashed pg-only boot at import); embeddings precomputed per query and shared;
  `providerMetadata.custom` drops `rerankerScore`/`captionHighlights`. Legislation graph
  traversal + UI contract otherwise untouched. `@azure/search-documents` dep removal → T10.
- `src/lib/types.ts` — optional `lexical_rank / vector_distance / rrf_score / snippet` on all
  three schemas. `npx tsc --noEmit` clean.

## Verify (you run — needs DB + `DATABASE_URL`, read-only except embedding calls)

1. `npx tsc --noEmit` → clean (done in implementation).
2. Smoke, ~10 queries en + CJK (replace `$EMB` with one `getEmbeddings()` output or any
  3072-d vector literal). Clic example:
  `psql $DATABASE_URL -c "SELECT ... "` — or quickest: run the app (`npm run dev`), ask an EN
  question + a Chinese question, confirm `source-url` entries appear for clic + judgment and
  the answer cites them.
3. Acceptance checklist: top-≤30 per query per corpus · dedupe by `(nid,chunk_no)` /
  `(judgmentId,chunk_no)` holds in the streamed sources · `topics` filter path (pass
  `{ embedding, topics: [...] }`) narrows clic rows · CJK query hits the `simple`+trgm branch
  (no ex-501; sc/tc rows appear once T17 sc/tc lands — EN-only data returns vector-only hits
  with `left(content,300)` snippets for now).
4. Context-size watch: 3 queries × 30 rows × 2 corpora is far more context than the old
  top-10/top-8 — if answers get truncated, cap per-query yields before T09 lands.
