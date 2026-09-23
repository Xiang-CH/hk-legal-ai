# Single-Postgres Migration Plan (DB + Search)

Shared understanding locked from grill R1–R4 + update: **original Azure Search index lost — chunks/embeddings must be rebuilt from source, not COPYed from Azure.**

## 0. Decisions baked in

- **Goal:** one Azure Postgres for relational + hybrid search, no external Azure AI Search index.
- **Host:** **new** Azure Database for PostgreSQL Flexible, PG 16+, General Purpose >= 8GB RAM (HNSW 3072-d build needs memory), same region as app. (Actual: PG18, 4GB — temp scale-up advised for T07.)
- **In-DB AI: `azure_ai` extension (NEW).** Allowlisted on Flexible — `CREATE EXTENSION azure_ai` (+ `vector`, `pg_trgm`, `unaccent`). Pins model access in DB via `azure_ai.set_setting` (OpenAI endpoint/key + `azure_ml.serverless_ranking_endpoint` + `azure_ml.serverless_ranking_endpoint_key` for Cohere serverless); query embeddings via `azure_openai.create_embeddings`, rerank via `azure_ai.rank` (default model `cohere-rerank-v3.5`). App-side embed/rerank clients stay as fallback; extension itself is GA but its **AI functions** are labeled **Preview** in MS docs — pin version, verify signatures per server (`SELECT azure_ai.version()` + `pg_proc` discovery in T01).
- **Embeddings:** keep `text-embedding-3-large` 3072-d via Azure OpenAI (query-time + rebuild).
- **Chunk shape:** separate `clic_chunks` + `judgment_chunks`, FK to parents (Q9a).
- **Retrieval:** Postgres fusion (lexical + vector -> RRF k=60, take top-30) -> Azure AI Foundry **Cohere rerank-v3.5** -> final top-10 CLIC / top-8 judgments, behind `RERANK_ENABLED` flag (Q8b, Q11, Q15).
- **Snippets:** drop Azure extractive `caption/highlights`, use `ts_headline` snippet — contract change in `chat.tsx`/`groundings-display.tsx` (Q12c1).
- **Relational port:** fresh Prisma baseline per recommendations (Q16).
- **Build mode: REBUILD (not COPY from Azure).** The Azure index is gone, so there is nothing to export. Re-chunk from relational source + re-embed everything, then load Postgres. Local `scripts/index-output/chunks-en.json` (3244 chunks, 3072-d present) + `judgment-summaries.json` (217 chunks, 3072-d present) may seed EN to save cost, but they are NOT the full corpus — treat as cache, verify against DB, rebuild the rest. 100K-chunk scale assumed (Q10).
- **Out of scope per Q17:** eval gate omitted from this plan.

## 1. Infra — provision Flexible Server

1. Create Flexible Server (done: PG18, 4GB — keep `maintenance_work_mem` ≤1GB or temp scale-up for T07). Allowlist: `vector`, `pg_trgm`, `unaccent`, **`azure_ai`**. **zhparser unavailable — DECIDED:** app-side CJK bigrams (`cjk_tokens`) + `simple` + `pg_trgm` (Q7a).
2. `CREATE EXTENSION ...` each: `vector`, `pg_trgm`, `unaccent`, **`azure_ai`** (no zhparser, no pg_textsearch — both uninstallable on Flexible). Record `SELECT azure_ai.version();` + signature discovery; set `azure_openai.endpoint/subscription_key` and `azure_ml.serverless_ranking_endpoint` + `azure_ml.serverless_ranking_endpoint_key` via `azure_ai.set_setting` (managed identity preferred); `GRANT azure_ai_settings_manager` to loader role.
3. Tune for load: raise `maintenance_work_mem` for index build (1–2GB), set `hnsw.ef_search=40` for queries. Revert `maintenance_work_mem` after build.
4. Networking: firewall/VNet for app + admin, new pg `DATABASE_URL`; keep old Azure SQL vars read-only until swap. Azure Search vars are dead (index lost) — remove after rewrite.

## 2. Prisma + DDL — port SQL Server → Postgres

