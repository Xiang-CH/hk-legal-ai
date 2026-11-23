-- WARNING: additive rollback permanently loses imported content and run history.
BEGIN;
DO $$ BEGIN
 IF to_regclass('judgment_managed_legislation_links') IS NOT NULL THEN
  DELETE FROM "_JudgmentToLegislationCap" links USING judgment_managed_legislation_links owned WHERE owned.cap_id=links."B" AND owned.source_id=links."A";
  DELETE FROM "_JudgmentToLegislationSection" links USING judgment_managed_legislation_links owned WHERE owned.section_id=links."B" AND owned.source_id=links."A";
 END IF;
END $$;
DROP TABLE IF EXISTS judgment_managed_legislation_links;
DROP TABLE IF EXISTS judgment_fulltext_active;
DROP TABLE IF EXISTS judgment_fulltext_chunks;
DROP TABLE IF EXISTS judgment_legislation_references;
DROP TABLE IF EXISTS judgment_reference_occurrences;
DROP TABLE IF EXISTS judgment_references;
DROP TABLE IF EXISTS judgment_citation_aliases;
DROP TABLE IF EXISTS judgment_import_files;
DROP TABLE IF EXISTS judgment_import_runs;
DROP TABLE IF EXISTS judgment_paragraphs;
DROP TABLE IF EXISTS judgment_documents;
DROP INDEX IF EXISTS judgment_source_identity_lookup;
COMMIT;
