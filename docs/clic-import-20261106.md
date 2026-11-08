# CLIC content import, 6 November 2026 list

Executed on 8 November 2026 against the configured Azure PostgreSQL `clic_chat` database.
Source: `CLIC Content List_20261106.xlsx`, EN sheet, Column C `2nd_id` 2759–2973 inclusive.

## Result

- All 215 requested IDs have valid content and URLs; no rows filtered.
- 48 pages already existed with matching content; 167 pages inserted, no existing pages updated.
- Inserted references: 55 CLIC page edges, 380 legislation-section edges, 76 legislation-cap edges.
- Added 308 English chunks for the 167 new pages. The complete selection now has 395 chunks covering all 215 pages, with 3072-dimensional embeddings and non-null English tsv fields.
- Post-import dry-run: 0 inserts, 0 updates, 215 no-ops.
- Post-index read-only plan: 215 already indexed, 0 pages to index.

The import transaction contained 1179 statements. Batch indexing used `scripts/index-clic-selection.mjs`, leaving other pages, languages and judgment corpora untouched. Selection mapping, checkpoints and raw API responses are under the ignored `scripts/index-output/clic-20261106/` directory.

## Application verification

Tested the PR #21 Vercel deployment's mounted search API. Each query returned newly inserted pages within its top 10 results:

| Query | Example new `2nd_id` | Article |
| --- | --- | --- |
| water seepage common causes | 2810 | Common causes of water seepage |
| civil proceedings expert evidence | 2951 | What are expert witnesses and lay witnesses? |
| writs of execution enforcement of judgment | 2973 | What are writs of execution? |
| juvenile courts sentencing mitigation | 2871 | Sentencing principles |

A full `/clic-chat-hkulaw/api/chat` request completed without stream errors and produced an answer with inline links to both the new Water seepage article and Common causes of water seepage article, rather than merely returning them as search sources.

Verified chat prompt:

> According to CLIC, what are the common causes of water seepage in Hong Kong buildings? Please cite the relevant CLIC pages with links.

Additional prompts based on the verified search queries:

- In Hong Kong civil proceedings, what is the difference between expert witnesses and lay witnesses? Please cite the relevant CLIC pages.
- What are writs of execution, and how do they help enforce a judgment in Hong Kong? Please cite the relevant CLIC pages.
- What sentencing principles and mitigation factors apply in Hong Kong Juvenile Courts? Please cite the relevant CLIC pages.

These pages were imported in English. The full chat test used an English prompt; the other three prompts have search-level verification only.

## Reference limitations

Six legacy relative paths were absent from the workbook's URL mapping, so those CLIC edges were not created:

- 2840: `/topics/civilCase/preparing_for_court_trial/q3`
- 2933 and 2972: `/topics/civilCase/commencement_of_trial/q8`
- 2941 and 2945: `/topics/civilCase/commencement_of_trial/q2`
- 2973: `/topics/civilCase/enforce_judgment/q3`

Page 2811 references HKCA 2007/258. The existing importer reports case references without creating CLIC-to-judgment edges. Page content retains its source hyperlinks.

The existing database had no HNSW/GIN indexes on `clic_chunks`; this batch preserved that configuration. Vector and lexical searches were verified through the deployed API, but this task did not add global database performance indexes.

## Code validation

Three importer regression tests pass. The new indexing script passed Node syntax checks, a live insert, final coverage/dimension/tsv validation, and a read-only rerun. The updated skill passed `quick_validate.py`.

Data writes are separate from deployment: merging or reverting PR #21 does not import or roll back database content. The PR contains reusable tooling and this record, not the Excel attachment or vector checkpoints.