1. `prisma/schema.prisma`: `provider "sqlserver"` → `"postgresql"`, `@prisma/adapter-mssql` → `pg` adapter (`@prisma/adapter-pg` + `pg` pool).
2. Types: all `@db.NVarChar(max)` → `@db.Text`; `autoincrement()` → Postgres identity (Prisma handles); verify composite FKs `[capNumber, languageCode]` on `LegislationSection/Cap/Interpretation` still validate; check `String` collation (SQL Server case-insensitive vs Postgres case-sensitive).
3. Add new models (Q9a):
   - `ClicChunk(nid, chunk_no, title, content, url, topic, context, embedding vector(3072), tsv tsvector, cjk_tokens?, @@id([nid, chunk_no]), @@index([nid]), FK to parent)`
   - `JudgmentChunk(judgmentId, chunk_no, neutralCitation, courtName, year, date, parties, summary, summarySource, url, embedding vector(3072), tsv tsvector, @@id([judgmentId, chunk_no]), FK to Judgment)`
   - Use `Unsupported("vector(3072)")` in Prisma + raw SQL for HNSW/GIN.
4. Fresh `prisma migrate` baseline on the empty new server. Do NOT replay SQL Server migrations.

## 3. Relational data — COPY, not dump

1. Port `scripts/insert-clic|legislation|judgment.ts` to pg: read same source JSONs, batch `createMany` / `COPY`, preserve `nid/languageCode`, `capNumber/sectionNumber`, judgment IDs (stable keys used by chunks).
2. Load order (respect FKs): `LegislationCap → LegislationSection → Interpretation → ClicPage → Case → Judgment → ParallelCitations`.

## 4. Chunk rebuild — re-chunk + re-embed from source (index lost)

Why rebuild: the Azure index is gone, so the old `uploadIndexByBatch → searchClient.mergeOrUploadDocuments` path has no source to export from. Build chunks from Postgres/relational content instead.

1. Re-chunk from source of truth (mirrors `scripts/index-clic.ts` / `index-judgment-summary.ts`, retargeted to Postgres):
   - CLIC: read `ClicPage(content, title, url, topic, context)` per `languageCode` (en + sc + tc) → `TokenTextSplitter(512/128, o200k_base)` → `(nid, chunk_no, title, content, url, topic, context)`.
   - Judgments: read `Judgment(summary, ...)` → same splitter → `(judgmentId, chunk_no, neutralCitation, courtName, year, date, parties, summary-chunk, summarySource, url)`.
   - Keep the same chunking params so behavior matches the old index; write one JSON per language (`chunks-en/sc/tc.json`) as checkpoint, same shape as today (with `embedding`).
2. Re-embed, either path (spike both): **(A)** existing app batcher (`getEmbeddingsByBatch`, batch 100, `text-embedding-3-large`), per-batch JSON checkpoint (resumable); or **(B, NEW) in-DB** `UPDATE ... SET embedding = azure_openai.create_embeddings('<DEPLOYMENT>', content)::vector WHERE embedding IS NULL` (in-DB batch default 100, resumable via the `IS NULL` predicate; explicit `dimensions` only if ext ≥ 1.1.0). 100K chunks ≈ 1000+ calls either way — budget time + $$ before running.
3. Shortcut: `index-output/chunks-en.json` (3244 chunks, embeddings present) and `judgment-summaries.json` (217) can be loaded first to get EN working early — but diff `nid/chunk_no` against freshly chunked DB rows; any missing/changed chunks go through step 2. Do NOT assume they cover sc/tc or the full corpus.
4. Load Postgres: `COPY` chunk JSONs (fresh + cached EN) into `clic_chunks` / `judgment_chunks`, then populate `tsv` (`english` for en; `simple` + bigram `cjk_tokens` for sc/tc).
5. **After** COPY: `CREATE INDEX ... USING hnsw (embedding halfvec_cosine_ops) WITH (m=16, ef_construction=64); (columns are halfvec(3072); HNSW on vector caps at 2000 dims)` + `GIN(tsv)` + `GIN(content gin_trgm_ops)` per chunk table.

## 5. Search SQL — replace Azure hybrid

Replace `searchClic()` / `searchJudgmentSummary()` in `src/app/api/chat/helper.ts`:

