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

## Copy log (2026-09-08, `scripts/copy-legacy-to-pg.mjs`)

Source counts from legacy Azure SQL; all tables INSERTed into pg (junction `_CaseToJudgment` 156160/156160 reached 100% in `/tmp/copy-out.txt`).

- LegislationCap 2303 · LegislationSection 177204 · Interpretation 30146 · ClicPage 2333 · Case 125549 · Judgment 153168 · ParallelCitations 22560
- Junctions: _ClicPageRelationToClicPage 582 · _ClicPageToLegislationSection 1075 · _ClicPageToLegislationCap 1281 · _ClicPageToJudgment 0 · _LegislationSectionToLegislationSection 8648 · _LegislationSectionToLegislationCap 1457 · _InterpretationToLegislationSection 0 · _JudgmentToLegislationSection 0 · _JudgmentToLegislationCap 0 · _JudgmentToJudgment 0 · _CaseToJudgment 156160
- Tail step (sequences + VERIFY) did NOT run: `setval(pg_get_serial_sequence("T","c"),…)` used double-quoted identifiers → `column "LegislationCap" does not exist`. Fixed in script (single-quote literals). Re-run tail with `node scripts/copy-legacy-to-pg.mjs --resume`.

## Close-out (2026-09-08)

`--resume` re-run: all tables skipped (already filled), sequences fixed for LegislationCap/LegislationSection/Interpretation/ClicPage/clic_chunks/judgment_chunks, all VERIFY counts match source (incl. _CaseToJudgment 156160). T04 done.
