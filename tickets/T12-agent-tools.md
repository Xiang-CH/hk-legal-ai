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

## Implementation notes (T12 done)
- **File:** `src/lib/search-tools.ts` (only source file; all schemas/types local for T16).
- `tool()` from `ai` v7 + zod v4 schemas; `searchTools` record exported for T13-T15 wiring.
- Retrieval path per search_* tool: `getEmbeddings` (helper.ts, text-embedding-3-large) → `search*Clic/Judgment/LegislationChunks` (pg-search.ts fusion top-30) → in-tool `(id,chunk_no)` dedupe → `fuseRerank` (applyRerank, rerank timeout 2s, any failure → fusion order + `rerank_score: null`).
- CLIC `topic` and `languageCode` are preferred filters: an empty preferred result set retries once over English/all topics because the current corpus stores internal topic keys and has sparse language lanes.
- `RERANK_ENABLED=false` path needs no branch: `rerankScores` returns null internally → fusion order, scores null. Verified by reading `src/lib/rerank.ts`.
- `search_legislation` graph follow-up (depth ≤ 2): top-10 sectionIds → one `legislationSection.findMany` with `referencingLegislationSections` (1 level, take 5) + `referencedByClicPages` nids (take 5). No-keywords path fabricates `{chunk_no: 0, rrf_score: 0→null}` rows from a direct `legislationSection` id lookup so the graph walk still runs.
- `get_ordinance_section` / `get_case` match the arg names promised in `src/lib/prompts/search.ts` (`cap_no`/`section_no`, `action_no`/`case_name`); `get_case` uses `contains, mode: insensitive`, take 5/5 caps.
- `withToolSpan`: `startActiveObservation("tool:<name>")` with truncated input/output; falls back to running spaceless outside an active trace (unit smoke). `void GRAPH_DEPTH_CAP` keeps the cap self-documenting (value 2, enforced structurally: sections + 1 related level).
- **Verify:** `tsc --noEmit` zero errors (non-.next), `eslint src/lib/search-tools.ts` clean, no Azure imports.

## Live-smoke (user runs: needs DB + Azure embed + optional rerank)
Unit-call each tool outside the chat loop, e.g. via a scratch route/script inside an observed handler (spans need an active trace; without one the tools still return data, just spaceless):
1. `search_clic {query: "unfair dismissal notice period", topic: "Employment"}` → expect ≤10 items, each with `rrf_score` + `rerank_score` (null when `RERANK_ENABLED=false`).
2. `search_judgments {query: "adverse possession limitation period"}` → expect ≤8 items.
3. `search_legislation {keywords: "sex discrimination employment", capNumber: "480"}` → chunks + `related[]` + `clicNids[]`; then `{capNumber: "57"}` alone → direct-lookup path (`rrf_score: null`).
4. `get_ordinance_section {cap_no: "57", section_no: "7"}` → full text + `capTitle`.
5. `get_case {case_name: "Cheung"}` and `{action_no: "<known caseAct>"}` → case + ≤5 judgments each; `{}` → `{error}` string (failure-injection check: also try `search_clic {query: ""}`).
6. Langfuse: confirm `tool:search_clic|search_judgments|search_legislation|get_ordinance_section|get_case` spans with input/output on a traced call.
