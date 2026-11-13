# Corpus throughput

The original importer issued roughly nine sequential database requests for each new judgment. Measured Mac-to-Azure round trips were 223–302 ms, so network waiting dominated ingestion before embedding began.

`run.mjs --phase ingest --fast --concurrency 4` uses batches of up to 64 documents, with a 4 MiB preparation threshold and at most four in-flight batches. A single large document can exceed that threshold. Identity metadata is read once; unchanged documents skip parsing and replacement. New documents, paragraphs and run outcomes use bulk operations. The source-root advisory lock remains held by the coordinator; worker transactions lock judgment IDs in order and recheck document identity before replacing content. Changed documents retain the existing managed-link cleanup. Data-dependent failures are split to isolate individual rejected files; connection/service errors stop the run for retry.

A production benchmark processed 4,096 files in 72.092 seconds: 2,924 new documents, 1,169 unchanged and three skipped files, with no quarantine failures. This includes startup and checksum validation. It establishes improvement on this subset, not a whole-corpus completion guarantee; judgment lengths and server load vary.

The optional fast reference mode prefetches 64 documents and their paragraphs, then writes reference evidence and managed legislation links in one transaction per batch. References retain per-source keys, source-generation validation and occurrence provenance. Legacy links are tracked as importer-owned only when newly inserted.

The optional fast chunk mode prefetches a bounded document page and paragraphs. It uses the same chunk builder, generation hashes, source spans and model identity as the original path, then publishes the page atomically after checking source generations. Use `--phase chunks --fast --limit 64`. Chunking remains CPU work on the local process; page logs provide measured throughput.

Embedding cache lookup and vector persistence are now set-based per embedding batch instead of per vector. Token reservations, provider usage accounting, retries, model validation and the persisted US$172 full-run ceiling are unchanged. Completed vectors remain reusable after restarts.

Validation on fresh disposable databases passed the complete smoke flow using fast import, references and chunks, including bilingual retrieval, exact spans, reference reruns, legacy summary coexistence, embedding cache reuse, budget exhaustion and injected rollback. A separate mixed-batch failure test verified that a bad document rolls back, a good neighbor imports, and a retry imports only the failed document. All embedding calls in these tests used injected vectors; no paid provider calls were made.

The live full run uses these paths after validation. The user explicitly waived a new backup; the existing verified pre-import archive/receipt remains the write guard. This change adds no migration and does not change chunking parameters or existing judgment/case identifiers.
