# T01 — Provision new Azure Flexible Server (+ azure_ai)

- **Goal:** empty PG ready for migration; extensions (incl. `azure_ai`) proven before any DDL.
- **Scope/files:** Azure portal/CLI + SQL only. No repo code. Record outputs in this ticket.
- **Status:** Server created — PG18, 4GB RAM (tight for 100K × 3072-d HNSW build; consider temp scale-up for T07).
- **Steps:**
  1. Allowlist check: `SHOW azure.extensions;` + `SELECT * FROM pg_available_extensions WHERE name IN ('vector','pg_trgm','unaccent','azure_ai');` — paste output here. (`azure_ai` is allowlisted on Flexible; schemas `azure_ai, azure_openai, azure_cognitive, azure_ml` come with it.)
  2. `CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS unaccent; CREATE EXTENSION IF NOT EXISTS azure_ai;`
  3. Pin + record version (Preview API drifts): `SELECT azure_ai.version();` — if behind, `ALTER EXTENSION azure_ai UPDATE;` then re-record. Discover exact signatures on THIS server (do not trust docs alone): `SELECT proname, pg_get_function_arguments(oid) FROM pg_proc WHERE pronamespace IN ('azure_ai'::regnamespace,'azure_openai'::regnamespace,'azure_ml'::regnamespace);`
  4. Wire model access (DB-side settings, not app env):
     - OpenAI (embeddings in T06/T08): `SELECT azure_ai.set_setting('azure_openai.endpoint','https://<FOUNDRY-RESOURCE>.openai.azure.com');` + `SELECT azure_ai.set_setting('azure_openai.subscription_key','<KEY>');` — prefer managed identity over keys where possible.
     - Rerank (T09): deploy Cohere rerank on Foundry serverless first, then `SELECT azure_ai.set_setting('azure_ml.serverless_ranking_endpoint','https://<DEPLOY>.<REGION>.models.ai.azure.com/<v1|v2>/rerank');` + `SELECT azure_ai.set_setting('azure_ml.serverless_ranking_key','<KEY>');` (or managed-identity auth).
     - Least-privilege: `GRANT azure_ai_settings_manager TO <loader_role>;` (settings only settable by `azure_pg_admin` or `azure_ai_settings_manager`).
  5. Tune: `maintenance_work_mem` 512MB–1GB for build (4GB box — do NOT use 1–2GB), `hnsw.ef_search=40` for queries. Revert `maintenance_work_mem` after T07.
  6. Firewall/VNet for app + admin; issue new pg `DATABASE_URL` (KeyVault/env, not repo).
- **Caveats (azure_ai is Preview):** pin the recorded version; re-run step 3 after any server update. AI calls add 2 model hops on the query path — set statement timeouts, and wrap DB AI calls in Langfuse spans manually (no auto-tracing in-DB).
- **Decision LOCKED: no zhparser.** Not on the Flexible allowlist and can't be installed (no superuser/sideload). Chinese lexical uses app-side CJK bigrams + `simple` + `pg_trgm` (see T03/T07/T08). `pg_textsearch` also out for the same reason — not needed.
- **Depends on:** nothing. **Blocks:** T02–T08.
- **Size:** M.
