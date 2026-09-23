-- Legislation chunks (T17). Mirrors T03 clic/judgment chunk tables. No extensions here (T01 infra).
CREATE TABLE "legislation_chunks" (
    "id" BIGSERIAL NOT NULL,
    "section_id" INTEGER NOT NULL,
    "chunk_no" INTEGER NOT NULL,
    "language_code" TEXT NOT NULL,
    "cap_number" TEXT NOT NULL,
    "section_number" TEXT NOT NULL,
    "subsection_number" TEXT,
    "heading" TEXT,
    "content" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "context" TEXT,
    "embedding" vector(3072),
    "tsv" tsvector,
    "cjk_tokens" TEXT,

    CONSTRAINT "legislation_chunks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "legislation_chunks_section_id_language_code_idx" ON "legislation_chunks"("section_id", "language_code");

CREATE UNIQUE INDEX "legislation_chunks_section_id_language_code_chunk_no_key" ON "legislation_chunks"("section_id", "language_code", "chunk_no");

ALTER TABLE "legislation_chunks" ADD CONSTRAINT "legislation_chunks_section_id_language_code_fkey" FOREIGN KEY ("section_id", "language_code") REFERENCES "LegislationSection"("id", "languageCode") ON DELETE CASCADE ON UPDATE NO ACTION;
