# T12 — Agent tool library (pg search tools)

- **Goal:** 5 typed tools wrapping T08 fusion + T09 rerank, callable by the model.
- **Scope/files:** new `src/lib/search-tools.ts` (or `src/app/api/chat/tools.ts`): `search_clic`, `search_judgments`, `search_legislation`, `get_ordinance_section`, `get_case` via AI SDK `tool()` + zod schemas.
- **Steps:**
  1. `search_clic {query, topic?, languageCode?}` → T08 CLIC fusion top-30 → T09 rerank → top-10 `{nid, chunk_no, title, snippet, url, rrf_score, rerank_score}`; dedupe `(nid,chunk_no)` inside.
  2. `search_judgments {query, languageCode?}` → same → top-8.
  3. `search_legislation {capNumber?, sectionNumber?, keywords?}` → pg section search; keep nid-graph walk (T10) as internal follow-up, depth-capped.
  4. `get_ordinance_section {cap_no, section_no}` + `get_case {action_no?, case_name?}` → full-text fetch (fulfills existing `searchPrompt` promises).
  5. Each tool: 10s timeout, failure returns `{error}` string (never throws), `RERANK_ENABLED=false` path preserved, `startActiveObservation("tool:<name>")` span with input/output.
- **Acceptance:** all 5 tools unit-callable with sample args; failure injection returns error string; Langfuse shows `tool:<name>` spans; no Azure Search imports.
- **Depends on:** T16 (zod compat), T08, T09. **Blocks:** T13, T14.
- **Size:** L.
