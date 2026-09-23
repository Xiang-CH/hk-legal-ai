# T09 — Rerank: in-DB azure_ai.rank vs app HTTP (Cohere rerank-v4.0-fast) + flag

- **Goal:** fusion top-30 → rerank → final top-10 CLIC / top-8 judgments, flaggable; spike in-DB path first, keep app HTTP as fallback.
- **Scope/files:** Foundry Cohere serverless deploy + T01 settings + app rerank client (new `src/lib/rerank.ts` or in `helper.ts`), env `RERANK_ENABLED` (+ `RERANK_ENDPOINT/KEY/MODEL` for app-fallback path only).
- **Steps:**
  1. Deploy Cohere rerank serverless PAYG on Foundry; record endpoint, model version, pricing. Wire into DB (T01 step 4): `azure_ml.serverless_ranking_endpoint` + `azure_ml.serverless_ranking_endpoint_key` (endpoint shape `https://<DEPLOY>.<REGION>.models.ai.azure.com/<v1|v2>/rerank`; managed-identity alternative needs "Azure Machine Learning Data Scientist" role).
  2. **Primary (NEW): in-DB rank** — `SELECT * FROM azure_ai.rank($query, $docs_array, $ids_array);` returns `(id, rank, score)`; server default was `cohere-rerank-v3.5` — app default is now `cohere-rerank-v4.0-fast` (verify via T01 signature discovery; pass explicit model arg only if needed). Feed fusion top-30 **raw chunk text** (not snippets), map `id→rank/score` back, slice 10/8.
  3. **Fallback (app HTTP):** keep direct Foundry HTTP client for when DB rank errors/times out; `RERANK_ENABLED=false` returns fusion-only; any rerank failure falls back to fusion (no 500s).
- **Acceptance:** toggle on/off works; final counts exact (10/8); in-DB vs app paths agree on top-k for 10 sample queries (ordering sanity); p95 rerank overhead recorded; failure injection still returns fusion results.
- **Depends on:** T08 (+ T01 rank settings). **Blocks:** T10.
- **Size:** M.

---

## Implementation (2026-09-22, branch `migration-single-postgres`)

**Decision change: app-side HTTP is the working path; in-DB `azure_ai.rank` deferred.**
`azure_ai.rank()` exists on this server (2-arg + 3-arg overloads, default model
`cohere-rerank-v4.0-fast`), but the settings key is rejected:
`Setting "azure_ml.serverless_ranking_endpoint" is not a valid configuration key`
(T01 step 4's `azure_ml.scoring_endpoint` / `azure_ml.serverless_ranking_key` are
unverified guesses). Until the correct key is discovered (you run, as admin on
`clic_chat`, the T01 step 3 discovery SQL), rerank runs in the app — no DB change needed.

- **Files:**
  - `src/lib/rerank.ts` (new) — `rerankScores()` POSTs Cohere-native
    `{model, query, documents, top_n}` to `RERANK_ENDPOINT` (paste the FULL URL from the
    Foundry deployment details, incl. the `/v1|/v2/rerank` path); sends both `api-key`
    and `Authorization: Bearer` headers (covers Azure MaaS + Cohere-native).
    `applyRerank()` maps scores back to items and slices top-N. ANY failure (disabled /
    env missing / non-200 / 15s timeout / bad shape) returns to fusion order — no 500s.
  - `helper.ts` — `searchClic` (top-10) / `searchJudgmentSummary` (top-8) /
    `searchLegislation` (top-10, still unwired until T10) feed fusion top-30 **raw chunk
    `content`** (4000 chars/doc cap) through `applyRerank`.
  - `types.ts` — `rerank_score` optional on all three schemas (`rerankerScore` kept for UI compat).
  - `route.ts` — `providerMetadata.custom` gains `rerank_score` (clic + judgment).
- **Env (app runtime, not repo):** `RERANK_ENABLED=false` (default: fusion-only slice,
  zero behavior change) / `RERANK_ENDPOINT=` / `RERANK_KEY=` / `RERANK_MODEL=cohere-rerank-v4.0-fast`
  (optional default). `npx tsc --noEmit` clean at implementation time.
- **Left for T10/T11:** in-DB vs app top-k agreement check + p95 overhead (needs live
  endpoint); UI switch from `rerankerScore/caption` to `{rrf_score, rerank_score, snippet}`.
- **In-DB follow-up (optional, you run):** discover the correct `azure_ml.*` setting key
  and record it here; app path stays as fallback either way.

## Verify (you run — needs app + optional Foundry Cohere deploy)

1. `RERANK_ENABLED=false` (or unset): ask anything → sources stream exactly as T08
   (fusion order, `rerank_score: null`).
2. Set `RERANK_ENDPOINT/KEY`, `RERANK_ENABLED=true`, restart dev, ask 2–3 questions →
   result order should differ from (1) on at least some queries; no `[rerank]` warnings
   in the server log.
3. Failure injection: wrong `RERANK_KEY` → still returns fusion results + console warn,
   chat stays 200.

## Reorder fix (2026-09-22, uncommitted): rerank AFTER the cross-query merge

- **Problem:** rerank ran per rewritten query *before* the merge, so (a) final LLM
  context order was arrival order — per-query rerank scores were never compared
  globally; (b) each turn fired up to 6 rerank calls (3 queries x 2 corpora) -> 429s.
- **New order:** per-query fusion top-30 -> merge/dedupe in `route.ts` (best `rrf_score`
  wins) -> top-30 by global RRF (`RERANK_CANDIDATE_CAP`) -> ONE `applyRerank` per corpus
  against the **original user question** (`rerankQuery`, not rewritten queries) ->
  global top-10 clic / top-8 judgment. 2 rerank calls/turn max.
- `helper.ts` generators are fusion-only again; `RERANK_TOP_*` exported for the route.
  Legislation nid lookup uses merged fusion candidates (pre-rerank) so graph recall
  isn't narrowed to the reranked top-10. `rerankScores` skips empty queries.
- Retry on 429/5xx (2x, honors `Retry-After`, 10s cap); any terminal failure still
  falls back to fusion order. Default model `cohere-rerank-v4.0-fast`.

## Cost summary (2026-09-22, uncommitted)

- Rerank accounting is request-scoped (`createRerankUsage()` per turn in `route.ts`,
  threaded through both `applyRerank` calls): `{calls, documents, succeeded}`.
- `onFinish` attaches `rerankCalls / rerankDocuments / rerankCost` to the
  `message-metadata` usage object; dev-mode cost block in `message.tsx` shows
  `Rerank: N calls / M docs ($X)` and adds it to Total Cost.
- Cohere bills per search (call), not per doc, so cost = `calls x RERANK_COST_PER_CALL`.
  Set `RERANK_COST_PER_CALL` (USD, e.g. `0.002` for $2/1k searches) from the Foundry
  portal pricing — default 0 (counts shown, cost $0 until set).
