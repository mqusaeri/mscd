-- Milestone 2 contract of the tenant schemas (docs/platform/MILESTONE-2.md D.3, J.7), written once in wave 1a by M2-02.
-- Later packages build on these columns and tables and add no tenant migration; a correction goes in
-- 0009_milestone2_fix.sql (Milestone 2 I).

-- Certification cycles (D.4): certificate details per cycle, and at most one open cycle (planned or active) per
-- system. A certified cycle is not open, so it stays while the next cycle runs.
ALTER TABLE certification_cycle
  ADD COLUMN certificate_expires_at date,
  ADD COLUMN certification_body varchar(200),
  ADD COLUMN certified_scope text;
CREATE UNIQUE INDEX certification_cycle_open_uq ON certification_cycle (management_system_id)
  WHERE status IN ('planned', 'active') AND deleted_at IS NULL;

-- Findings name the clause or control code of the system's edition they concern (D.2), next to the free-text clause_ref.
ALTER TABLE finding ADD COLUMN target_code varchar(30);
CREATE INDEX finding_target_idx ON finding (management_system_id, target_code) WHERE deleted_at IS NULL AND target_code IS NOT NULL;

-- A pack document code (template code or activity output document code) mapped to a registered document of the
-- system, so a customer keeps its own document codes (D.1 documented-info.link).
CREATE TABLE document_code_link (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  management_system_id uuid NOT NULL REFERENCES management_system(id),
  pack_code varchar(30) NOT NULL,
  document_id uuid NOT NULL REFERENCES document(id)
);
CREATE UNIQUE INDEX document_code_link_uq ON document_code_link (management_system_id, pack_code) WHERE deleted_at IS NULL;
CREATE INDEX document_code_link_document_idx ON document_code_link (document_id) WHERE deleted_at IS NULL;

-- Clause readiness computed by readiness.recompute (D.6): null until computed, with the four dimensions per group.
ALTER TABLE clause_readiness ALTER COLUMN readiness_pct DROP NOT NULL;
ALTER TABLE clause_readiness
  ADD COLUMN documented_pct smallint CHECK (documented_pct BETWEEN 0 AND 100),
  ADD COLUMN implemented_pct smallint CHECK (implemented_pct BETWEEN 0 AND 100),
  ADD COLUMN evidenced_pct smallint CHECK (evidenced_pct BETWEEN 0 AND 100),
  ADD COLUMN measured_pct smallint CHECK (measured_pct BETWEEN 0 AND 100),
  ADD COLUMN computed_at timestamptz;

-- Internal audits (D.2): a new event type, the audit scope text and the audit report (a document of type record).
ALTER TABLE audit_event DROP CONSTRAINT audit_event_event_type_check;
ALTER TABLE audit_event ADD CONSTRAINT audit_event_event_type_check
  CHECK (event_type IN ('stage1', 'stage2', 'surveillance', 'recertification', 'transition', 'special', 'internal_audit'));
ALTER TABLE audit_event
  ADD COLUMN scope_text text,
  ADD COLUMN report_document_id uuid REFERENCES document(id);

-- Audit activities name the auditor and the clause or control they examine (D.2, AUD-INDEP).
ALTER TABLE audit_activity
  ADD COLUMN auditor_user_id uuid REFERENCES platform.app_user(id),
  ADD COLUMN target_code varchar(30);

-- External documents (D.2): origin, source, reference and the date received.
ALTER TABLE document
  ADD COLUMN origin varchar(10) NOT NULL DEFAULT 'internal' CHECK (origin IN ('internal', 'external')),
  ADD COLUMN external_source varchar(200),
  ADD COLUMN external_ref varchar(120),
  ADD COLUMN received_at date;

-- What changed in a version (D.2 documents.versions changeSummary).
ALTER TABLE document_version ADD COLUMN change_summary varchar(500);

-- Quality objectives as a register (D.2 register kind objectives, ISO 9001 6.2).
ALTER TABLE quality_objective
  ADD COLUMN resources text,
  ADD COLUMN evaluation_method text,
  ADD COLUMN status varchar(12) CHECK (status IN ('planned', 'on_track', 'at_risk', 'achieved', 'missed')),
  ADD COLUMN result text,
  ADD COLUMN achieved_at date;

-- Competence records (D.2 register kind competence, clause 7.2), shared with systems through entity_ms_link.
CREATE TABLE competence_record (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  user_id uuid NOT NULL REFERENCES platform.app_user(id),
  role_title varchar(150) NOT NULL,
  competence_required text NOT NULL,
  proof_type varchar(12) NOT NULL CHECK (proof_type IN ('certificate', 'training', 'experience', 'assessment')),
  storage_object_id uuid REFERENCES storage_object(id),
  achieved_at date,
  valid_until date,
  verified_by uuid REFERENCES platform.app_user(id),
  owner_user_id uuid REFERENCES platform.app_user(id),
  pending_action text,
  action_due_at date,
  CHECK (valid_until IS NULL OR achieved_at IS NULL OR valid_until >= achieved_at)
);
CREATE INDEX competence_record_user_idx ON competence_record (user_id) WHERE deleted_at IS NULL;
CREATE INDEX competence_record_valid_idx ON competence_record (valid_until) WHERE deleted_at IS NULL AND valid_until IS NOT NULL;

ALTER TABLE entity_ms_link DROP CONSTRAINT entity_ms_link_entity_type_check;
ALTER TABLE entity_ms_link ADD CONSTRAINT entity_ms_link_entity_type_check
  CHECK (entity_type IN ('context_issue', 'interested_party', 'asset', 'document', 'evidence', 'risk', 'audit_event',
    'management_review', 'metric', 'competence_record'));

-- Bulk imports (D2-13): one dry run per file, then one commit through import.run. The same file is committed once.
CREATE TABLE import_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  management_system_id uuid NOT NULL REFERENCES management_system(id),
  kind varchar(15) NOT NULL CHECK (kind IN ('applicability', 'documents', 'risks', 'evidence')),
  file_name varchar(255) NOT NULL,
  file_sha256 char(64) NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  status varchar(12) NOT NULL CHECK (status IN ('validated', 'committing', 'committed', 'failed', 'expired')),
  row_count integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  results jsonb NOT NULL DEFAULT '[]'::jsonb,
  background_task_id uuid REFERENCES background_task(id),
  committed_at timestamptz,
  CHECK ((status = 'committed') = (committed_at IS NOT NULL))
);
CREATE UNIQUE INDEX import_run_committed_uq ON import_run (management_system_id, kind, file_sha256) WHERE status = 'committed';
CREATE INDEX import_run_creator_idx ON import_run (created_by, created_at DESC) WHERE deleted_at IS NULL;

SELECT platform.secure_tenant_schema(current_schema());
