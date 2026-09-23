# T05 — Re-chunk pipeline from source (index lost)

- **Goal:** reproducible chunk JSONs for en/sc/tc + judgments (Azure index is gone — no export).
- **Scope/files:** `scripts/index-clic.ts`, `scripts/index-judgment-summary.ts` (retarget pg, delete Search upload), `scripts/index-output/chunks-{en,sc,tc}.json`.
- **Steps:**
  1. Read `ClicPage(content,title,url,topic,context)` per `languageCode` from pg → `TokenTextSplitter(512/128, o200k_base)` → `(nid, chunk_no, title, content, url, topic, context)`.
  2. Read `Judgment(summary,…)` → same splitter → `(judgmentId, chunk_no, neutralCitation, courtName, year, date, parties, summary-chunk, summarySource, url)`.
  3. Keep chunking params identical to old index; checkpoint one JSON per language, same shape (with `embedding` field, null until T06).
  4. Delete `uploadIndexByBatch` / `mergeOrUploadDocuments` code.
- **Acceptance:** JSONs regenerate deterministically; chunk counts logged per language; no `@azure/search-documents` import remains in these scripts.
- **Depends on:** T04. **Blocks:** T06.
- **Size:** M.

## Status 2026-09-22 — scripts retargeted, awaiting run
- `index-clic.ts` / `index-judgment-summary.ts` rewritten chunk-only: Azure Search + embedding code deleted (zero `search-documents` refs), `embedding: null` output, `--lang` flag on clic, `indexOf` chunk_no bug fixed (index-based, deterministic).
- BEFORE running: back up the T06 EN cache — `cp chunks-en.json chunks-en.cached.json` + `cp judgment-summaries.json judgment-summaries.cached.json` (cached files hold all 3,461 EN embeddings; regen overwrites).
- Run: `npx -y tsx scripts/index-clic.ts --lang=en` then `npx -y tsx scripts/index-judgment-summary.ts`. Report the two chunk totals (expect drift vs cached 3244/217).
