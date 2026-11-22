-- Durable preparation and audit records. Live pages change only in the final transaction.
CREATE TABLE "content_import_jobs" (
  "id" uuid PRIMARY KEY,
  "payload" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "content_import_jobs_created_at_idx" ON "content_import_jobs" ("created_at" DESC);
