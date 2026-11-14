-- Revert only the additive integrity migration; imported content is retained.
BEGIN;
ALTER TABLE judgment_fulltext_chunks ADD CONSTRAINT judgment_fulltext_chunks_document_id_fkey
 FOREIGN KEY(document_id) REFERENCES judgment_documents(id) ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE judgment_fulltext_chunks DROP CONSTRAINT judgment_fulltext_chunks_document_id_judgment_id_fkey;
ALTER TABLE judgment_fulltext_chunks DROP CONSTRAINT judgment_fulltext_chunks_judgment_id_fkey;
ALTER TABLE judgment_documents DROP CONSTRAINT judgment_documents_id_judgment_id_key;
COMMIT;
