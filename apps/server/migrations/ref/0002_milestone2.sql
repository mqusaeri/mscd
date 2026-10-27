-- Milestone 2 pack format, engine 1.1.0 (MILESTONE-2 D.3, E.1, J.7; M2-03). Every change keeps the rows a
-- Milestone 1 installation already holds: new columns have defaults, and no row is removed.

-- Rows no longer in the standard stay in ref (tenant entries point to them); readers hide them.
ALTER TABLE ref.requirement ADD COLUMN retired boolean NOT NULL DEFAULT false;
ALTER TABLE ref.catalogue_item ADD COLUMN retired boolean NOT NULL DEFAULT false;

-- Documented information the standard asks for (pack file documented_info.csv): maintained (a document) or
-- retained (a record), with the requirement that asks for it and the template that answers it.
CREATE TABLE ref.documented_info (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  framework_version_id uuid NOT NULL REFERENCES ref.framework_version(id),
  code varchar(30) NOT NULL,
  requirement_code varchar(20) NOT NULL,
  kind varchar(10) NOT NULL CHECK (kind IN ('maintain', 'retain')),
  title varchar(255) NOT NULL,
  template_code varchar(30),
  sort_order smallint NOT NULL DEFAULT 0,
  UNIQUE (framework_version_id, code)
);

-- The clause a document template answers.
ALTER TABLE ref.document_template ADD COLUMN requirement_code varchar(20);

-- Management review inputs and the governing body review inputs of ISO 37001.
ALTER TABLE ref.review_input_def
  ADD COLUMN review_kind varchar(15) NOT NULL DEFAULT 'management' CHECK (review_kind IN ('management', 'governing_body'));

-- A mapping starts at a requirement or at a catalogue item (for example an Annex A control) of the source pack.
ALTER TABLE ref.requirement_mapping ALTER COLUMN source_requirement_id DROP NOT NULL;
ALTER TABLE ref.requirement_mapping ADD COLUMN source_catalogue_item_id uuid REFERENCES ref.catalogue_item(id);
ALTER TABLE ref.requirement_mapping ADD CONSTRAINT requirement_mapping_one_source
  CHECK (num_nonnulls(source_requirement_id, source_catalogue_item_id) = 1);
CREATE INDEX requirement_mapping_source_item_idx ON ref.requirement_mapping (source_catalogue_item_id);

-- Audit activity templates of internal audits (AUDIT_EVENT_TYPES types this column too).
ALTER TABLE ref.audit_activity_template DROP CONSTRAINT audit_activity_template_event_type_check;
ALTER TABLE ref.audit_activity_template ADD CONSTRAINT audit_activity_template_event_type_check
  CHECK (event_type IN ('stage1', 'stage2', 'surveillance', 'recertification', 'transition', 'special', 'internal_audit'));

-- Grants as every ref table (0001): read-only for the app, writable without DELETE for the pack installer (D-17).
GRANT SELECT ON ref.documented_info TO mscd_app;
GRANT SELECT, INSERT, UPDATE ON ref.documented_info TO mscd_pack_installer;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mscd_report') THEN
    GRANT SELECT ON ref.documented_info TO mscd_report;
  END IF;
END $$;
