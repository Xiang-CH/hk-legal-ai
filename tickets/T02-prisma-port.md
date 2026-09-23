# T02 — Port Prisma SQL Server → Postgres

- **Goal:** app compiles against pg; SQL Server types gone.
- **Scope/files:** `prisma/schema.prisma`, `package.json` (adapter), `src/prisma/*` generated client, `.env` docs.
- **Steps:**
  1. `datasource db`: `provider "sqlserver"` → `"postgresql"`.
  2. Deps: remove `@prisma/adapter-mssql`, add `@prisma/adapter-pg` + `pg`; update Prisma client instantiation (`src/app/api/chat/route.ts`, `src/app/api/clic/search/route.ts`, scripts).
  3. All `@db.NVarChar(max)` → `@db.Text`; check `autoincrement()` identity; re-validate composite FKs `[capNumber, languageCode]` (`LegislationSection/Cap/Interpretation`).
  4. Collation check: confirm no code relies on SQL Server case-insensitive `String` matching; note findings.
  5. `prisma generate`; `tsc --noEmit` clean.
- **Acceptance:** `tsc` passes, Prisma client connected to new server (empty), no `sqlserver`/`mssql` references except history.
- **Depends on:** T01. **Blocks:** T03, T04.
- **Size:** M.

- **Status: DONE 2026-09-07.**
- Notes:
  - `prisma/schema.prisma`: provider `postgresql`, 11× `@db.NVarChar(max)` → `@db.Text`.
  - `@prisma/client` bumped `6.14.0` → `^6.19.3` to match `prisma`/adapter (fixes `PrismaPg` ↔ `SqlDriverAdapterFactory` type error in scripts). Deps: `-adapter-mssql` → `+adapter-pg`, `+pg`, `+@types/pg` (dev).
  - New `src/lib/prisma.ts` singleton (`PrismaPg` adapter); 4 API routes + 5 scripts updated. `tsc --noEmit` clean.
  - Collation: no Prisma string filters in app code (only JS-side `startsWith`/`endsWith`) — no case-insensitivity reliance.
  - `DATABASE_URL` → pg `clic_chat` (old SQL Server URL kept as `DATABASE_URL_SQLSERVER_BACKUP`). Connected as `clic_app` ✅.
  - ⚠️ `vector` + `azure_ai` NOT installed in `clic_chat` (only `plpgsql`; `pg_trgm`/`unaccent` installed as trusted). Need server admin: connect to `clic_chat` and run `CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS azure_ai;` — blocks T03.
