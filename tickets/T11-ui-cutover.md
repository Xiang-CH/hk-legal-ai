# T11 — UI contract + cutover + swap

- **Goal:** UI shows pg results; traffic on new server; Azure Search deleted.
- **Scope/files:** `src/components/*` (`chat`, `groundings-display`, citation/source rendering), deploy config.
- **Steps:**
  1. Replace `rerankerScore/caption/captionHighlights` rendering with `{rrf_score, rerank_score, snippet}`; handle `RERANK_ENABLED=false` (no rerank score).
  2. Deploy with `USE_PG_SEARCH=true`; keep Azure SQL read-only as relational rollback (no search rollback — index lost).
  3. Smoke: rewritten queries → CLIC + judgments + legislation graph; rerank on/off; sc/tc query returns.
  4. Swap traffic; watch Foundry latency/cost + pg recall; then delete Azure Search indexes/keys + dead env.
- **Acceptance:** no UI references to `caption`; smoke passes incl. sc/tc; Azure Search resources deleted post-swap.
- **Depends on:** T10. **Blocks:** nothing.
- **Size:** M.

## Implementation notes (T11 agent, 2026-09-22)
- `src/components/groundings-display.tsx`: `SourceGroup` now reads the pg
  contract `{ rrf_score, rerank_score, snippet }` with compat fallback
  (`score`~=rrf, `caption`~=snippet, `rerankerScore`~=rerank). Display line is
  `Rerank: x · RRF: y` when reranked, else `RRF: y` (covers
  `RERANK_ENABLED=false`, where the route writes `rerank_score: null`).
  `captionHighlights` no longer read anywhere in `src/components` (dead since
  T08 — the route never writes it).
- Post-rerank-only rule verified: the route writes `source-url` parts solely
  from `rerankedClic` / `rerankedJudgment` finals (top-10 clic / top-8
  judgment) and the SQL legislation finals; `GroundingsDisplay` renders exactly
  those parts (`chat.tsx` passes last-message `source-url` parts). No
  fusion-candidate surface was added.
- `src/app/api/chat/route.ts` writers: additive-only — clic/judgment writers
  now also emit `rrf_score` + `snippet` mirrors; legislation (SQL graph path
  until T12) emits `snippet` (= heading) + `rerank_score` fallback. No
  retrieval/rerank logic touched.
- `src/lib/types.ts`: comment-only deprecation marks on legacy Azure fields;
  zod schemas unchanged.
- NOT done here (belongs to T10/T12): deleting Azure Search indexes/keys +
  dead env; legislation `searchLegislation` wiring (T10/T12 agent owns
  `search-tools.ts` + `helper.ts`).

## Smoke steps (user, needs live app)
1. `RERANK_ENABLED=true` + restart: ask any EN question → Sources tabs show
   `Rerank: x · RRF: y` lines; cited pages match the top-10/top-8 finals.
2. `RERANK_ENABLED=false` + restart: same question → `RRF: y` lines only, no
   rerank badge, nothing breaks.
3. sc/tc query (needs T17 chunks for full recall): no 500s; tabs render.
