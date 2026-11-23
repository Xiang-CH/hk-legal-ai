BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$ BEGIN
 IF EXISTS (
  SELECT 1 FROM judgment_fulltext_chunks c
  LEFT JOIN "Judgment" j ON j.id=c.judgment_id
  LEFT JOIN judgment_documents d ON d.id=c.document_id
  WHERE j.id IS NULL OR d.id IS NULL OR d.judgment_id<>c.judgment_id
 ) THEN
  RAISE EXCEPTION 'Full-text chunks contain orphan or mismatched judgment IDs; reconcile before migration';
 END IF;
END $$;

ALTER TABLE judgment_documents
 ADD CONSTRAINT judgment_documents_id_judgment_id_key UNIQUE (id,judgment_id);
ALTER TABLE judgment_fulltext_chunks
 ADD CONSTRAINT judgment_fulltext_chunks_judgment_id_fkey
 FOREIGN KEY (judgment_id) REFERENCES "Judgment"(id) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
ALTER TABLE judgment_fulltext_chunks VALIDATE CONSTRAINT judgment_fulltext_chunks_judgment_id_fkey;

ALTER TABLE judgment_fulltext_chunks
 ADD CONSTRAINT judgment_fulltext_chunks_document_id_judgment_id_fkey
 FOREIGN KEY (document_id,judgment_id) REFERENCES judgment_documents(id,judgment_id)
 ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;
ALTER TABLE judgment_fulltext_chunks VALIDATE CONSTRAINT judgment_fulltext_chunks_document_id_judgment_id_fkey;
ALTER TABLE judgment_fulltext_chunks DROP CONSTRAINT judgment_fulltext_chunks_document_id_fkey;
COMMIT;
