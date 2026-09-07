# T10 — Runtime rewrite + dead-code deletion

- **Goal:** chat + clic-search run on pg; Azure Search/SQL code gone.
- **Scope/files:** `src/app/api/chat/route.ts`, `src/app/api/clic/search/route.ts`, `src/app/api/db/wake`, `src/app/api/db/status`, `azure-ai-search-schema/`, `package.json`, env docs.
- **Steps:**
  1. `chat/route.ts`: delete 2× `SearchClient` + `AZURE_SEARCH_*` guards; wire pg Prisma + embedding + rerank; keep rewriteQuery→parallel search→legislation-graph flow.
  2. `clic/search/route.ts`: pg fusion SQL; `topic = ANY` filter; implement sc/tc (remove 501).
  3. Delete `db/wake`, `db/status`, `@azure/arm-sql`, `@azure/search-documents` (if unused), `azure-ai-search-schema/`.
  4. Env: remove `AZURE_SEARCH_*`, `CLIC_INDEX_NAME`, `JUDGMENT_SUMMARY_INDEX_NAME`, SQL vars; add pg `DATABASE_URL`, `RERANK_*`, `USE_PG_SEARCH`; keep `AZURE_OPENAI_*`, `HKLII_BASEURL`.
- **Acceptance:** `grep -r "search-documents\|arm-sql\|AZURE_SEARCH" src scripts` empty; `tsc` + lint clean; both routes answer on pg.
- **Depends on:** T08, T09. **Blocks:** T11.
- **Size:** M.
