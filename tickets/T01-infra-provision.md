# T01 — Provision new Azure Flexible Server (+ azure_ai)

- **Goal:** empty PG ready for migration; extensions (incl. `azure_ai`) proven before any DDL.
- **Scope/files:** Azure portal/CLI + SQL only. No repo code. Record outputs in this ticket.
- **Status:** Server created — PG18, 4GB RAM (tight for 100K × 3072-d HNSW build; consider temp scale-up for T07).
- **Steps:**
  0. Create a dedicated database (do NOT use the default `postgres` DB) + least-privilege app role — run as server admin on `postgres`:
     ```sql
     CREATE ROLE clic_app WITH LOGIN PASSWORD '<from-KeyVault>';
     CREATE DATABASE clic_chat OWNER clic_app;
     ```
     Then reconnect to `clic_chat` and, still as admin, install extensions (step 2) and hand runtime rights to the app role:
     ```sql
     GRANT CONNECT, TEMPORARY ON DATABASE clic_chat TO clic_app;
     GRANT USAGE ON SCHEMA public TO clic_app;
     -- after T03 migrations create tables, grant DML (or set per-table):
     -- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO clic_app;
     -- ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO clic_app;
     GRANT azure_ai_settings_manager TO clic_app;  -- only if the app itself must change azure_ai settings at runtime; otherwise keep on admin/loader role
     ```
     `DATABASE_URL` uses `clic_app` (never the admin login). Keep the admin login for migrations/extension/settings work only. Why: extensions are per-database (must live in the app DB, not `postgres`), and `azure_ai` settings are database-scoped — settings/extensions configured in `postgres` won't apply to your app.
  1. Allowlist check (run connected to `clic_chat`): `SHOW azure.extensions;` + `SELECT * FROM pg_available_extensions WHERE name IN ('vector','pg_trgm','unaccent','azure_ai');` — ✅ RECORDED 2026-09-07:
     `unaccent 1.1`, `vector 0.8.2`, `azure_ai 2.0.0`, `pg_trgm 1.6` (name/default_version/installed_version identical — all installed). Ext 2.0.0 ≥ 1.1.0 ⇒ `dimensions` param supported for 3-large.
  1b. Wire model endpoint (in `clic_chat`): the `.../api/projects/` URL is the **Foundry project** endpoint (for agents SDKs) — NOT what `azure_ai` wants. In Foundry portal find the **connected Azure OpenAI resource** hosting your `text-embedding-3-large` deployment (project → Model deployments → deployment details, or Management Center → Connected resources) → its **Keys and Endpoints** → copy the `https://<xxx>.openai.azure.com` base URL + key, then:
     ```sql
     SELECT azure_ai.set_setting('azure_openai.endpoint','https://<xxx>.openai.azure.com');
     SELECT azure_ai.set_setting('azure_openai.subscription_key','<KEY>');
     SELECT azure_ai.get_setting('azure_openai.endpoint');
     -- smoke test (deployment_name = your AOAI deployment name, NOT the model name):
     SELECT array_length(azure_openai.create_embeddings('<DEPLOYMENT>','hello legal world'),1);  -- expect 3072
     ```
     If the smoke test hangs/403s: the AOAI resource firewall is the usual suspect — allow Azure services or add the PG server's outbound IP. (`azure_ai` is allowlisted on Flexible; schemas `azure_ai, azure_openai, azure_cognitive, azure_ml` come with it.)
  2. `CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS unaccent; CREATE EXTENSION IF NOT EXISTS azure_ai;`
  3. Pin + record version (Preview API drifts): `SELECT azure_ai.version();` — if behind, `ALTER EXTENSION azure_ai UPDATE;` then re-record. Discover exact signatures on THIS server (do not trust docs alone): `SELECT proname, pg_get_function_arguments(oid) FROM pg_proc WHERE pronamespace IN ('azure_ai'::regnamespace,'azure_openai'::regnamespace,'azure_ml'::regnamespace);`
  4. Wire model access (DB-side settings, not app env):
     - OpenAI (embeddings in T06/T08): `SELECT azure_ai.set_setting('azure_openai.endpoint','https://<FOUNDRY-RESOURCE>.openai.azure.com');` + `SELECT azure_ai.set_setting('azure_openai.subscription_key','<KEY>');` — prefer managed identity over keys where possible.
     - Rerank (T09): deploy Cohere rerank on Foundry serverless first, then `SELECT azure_ai.set_setting('azure_ml.serverless_ranking_endpoint','https://<DEPLOY>.<REGION>.models.ai.azure.com/<v1|v2>/rerank');` + `SELECT azure_ai.set_setting('azure_ml.serverless_ranking_key','<KEY>');` (or managed-identity auth).
     - Least-privilege: `GRANT azure_ai_settings_manager TO <loader_role>;` (settings only settable by `azure_pg_admin` or `azure_ai_settings_manager`).
  5. Tune: `maintenance_work_mem` 512MB–1GB for build (4GB box — do NOT use 1–2GB), `hnsw.ef_search=40` for queries. Revert `maintenance_work_mem` after T07.
  6. Firewall/VNet for app + admin; issue new pg `DATABASE_URL` (KeyVault/env, not repo).
- **Caveats:** re-run step 3 after any server update. AI calls add 2 model hops on the query path — set statement timeouts, and wrap DB AI calls in Langfuse spans manually (no auto-tracing in-DB).
- **Decision LOCKED: no zhparser.** Not on the Flexible allowlist and can't be installed (no superuser/sideload). Chinese lexical uses app-side CJK bigrams + `simple` + `pg_trgm` (see T03/T07/T08). `pg_textsearch` also out for the same reason — not needed.
- **Depends on:** nothing. **Blocks:** T02–T08.
- **Size:** M.



name	default_version	installed_version	comment
unaccent	1.1	1.1	text search dictionary that removes accents
vector	0.8.2	0.8.2	vector data type and ivfflat and hnsw access methods
azure_ai	2.0.0	2.0.0	Azure AI and ML Services integration for PostgreSQL
pg_trgm	1.6	1.6	text similarity measurement and index searching based on trigrams