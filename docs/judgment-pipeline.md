# Judgment full-text pipeline

This feature is opt-in. Keep `JUDGMENT_FULLTEXT_ENABLED` unset until the target database has the five additive migrations and a verified pilot. Existing summary data and its unique keys remain untouched. Full text uses a separate chunk table so rollback cannot delete summary embeddings or break existing summary loaders.

## Current evidence

The completed `structural-5` measurement covers every content file. It found 152,475 valid documents and 181 rejected empty-content files, producing 9,469,636 blocks, 1,521,545 chunks and 797,337,753 billable embedding input tokens. Independent recomputation matched the summary. Every source path and checksum matched the original audit, with no duplicate or missing content files. All 181 rejections matched the audit. Evidence is in `.audit/judgment-token-estimate-v5-complete.jsonl.summary.json`, `.audit/judgment-estimate-final-reconciliation.json` and `.audit/judgment-corpus-quarantine.json`.

The refreshed Azure retail ceiling of US$0.172 per million tokens gives an estimated full embedding cost of US$137.14. The proposed US$172 cap was declined; the user explicitly retained pilot-only approval. Do not create a full-run budget ledger or call the provider for full-corpus embeddings without new approval.

Storage planning from the fully embedded pilot estimates about 60.94 GiB including the base database, chunks, document text, paragraphs and references. This is sample-based, not a measured bound, and excludes WAL, temporary build space, citation aliases, managed junctions and future generations. The proposed allocation is 128 GiB. Production remains at 32 GiB with auto-growth disabled; no resize is authorized. See `.audit/judgment-full-storage-plan.json`. Full-corpus execution remains incomplete and ticket #19 stays open.

- Read-only live reconciliation found 152,475 valid matching content files, 181 invalid/empty files, 2,598 citation sidecars and 113 other files. There were no unmatched valid documents or ambiguous source identities. The live database has 153,168 judgments; 693 rows lack valid source text in this snapshot.
- A local pilot imported 26 actual documents covering every available court/language combination and four long judgments. A second import reported all 26 unchanged.
- With parser `structural-5`, the pilot contains 6,537 content blocks and 1,083 current full-text chunks. Verification reconstructed every chunk from exact source offsets and proved complete block coverage. Embedding inputs total 571,104 chunking tokens. This deliberately includes long documents and is not an unbiased full-corpus cost estimate.
- Fixture integration checks cover bilingual keyword retrieval, references, idempotent reruns, injected storage failure with transactional rollback, vector persistence using test vectors, and stale-generation exclusion.
- Actual application case/search tools were exercised against local PostgreSQL, including lexical fallback without a paid embedding provider. TypeScript and targeted ESLint checks pass.
- All 1,083 current pilot chunks have real 3072-dimensional embeddings. Three fixed English/Chinese queries retrieved their expected authority at rank one through the actual application tools, followed by bounded paragraph retrieval. These are pilot checks, not a guarantee of full-corpus relevance.
- User approval covers the pilot only, up to US$1. Recorded passage and initial query provider usage is 811,652 tokens. The persisted ledger also reserves 10,000 tokens for application query checks and debugging. The conservative retail ceiling for all reservations is US$0.1414, using the earlier primary Azure Retail Prices API snapshot. A refresh attempt was rate limited; no new rate was assumed. Full-corpus embedding is not approved.
- Fixture archive restore, process-kill recovery, provider retry/budget/cache checks, summary/full-text coexistence and additive down migration passed. Rollback preserves pre-existing legislation links and removes only importer-owned links.
- The production archive is saved under `.audit/judgment-backups/`, SHA-256 verified and owner-readable only. Following the user's acceptance of the `azure_ai` metadata omission, all application data restored transactionally and row counts matched. The restored database also passed the new migrations and the 26-document import, reference, chunk and coverage checks. Production test updates are authorized; the installed `azure_ai` extension remains untouched.

## Commands

After the full estimator writes its completed summary, generate a reviewable cost and capacity proposal. The command rejects partial summaries and does not approve spending or resize infrastructure:

```sh
node scripts/judgments/plan-capacity.mjs \
 --estimate .audit/judgment-token-estimate-v5-complete.jsonl.summary.json \
 --sample .audit/judgment-storage-pilot-v5.json \
 --price .audit/judgment-embedding-price-current.json \
 --database .audit/judgment-production-capacity-current.json \
 --azure .audit/judgment-azure-capacity-current.json \
 --output .audit/judgment-full-capacity-proposal.json
```

The pilot intentionally includes long judgments. Its bytes-per-chunk figure is a planning sample, not a proven full-corpus storage bound. The proposal separately lists data and operational storage it excludes. Refresh pricing before approving the full run.

### Production test verified on 2026-11-02

The four additive migrations are applied to production. The bounded test set contains 26 documents, 6,537 paragraph blocks, 1,083 current chunks with real embeddings, 164 case-reference records and 133 legislation-reference records. Full source-span coverage and embedding presence passed verification. Application lexical search and bounded paragraph retrieval passed against production without provider calls. All 153,168 original judgments, 125,549 cases and 217 summary chunks remain present. The installed `azure_ai` version remains 2.0.0. The application deployment and its feature flag were not changed.

