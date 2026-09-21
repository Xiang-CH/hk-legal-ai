# T17 — Legislation chunks (new capability, was never indexed)

- **Goal:** `legislation_chunks` populated + indexed for en/sc/tc. Legislation was relational-only — no chunks existed anywhere.
- **Scope/files:** `prisma/schema.prisma` (`LegislationChunk`), `prisma/migrations/20260909000000_legislation_chunks/`, `scripts/chunk-legislation.mjs`, `scripts/embed-legislation.mjs`, `scripts/load-legislation-chunks.mjs`, `scripts/index-output/legislation-chunks-{lang}.shard-NNNN.jsonl` (+ per-shard `.embeddings.jsonl` sidecars). Sharded: EN alone is ~205K chunks / >512MB — nothing may `readFileSync`/`JSON.stringify` a whole language.
- **Steps (review gate between 1 and 2):**
  1. `npx prisma migrate deploy` → `node scripts/chunk-legislation.mjs --lang=en [--limit=500]` → review a shard sample (context = cap title + heading, splitter 512/128 o200k_base). If a giant single-file JSON exists (pre-shard run), split it first: `node scripts/split-json.mjs scripts/index-output/legislation-chunks-en.json scripts/index-output/legislation-chunks-en` then delete the `.json`.
  2. `node scripts/embed-legislation.mjs --lang=en` (batch 100; progress in `legislation-chunks-{lang}.embeddings.jsonl` sidecar — never stringify the full array, re-run resumes; logs token $ est) → repeat sc, tc.
  3. `node scripts/load-legislation-chunks.mjs --lang=en [--skip-load]` (INSERT batches, tsv `english`/`simple`, cjk bigrams for sc/tc, HNSW + GINs + ANALYZE) → repeat sc, tc. `--skip-load` skips INSERTs and goes straight to tsv + indexes (safe only when rows already in pg; indexes created only if missing, so re-runs resume).
- **Acceptance:** per-language JSON counts logged; pg counts match JSON; `cjk_tokens` non-null on sc/tc; HNSW + 3 GINs in `\di`; sample vector + lexical queries <500ms.
- **Depends on:** T01. **Blocks:** T08 (add legislation to fusion search).
- **Size:** L (embed USD ~8–25 one-off; exact figure from embed logs).

## Status 2026-09-21 — EN rows loaded (205,779), tsv filled, HNSW blocked → halfvec migration applying
- `load-legislation-chunks.mjs --lang=en`: INSERTs all `(+0)` (already present), tsv filled, then
  `LOAD_FAILED: column cannot have more than 2000 dimensions for hnsw index` (pgvector HNSW cap on `vector`; ours is 3072-d).
- Fix applied (uncommitted): `20260910000000_halfvec_embeddings` (all 3 chunk tables → `halfvec(3072)`),
  schema `Unsupported("halfvec(3072)")`, loaders `::halfvec` + `halfvec_cosine_ops`, `maintenance_work_mem='1GB'` for build.
- To finish: `npx prisma migrate deploy` (rewrites 205k rows, minutes — runs in local tmux `halfvec` on socket `/tmp/tmux-halfvec.sock`; only one migrate at a time, a second one fails on the advisory lock P1002) then re-run loader with `--skip-load` (builds 4 indexes + ANALYZE, expect `total_in_pg=205779`).
- Index run takes ~1–2 hrs (HNSW is the long pole); laptop must stay on/networked — use `caffeinate -i`. Killed CREATE INDEX rolls back cleanly; re-run resumes.
- Notes: indexes update synchronously on write (no refresh schedule); `tsv` must be set on every future insert or rows are invisible to lexical search. sc/tc chunk→embed→load still pending after EN indexes land.
