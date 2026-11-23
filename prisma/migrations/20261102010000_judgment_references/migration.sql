BEGIN;
CREATE TABLE judgment_citation_aliases (
 id bigserial PRIMARY KEY, judgment_id integer NOT NULL REFERENCES "Judgment"(id),
 original text NOT NULL, normalized text NOT NULL, provenance jsonb NOT NULL,
 UNIQUE(judgment_id,normalized,original)
);
CREATE INDEX ON judgment_citation_aliases(normalized);
CREATE TABLE judgment_references (
 id bigserial PRIMARY KEY, source_id integer NOT NULL REFERENCES "Judgment"(id),
 kind text NOT NULL, original text NOT NULL, normalized text NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','resolved','ambiguous','not-in-corpus','self')),
 target_id integer REFERENCES "Judgment"(id), candidates jsonb NOT NULL DEFAULT '[]',
 provenance jsonb NOT NULL, resolver_version text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((status='resolved')=(target_id IS NOT NULL)), CHECK(target_id IS NULL OR target_id<>source_id),
 UNIQUE(source_id,kind,normalized)
);
CREATE INDEX ON judgment_references(target_id) WHERE status='resolved';
CREATE INDEX ON judgment_references(normalized);
CREATE TABLE judgment_reference_occurrences (
 id bigserial PRIMARY KEY, reference_id bigint NOT NULL REFERENCES judgment_references(id) ON DELETE CASCADE,
 evidence_key text NOT NULL, paragraph_id bigint REFERENCES judgment_paragraphs(id) ON DELETE SET NULL,
 anchor text, evidence jsonb NOT NULL, UNIQUE(reference_id,evidence_key)
);
CREATE INDEX ON judgment_reference_occurrences(paragraph_id);
CREATE TABLE judgment_legislation_references (
 id bigserial PRIMARY KEY, source_id integer NOT NULL REFERENCES "Judgment"(id),
 original text NOT NULL, normalized text NOT NULL, status text NOT NULL CHECK(status IN ('pending','resolved','ambiguous','not-in-corpus')),
 cap_id integer REFERENCES "LegislationCap"(id), section_id integer REFERENCES "LegislationSection"(id),
 candidates jsonb NOT NULL DEFAULT '[]', provenance jsonb NOT NULL,
 CHECK((status='resolved')=(cap_id IS NOT NULL OR section_id IS NOT NULL)),
 UNIQUE(source_id,normalized)
);
CREATE INDEX ON judgment_legislation_references(cap_id);
CREATE INDEX ON judgment_legislation_references(section_id);
COMMIT;
