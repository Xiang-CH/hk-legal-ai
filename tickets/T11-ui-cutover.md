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