- Inputs: rewritten query (up to 3, as today) + `languageCode` + `topic` filter passthrough.
- Per query: run lexical (`ts_rank(tsv, plainto_tsquery/to_tsquery)`, `ORDER BY rank LIMIT 15`) and vector in parallel, fuse with RRF `1/(60+rank)` in SQL or app, dedupe on `(nid,chunk_no)` / `(judgmentId,chunk_no)` as today. Vector ordering **in-DB (NEW primary)**: `embedding <=> azure_openai.create_embeddings('<DEPLOYMENT>', $query)::vector` (single round-trip); app `getEmbeddings()` → `$emb` stays as fallback.
- Keep `top:10` CLIC / `top:8` judgments final after rerank; keep `top-30` pre-rerank.
- Snippet: `ts_headline(content, query)` for lexical hits, `left(content,300)` for vector-only.
- Return `{..., score/lexical_rank/vector_distance/rrf_score, snippet}` — **drop** `rerankerScore/captionHighlights` from Postgres layer (reranker adds its own score next step).

## 6. Reranker — Foundry rerank-v3.5

1. Deploy Cohere `rerank-v3.5` as Foundry serverless PAYG endpoint; wire endpoint + key into **DB settings** (`azure_ml.serverless_ranking_endpoint` + `azure_ml.serverless_ranking_endpoint_key`); record endpoint, model version, pricing. Keep `RERANK_ENDPOINT/KEY/MODEL` env only for the app-HTTP fallback path.
2. **Primary (NEW): in-DB** `azure_ai.rank($query, $docs, $ids)` → `(id, rank, score)` (default model `cohere-rerank-v3.5`) on fusion top-30 **raw chunk text** (not snippets), map back to chunk IDs, slice final top-10/8; **fallback:** app HTTP client. Gate with `RERANK_ENABLED=true|false` so fusion-only works on failure/budget.
3. Replace UI `providerMetadata.custom.rerankerScore/caption` with `{rrf_score, rerank_score, snippet}`; update `route.ts` writers + `groundings-display`.

## 7. Runtime + scripts rewrite

- `src/app/api/chat/route.ts`: delete `SearchClient` x2 + `AZURE_SEARCH_*` guards, instantiate pg Prisma + embedding + rerank clients; keep rewriteQuery → parallel CLIC/judgment → SQL legislation graph (unchanged graph query, just pg).
- `src/app/api/clic/search/route.ts`: replace `searchClient.search` with same Postgres fusion SQL; keep `topic` filter (`topic = ANY` instead of `search.in`), implement `languageCode` sc/tc path (currently 501).
- Delete: `src/app/api/db/wake`, `src/app/api/db/status`, `@azure/arm-sql`, `azure-ai-search-schema/`, `uploadIndexByBatch` (no Search to upload to).
- Env: remove `AZURE_SEARCH_*`, `CLIC_INDEX_NAME`, `JUDGMENT_SUMMARY_INDEX_NAME`, Azure SQL vars; add pg `DATABASE_URL`, `RERANK_ENABLED` (+ `RERANK_*` only for app-fallback path); keep `AZURE_OPENAI_*` (app fallback + T06-A) + `HKLII_BASEURL`. Model credentials for in-DB paths live in DB (`azure_ai.set_setting`), not app env.
- Scripts: `insert-*` → pg COPY; `index-*` rewritten as chunk-rebuild + embed + COPY-to-Postgres (steps §4.1–4.2), Search-upload code deleted.

## 8. Cutover (rebuild-aware)

1. Build new server fully offline (steps 1–4). Postgres IS the index now — no Azure index to sync.
2. Deploy app with `USE_PG_SEARCH=true`; keep Azure SQL read-only as rollback for relational data only (search rollback to Azure is impossible — index lost — so gate on smoke tests).
3. Smoke: rewritten queries → CLIC + judgments + legislation graph return; rerank on/off toggle works.
4. Swap traffic; monitor Foundry latency/cost + pg `ef_search`/HNSW recall. Re-embed deltas as source content changes (no external indexer to run).
5. Delete Azure Search resources/keys + dead code.

## 9. Risks

- **Rebuild cost/time (new):** 100K × 3072-d re-embed ≈ 1000+ batched API calls — hours + real $$$. Mitigated by resumable per-batch checkpoints + EN cache first.
- **No zhparser/pg_textsearch:** decided — app bigrams + built-ins only; no extension risk left.
- **3072-d HNSW:** slow build + RAM; mitigated by COPY-then-index + tuned `maintenance_work_mem`.
- **Foundry rerank:** new latency (~300–800ms) + per-call cost + multilingual quality on sc/tc to watch; flag mitigates outage.
- **Contract churn:** any UI beyond `chat.tsx` reading `caption/captionHighlights` must move to `snippet`.
- **No search rollback:** old index is gone — Postgres must pass smoke before swap.

