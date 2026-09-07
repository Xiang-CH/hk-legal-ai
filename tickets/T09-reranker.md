# T09 — Rerank: in-DB azure_ai.rank vs app HTTP (Cohere rerank-v3.5) + flag

- **Goal:** fusion top-30 → rerank → final top-10 CLIC / top-8 judgments, flaggable; spike in-DB path first, keep app HTTP as fallback.
- **Scope/files:** Foundry Cohere serverless deploy + T01 settings + app rerank client (new `src/lib/rerank.ts` or in `helper.ts`), env `RERANK_ENABLED` (+ `RERANK_ENDPOINT/KEY/MODEL` for app-fallback path only).
- **Steps:**
  1. Deploy Cohere rerank serverless PAYG on Foundry; record endpoint, model version, pricing. Wire into DB (T01 step 4): `azure_ml.serverless_ranking_endpoint` + `azure_ml.serverless_ranking_endpoint_key` (endpoint shape `https://<DEPLOY>.<REGION>.models.ai.azure.com/<v1|v2>/rerank`; managed-identity alternative needs "Azure Machine Learning Data Scientist" role).
  2. **Primary (NEW): in-DB rank** — `SELECT * FROM azure_ai.rank($query, $docs_array, $ids_array);` returns `(id, rank, score)`; default model IS `cohere-rerank-v3.5` (verify via T01 signature discovery; pass explicit model arg only if needed). Feed fusion top-30 **raw chunk text** (not snippets), map `id→rank/score` back, slice 10/8.
  3. **Fallback (app HTTP):** keep direct Foundry HTTP client for when DB rank errors/times out; `RERANK_ENABLED=false` returns fusion-only; any rerank failure falls back to fusion (no 500s).
- **Acceptance:** toggle on/off works; final counts exact (10/8); in-DB vs app paths agree on top-k for 10 sample queries (ordering sanity); p95 rerank overhead recorded; failure injection still returns fusion results.
- **Depends on:** T08 (+ T01 rank settings). **Blocks:** T10.
- **Size:** M.
