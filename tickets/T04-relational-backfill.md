# T04 — Port insert scripts + backfill relational rows

- **Goal:** all 7 relational tables populated on pg with stable keys.
- **Scope/files:** `scripts/insert-clic.ts`, `scripts/insert-legislation.ts`, `scripts/insert-judgment.ts` (pg ports).
- **Steps:**
  1. Port the three scripts from mssql client to pg (`createMany`/COPY batches); preserve `nid/languageCode`, `capNumber/sectionNumber`, judgment IDs.
  2. Load order: `LegislationCap → LegislationSection → Interpretation → ClicPage → Case → Judgment → ParallelCitations`.
  3. Row-count check vs source after each table; log counts in ticket.
- **Acceptance:** counts match source; FK constraints hold; `ClicPage(nid,languageCode)` and judgment IDs joinable to future chunks.
- **Depends on:** T02, T03. **Blocks:** T05.
- **Size:** M.
