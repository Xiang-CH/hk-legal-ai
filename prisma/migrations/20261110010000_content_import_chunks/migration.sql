BEGIN;
-- Wait for old import steps to finish before migrating their checkpoints.
LOCK TABLE "content_import_jobs" IN EXCLUSIVE MODE;

CREATE TABLE "content_import_chunks" (
  "job_id" uuid NOT NULL REFERENCES "content_import_jobs"("id") ON DELETE CASCADE,
  "nid" integer NOT NULL,
  "chunk_no" integer NOT NULL,
  "content" text NOT NULL,
  "embedding" halfvec(3072),
  PRIMARY KEY ("job_id", "nid", "chunk_no")
);

-- Preserve resumable batches created by the initial JSON-based implementation.
INSERT INTO "content_import_chunks" (job_id,nid,chunk_no,content,embedding)
SELECT j.id,(c->>'nid')::int,(c->>'number')::int,c->>'content',
  CASE WHEN jsonb_typeof(c->'embedding')='array' THEN (c->'embedding')::text::halfvec(3072) ELSE NULL END
FROM "content_import_jobs" j
CROSS JOIN LATERAL jsonb_array_elements(j.payload->'changes') AS change
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(change->'chunks','[]'::jsonb)) AS c
WHERE j.payload->>'status'<>'complete';

UPDATE "content_import_jobs" j SET payload=
  jsonb_set(j.payload,'{changes}',(SELECT COALESCE(jsonb_agg(change-'chunks'),'[]'::jsonb) FROM jsonb_array_elements(j.payload->'changes') AS change))
  || jsonb_build_object(
    'total', CASE WHEN j.payload->>'status'='complete' THEN
      (SELECT count(*) FROM jsonb_array_elements(j.payload->'changes') AS change CROSS JOIN LATERAL jsonb_array_elements(COALESCE(change->'chunks','[]'::jsonb)))
      ELSE (SELECT count(*) FROM content_import_chunks c WHERE c.job_id=j.id) END,
    'processed', CASE WHEN j.payload->>'status'='complete' THEN
      (SELECT count(*) FROM jsonb_array_elements(j.payload->'changes') AS change CROSS JOIN LATERAL jsonb_array_elements(COALESCE(change->'chunks','[]'::jsonb)))
      ELSE (SELECT count(embedding) FROM content_import_chunks c WHERE c.job_id=j.id) END
  );

COMMIT;