## 10. Agentic search — model decides when/what to search (NEW workstream)

Depends on T08 (fusion SQL) + T09 (rerank); runs after or alongside T10. Behind `AGENTIC_SEARCH_ENABLED` flag with legacy fan-out fallback.

### 10.1 Why / what changes

Today `route.ts` is a fixed pipeline: `rewriteQuery` (always, ≤3 queries) → mandatory parallel fan-out (CLIC × N + judgments × N on Azure) → legislation graph walk from CLIC nids (`searchDepth`, ≤4 nested includes, 10s timeout) → all results stuffed as XML into one `streamText` call. Problems: every turn pays full fan-out even for greetings/follow-ups; `searchPrompt` advertises `get_ordinance_or_regulation` / `get_case` tools that **don't exist** (no `tools` passed to `streamText`); `rewriteQuery` + fan-out duplicate what a tool-calling model can do in-loop.

Target: single agent loop on **AI SDK 7 `ToolLoopAgent`** (T16 upgrades `ai@5.0.0` → 7.x first; `ToolLoopAgent` bundles model + instructions + tools + `stopWhen`, thin wrapper over `streamText` with the same OTel spans): model reasons → calls search tools with its own queries → reads results → refines/searches more or answers. No mandatory rewrite, no mandatory fan-out.

### 10.2 Tool set (each = thin wrapper over T08 fusion + T09 rerank)

- `search_clic {query, topic?, languageCode?}` → top-10 CLIC chunks (`{nid, chunk_no, title, content/snippet, url, rrf_score, rerank_score}`).
- `search_judgments {query, languageCode?}` → top-8 judgment chunks (same shape).
- `search_legislation {capNumber?, sectionNumber?, keywords?}` → ranked sections via pg (replaces the nid-graph walk; graph walk stays as its internal follow-up, depth-capped).
- `get_ordinance_section {cap_no, section_no}` → full section text (implements the tool `searchPrompt` already promises).
- `get_case {action_no?, case_name?}` → full judgment/summary (implements the second promised tool).
- Tool results carry `snippet` (not Azure `caption`) per T08/T09 contract; dedupe on `(nid,chunk_no)` / `(judgmentId,chunk_no)` inside tools, not the route.

### 10.3 Loop + guardrails

- `new ToolLoopAgent({model: azure(LLM_MODEL), instructions: <rewritten searchPrompt with tool-use policy>, tools, stopWhen: stepCountIs(maxSteps)})` defined once; route calls `agent.stream(...)` + `createAgentUIStreamResponse`. `rewriteQuery` deleted (model generates its own queries per tool call); `searchDepth` request param replaced by `maxSteps` (default 5, cap 8).
- Per-tool timeout (10s, same as today's SQL guard); tool failure returns `{error}` string to model, never throws (loop continues); `RERANK_ENABLED=false` path preserved inside tools.
- Cost/latency: worst case 5 steps × (embed + fusion + rerank); record p50/p95 in T15 smoke; kill-switch `AGENTIC_SEARCH_ENABLED=false` restores legacy fan-out.

### 10.4 Prompt + streaming changes

- Rewrite `search.ts` prompt: tool-use policy (which corpus for what: CLIC = plain-language explanations, legislation = exact ordinance text, judgments = case examples; always search before citing; never answer Hong Kong law from parametric memory), inline-citation rules unchanged.
- Delete dead tool mentions or implement them (done via §10.2). Remove `query-extend.ts` when legacy path is removed.
- Streaming: manual `source-url` writes move to tool-result mapping (`InferAgentUIMessage<typeof agent>` replaces `MyUIMessage` for typed tool parts) (tool output → `source-url` parts with `rrf_score/rerank_score/snippet`); `toUIMessageStream` already forwards tool parts — T11 UI must render tool-invocation states (searching… indicators replace today's notification writes).

### 10.5 Observability

- Keep `experimental_telemetry` (tool calls auto-span); wrap each tool body in `startActiveObservation("tool:<name>")` with input/output, matching today's `search-clic`/`search-judgment-summary`/`search-legislation-sql` spans so Langfuse dashboards keep working.
