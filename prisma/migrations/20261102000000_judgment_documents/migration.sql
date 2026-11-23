BEGIN;
CREATE INDEX judgment_source_identity_lookup ON "Judgment" (upper("courtName"),year,number,lower("languageCode"));
CREATE TABLE judgment_documents (
 id BIGSERIAL PRIMARY KEY, judgment_id INTEGER NOT NULL UNIQUE REFERENCES "Judgment"(id) ON DELETE RESTRICT,
 source_path TEXT NOT NULL UNIQUE, source_checksum TEXT NOT NULL, raw_html TEXT NOT NULL, plain_text TEXT NOT NULL,
 parser_version TEXT NOT NULL, generation UUID NOT NULL, imported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE judgment_paragraphs (
 id BIGSERIAL PRIMARY KEY, document_id BIGINT NOT NULL REFERENCES judgment_documents(id) ON DELETE CASCADE,
 position INTEGER NOT NULL, label TEXT, anchor TEXT, block_type TEXT NOT NULL, content TEXT NOT NULL, html TEXT,
 UNIQUE(document_id, position)
);
CREATE TABLE judgment_import_runs (
 id UUID PRIMARY KEY, root TEXT NOT NULL, parser_version TEXT NOT NULL, status TEXT NOT NULL,
 started_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ
);
CREATE TABLE judgment_import_files (
 id BIGSERIAL PRIMARY KEY, run_id UUID NOT NULL REFERENCES judgment_import_runs(id) ON DELETE CASCADE,
 source_path TEXT NOT NULL, source_checksum TEXT, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 1,
 error TEXT, completed_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(run_id, source_path)
);
COMMIT;