Evidence is in `.audit/judgment-production-test-verification-final.jsonl`, `.audit/judgment-production-app-verification.json` and `.audit/judgment-production-preservation.json`. This is a production pilot, not the full-corpus import. The final chunk writer uses batches of up to 200 rows within each document transaction; reruns preserve ready vectors for the same generation.

The later production graph verification in `.audit/judgment-production-graph-verification.json` also passed with zero stale case or legislation references, zero evidence paragraphs attached to the wrong source judgment and zero unvalidated public foreign keys. Case-reference outcomes were 18 resolved, 2 ambiguous, 37 pending, 99 outside the corpus and 8 self references. Legislation outcomes were 121 resolved and 12 outside the corpus. These are distinct reference records, not counts of resolved occurrences. Pending or outside-corpus references do not prove that an authority does not exist; they retain the source evidence for later resolution.

Set `JUDGMENT_DATABASE_URL` explicitly. Scripts never automatically load `.env`. Use a separate local database named `clic_judgment_test_*` for development; provision `vector` and `pg_trgm` before applying migrations. Authorized production writes require `--allow-production`, `--ack-backup MANIFEST`, `--restore-receipt RECEIPT` and explicit `--accept-azure-ai-omission` when that omission appears in the restore receipt. Paid embedding additionally requires `--approve-cost`, a persisted `--budget-file` and a matching `--budget-scope`.

Library entry points accept a connected `pg.Client`, not a pool, so every transaction stays on one connection.

```sh
node scripts/judgments/audit.mjs --dir SOURCE --output AUDIT.jsonl
node scripts/judgments/run.mjs --phase ingest --dir SOURCE
node scripts/judgments/run.mjs --phase ingest --dir SOURCE --all --apply --test-database
node scripts/judgments/run.mjs --phase references --dir SOURCE --all --apply --test-database
node scripts/judgments/run.mjs --phase chunks --all --apply --test-database
node scripts/judgments/run.mjs --phase embed
node scripts/judgments/run.mjs --phase verify --require-vectors
```

The embedding phase defaults to an estimate. Paid execution additionally requires `--apply --approve-cost --max-tokens=N` and the relevant database safety acknowledgement. The ceiling includes retries and is measured with the embedding model's `cl100k_base` tokenizer, independently of the chunker's `o200k_base` tokenizer. `--all` repeats bounded batches while retaining the same total token ceiling; failures or budget exhaustion stop the run. Do not use test vectors in a real corpus. A full-corpus embedding budget has not been approved.

For an empty migrated fixture database:

```sh
node scripts/judgments/smoke.mjs
node scripts/judgments/crash-smoke.mjs
```

`run.mjs --phase migrate --apply --test-database` exercises actual Prisma migration deployment against a disposable target. Rollback requires both `--apply --ack-destructive` and a disabled full-text flag. Manual down SQL does not reset Prisma migration history. `verify-compatibility.ts --legacy` verifies old summary search after feature tables are removed; it is a fixture-only check.

Reference reads use independent `nextReferenceId` and `nextLegislationId` cursors. Occurrence evidence is bounded per reference. Managed legislation relationships are tracked separately so source replacement and rollback cannot delete pre-existing annotations. Reference writes use per-document batches rather than one network round trip per citation occurrence.

Some upstream folder/metadata years are 1900 even when the judgment text names a later proceeding. These values are preserved for stable matching and require review. Source paths identify files; they are not independent verification of neutral citations or dates. The pipeline does not fabricate replacement metadata.

The pilot command accepts `--source SOURCE --audit AUDIT.jsonl --output /tmp/PILOT`. It reads source metadata using `JUDGMENT_AUDIT_DATABASE_URL` in a read-only transaction and copies a bounded subset into the explicitly local disposable target. It never calls an embedding provider. Pilot source copies and reports are outputs, not a replacement for the original corpus.

## Outstanding rollout work

The free full-corpus estimate and file reconciliation are complete. Production already has the five additive migrations and verified 26-document pilot. Full-corpus embedding approval was declined, and the capacity increase remains unapproved. Production currently has 32 GiB storage with auto-grow disabled; the proposed allocation is 128 GiB based on sample measurements including text, paragraphs, references and search indexes, with additional operational headroom required. Full-corpus execution must wait for the required approvals. An exact restore including Azure-specific extension metadata remains unverified; the user accepted the tested application-data restore with azure_ai metadata omitted for the production pilot. Any future Azure restore resource requires separate approval. Preserve the original source files and all rejected-file reports. Never mark missing text or unresolved authorities as successfully imported/resolved.

See `judgment-rollback.md` for recovery. Backups must live in a durable, access-controlled directory outside version control, not only in `/tmp`. Manual schema rollback requires migration-history reconciliation before reinstallation.
