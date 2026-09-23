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

## Implementation notes (2026-09-22)

- Step 1 was already done in T08/T09 (pg fusion + global rerank, graph walk kept per plan §7). T10 only removed the stale leftover comment in `chat/route.ts`.
- Step 2: `clic/search/route.ts` rewritten on `searchClic` (pg fusion) + `getEmbeddings`. `filter` (topic list) passes through to `topics` (`topic = ANY($)`); `language_code`/`language` selects the lane — sc/tc served, 501 removed. Fusion top-30 sliced by `top` (capped 30) / `skip`. Response keeps `{results, clicPages}`; `score` = rrf_score, `caption` = snippet; `rerankerScore/captionHighlights` dropped per plan §7. No rerank in this route (no callers; chat flow owns rerank). No live callers in the app (the `/search` navbar link is commented out) — T11 decides whether to keep or drop the route.
- Step 3: deleted `api/db/wake`, `api/db/status`, `hooks/db-status.ts`, `azure-ai-search-schema/` (only `clic-page.json`, unreferenced). Navbar DB-status pill removed with the hook (pg Flexible Server is always-on — pause/resume concept gone; T11 can re-add a pg health pill if wanted). Deps removed from `package.json`: `@azure/arm-sql`, `@azure/identity` (only used by status route), `@azure/search-documents`, plus `@ai-sdk/azure` (only an unused import in `helper.ts`, also removed). Run `pnpm install` to prune `node_modules`.
- Step 4: `.env` — `AZURE_SEARCH_*`/index names were already commented; commented out `AZURE_SQL_*` management vars + `AZURE_API_KEY`/`AZURE_RESOURCE_NAME` (dead, no refs in src). `USE_PG_SEARCH` NOT added: pg is the sole backend, no fallback left to toggle. `DATABASE_URL_SQLSERVER_BACKUP` kept (relational rollback, plan §8). `searchLegislation` helper stays unwired in chat (graph kept per plan §7) — it feeds the T12 agent tool library.
- Acceptance: `grep -rn "ai-sdk/azure\|search-documents\|arm-sql\|azure/identity" src --include=*.ts,*.tsx` empty (scripts were already clean); `tsc --noEmit` + `eslint` on touched files clean.
