# PR 20 review fixes

The 13 open inline review threads were addressed together. Existing applied migrations remain unchanged. A forward migration adds the missing judgment foreign key and a composite document/judgment foreign key, with orphan checks and explicit validation. Prisma relations now match the SQL referential actions.

Local PostgreSQL checks used disposable databases on port 55439. `smoke.mjs` passed on a freshly migrated database with injected vectors, without paid provider calls. `review-regressions.mjs` covers malformed restore counts, audit EEXIST/ENOENT/EPIPE failures, report reservation before pilot network calls, production CLI flag parsing, empty-citation reference decisions, invalid chunk judgment updates, and integrity down/up without data loss. This script changes fixture data and requires a local disposable target already seeded by the smoke script.

`verify-search-fallback.ts` temporarily renames the full-text chunk table in a disposable database. Both the actual hybrid search function and the judgment tool retain the legacy summary. The tool check disables network access, exercising provider failure and lexical fallback failure together.

The restricted Studio role was provisioned and tested locally. It permits SELECT and rejects INSERT, UPDATE, DELETE, TRUNCATE and schema creation even after `SET default_transaction_read_only=off` and `BEGIN READ WRITE`. The launcher rejects the application writer role. Production role creation was not performed. The old Tailscale endpoint and the temporary local test Studio were stopped; the user confirmed that exposure was only needed temporarily and should remain disabled.

Browser checks use fresh temporary profiles and ignore inherited `AGENT_BROWSER_*` settings. Mobile 390/430 px and desktop 1280 px checks passed with a 40 px header and composer at the viewport bottom. Short/completed/running/failed search-progress scenarios passed, including three visible collapsed steps. A synthetic browser-only SSE response verified following a growing answer, preserving manual upward scrolling, and resuming following at the bottom. No chat provider was called.

Production preflight found zero orphan or mismatched chunks. The new integrity migration was deployed through the existing checksum/restore-receipt guard. Both foreign keys are validated. Counts remained 153,168 judgments, 26 imported documents and 1,083 full-text chunks. No additional embedding calls were made. Full-corpus approval remains pilot-only.

The production build, TypeScript check, targeted ESLint and whitespace check passed. Function contracts were documented in response to the review's documentation-coverage warning; the external bot computes its own final coverage after push.

## Reproduce locally

Use a fresh local database named `clic_judgment_test_*`, install the required `vector` and `pg_trgm` extensions, then apply Prisma migrations. Set `JUDGMENT_DATABASE_URL` explicitly for scripts and `DATABASE_URL` for application checks. Never point fixture tests at production.

```sh
node scripts/judgments/smoke.mjs
node scripts/judgments/review-regressions.mjs
pnpm dlx tsx scripts/judgments/verify-search-fallback.ts
node scripts/check-chat-layout.mjs
node scripts/check-search-progress.mjs
node scripts/check-chat-streaming.mjs
```

Browser checks expect the local app on port 3210. For Studio privilege checks, provision a local restricted role using a temporary `STUDIO_READONLY_ENV_FILE`, load that file into the environment, then run `node scripts/judgments/verify-studio-privileges.mjs`.
