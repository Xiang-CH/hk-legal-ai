CREATE TABLE judgment_managed_legislation_links (
 id BIGSERIAL PRIMARY KEY,
 source_id INTEGER NOT NULL REFERENCES "Judgment"(id),
 cap_id INTEGER REFERENCES "LegislationCap"(id),
 section_id INTEGER REFERENCES "LegislationSection"(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK((cap_id IS NOT NULL) <> (section_id IS NOT NULL)),
 UNIQUE(source_id,cap_id),
 UNIQUE(source_id,section_id)
);
