BEGIN;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
  CREATE EXTENSION vector;
 END IF;
END $$;
CREATE TABLE judgment_fulltext_chunks (
 id bigserial PRIMARY KEY, judgment_id integer NOT NULL, document_id bigint NOT NULL REFERENCES judgment_documents(id) ON DELETE CASCADE,
 document_generation text NOT NULL, generation text NOT NULL, chunk_no integer NOT NULL,
 language_code text NOT NULL DEFAULT 'en', neutral_citation text, court_name text, year integer, date timestamptz, parties text, summary_source text, url text,
 content text NOT NULL, embedding_input text NOT NULL, content_checksum text NOT NULL, input_checksum text NOT NULL, chunker_version text NOT NULL,
 start_position integer NOT NULL, end_position integer NOT NULL, start_offset integer NOT NULL, end_offset integer NOT NULL, spans jsonb NOT NULL,
 token_count integer NOT NULL CHECK(token_count <= 800), model text NOT NULL, deployment text NOT NULL, model_version text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','failed')), attempts integer NOT NULL DEFAULT 0, error text,
 embedding halfvec(3072), tsv tsvector GENERATED ALWAYS AS (to_tsvector('english',content)) STORED, cjk_tokens text NOT NULL,
 UNIQUE(document_id,generation,chunk_no)
);
CREATE INDEX ON judgment_fulltext_chunks USING gin(tsv);
CREATE INDEX ON judgment_fulltext_chunks USING gin(to_tsvector('simple',cjk_tokens));
CREATE INDEX ON judgment_fulltext_chunks USING hnsw(embedding halfvec_cosine_ops);
CREATE INDEX ON judgment_fulltext_chunks(document_id,generation,status);
CREATE INDEX ON judgment_fulltext_chunks(input_checksum,model,deployment,model_version);
CREATE TABLE judgment_fulltext_active (document_id bigint PRIMARY KEY REFERENCES judgment_documents(id) ON DELETE CASCADE, generation text NOT NULL);
COMMIT;
