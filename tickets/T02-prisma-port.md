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
