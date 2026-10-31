-- Milestone 3 contract of the tenant schemas (docs/platform/MILESTONE-3.md D.3, J.7), written once in wave 1 by M3-01.
-- Later packages build on these columns and tables and add no tenant migration; a correction goes in
-- 0010_milestone3_fix.sql (R-14). Every new table has the standard tenant columns and forced row-level security
-- (secure_tenant_schema at the end, as in 0008).

-- Requests from one person about their own personal data (D.6). The request keeps the person as entered, as proof
-- that it was answered (D.6.5).
CREATE TABLE privacy_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  request_no varchar(20) NOT NULL CHECK (request_no ~ '^PR-[0-9]{4}-[0-9]{3,6}$'),
  request_type varchar(15) NOT NULL CHECK (request_type IN ('access', 'rectification', 'restriction', 'erasure')),
  status varchar(12) NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'in_progress', 'completed', 'refused', 'withdrawn')),
  subject_kind varchar(10) NOT NULL CHECK (subject_kind IN ('member', 'other')),
  subject_user_id uuid REFERENCES platform.app_user(id),
  subject_name varchar(200),
  subject_email varchar(320),
  channel varchar(15) NOT NULL CHECK (channel IN ('self_service', 'email', 'letter', 'provider', 'other')),
  received_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  identity_check_note varchar(500),
  identity_checked_by uuid REFERENCES platform.app_user(id),
  handled_by uuid REFERENCES platform.app_user(id),
  closed_at timestamptz,
  outcome text,
  result jsonb,
  CHECK ((subject_kind = 'member') = (subject_user_id IS NOT NULL)),
  CHECK (subject_kind = 'member' OR subject_name IS NOT NULL),
  CHECK (due_at >= received_at),
  CHECK ((status IN ('completed', 'refused', 'withdrawn')) = (closed_at IS NOT NULL))
);
CREATE UNIQUE INDEX privacy_request_no_uq ON privacy_request (request_no);
CREATE INDEX privacy_request_open_idx ON privacy_request (due_at) WHERE status IN ('received', 'in_progress') AND deleted_at IS NULL;
CREATE INDEX privacy_request_subject_idx ON privacy_request (subject_user_id) WHERE subject_user_id IS NOT NULL;

-- One check per management system of an access or erasure request, done by the system's manager (D.6.4).
CREATE TABLE privacy_check (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  privacy_request_id uuid NOT NULL REFERENCES privacy_request(id),
  management_system_id uuid NOT NULL REFERENCES management_system(id),
  status varchar(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  done_by uuid REFERENCES platform.app_user(id),
  done_at timestamptz,
  note varchar(500),
  CHECK ((status = 'done') = (done_at IS NOT NULL))
);
CREATE UNIQUE INDEX privacy_check_uq ON privacy_check (privacy_request_id, management_system_id);
CREATE INDEX privacy_check_ms_idx ON privacy_check (management_system_id, status);

-- A person erased in this organisation and the pseudonym the organisation shows instead ("Former user 7F3A", D.6.5).
-- The key is erased_user_id, not user_id: secure_tenant_schema puts the member check on every user_id column, and the
-- erased person is no longer a member when the row is written. Two erased people never share a pseudonym.
CREATE TABLE erased_person (
  erased_user_id uuid PRIMARY KEY REFERENCES platform.app_user(id),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  pseudonym varchar(40) NOT NULL CHECK (length(btrim(pseudonym)) > 0),
  privacy_request_id uuid REFERENCES privacy_request(id),
  erased_at timestamptz NOT NULL DEFAULT now(),
  erased_by uuid REFERENCES platform.app_user(id)
);
CREATE UNIQUE INDEX erased_person_pseudonym_uq ON erased_person (pseudonym);

-- Read confirmation of policies (D.7): the settings of a document, one request per approved version, one row per person.
ALTER TABLE document
  ADD COLUMN acknowledgement_required boolean NOT NULL DEFAULT false,
  ADD COLUMN acknowledgement_scope varchar(15) NOT NULL DEFAULT 'system_roles'
    CHECK (acknowledgement_scope IN ('system_roles', 'roles', 'organisation')),
  ADD COLUMN acknowledgement_roles text[]
    CHECK (acknowledgement_roles <@ ARRAY['ms_manager', 'programme_owner', 'domain_owner', 'risk_owner', 'internal_auditor', 'top_management', 'compliance_investigator']::text[]),
  ADD COLUMN acknowledgement_due_days smallint NOT NULL DEFAULT 14 CHECK (acknowledgement_due_days BETWEEN 1 AND 90),
  -- Scope roles names at least one role; the other scopes name none.
  ADD CONSTRAINT document_acknowledgement_audience_check
    CHECK ((acknowledgement_scope = 'roles') = (acknowledgement_roles IS NOT NULL AND cardinality(acknowledgement_roles) > 0));

CREATE TABLE acknowledgement_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  -- The document's primary system; the request shows in every system the document is linked to.
  management_system_id uuid NOT NULL REFERENCES management_system(id),
  document_id uuid NOT NULL REFERENCES document(id),
  document_version_id uuid NOT NULL REFERENCES document_version(id),
  status varchar(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  audience_scope varchar(15) NOT NULL CHECK (audience_scope IN ('system_roles', 'roles', 'organisation')),
  audience_roles text[]
    CHECK (audience_roles <@ ARRAY['ms_manager', 'programme_owner', 'domain_owner', 'risk_owner', 'internal_auditor', 'top_management', 'compliance_investigator']::text[]),
  audience_count integer NOT NULL DEFAULT 0 CHECK (audience_count >= 0),
  due_on date NOT NULL,
  last_reminded_at timestamptz,
  closed_at timestamptz,
  closed_by uuid REFERENCES platform.app_user(id),
  evidence_id uuid REFERENCES evidence(id),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);
CREATE UNIQUE INDEX acknowledgement_request_open_uq ON acknowledgement_request (document_version_id) WHERE status = 'open';
CREATE INDEX acknowledgement_request_document_idx ON acknowledgement_request (document_id, created_at DESC);
CREATE INDEX acknowledgement_request_ms_idx ON acknowledgement_request (management_system_id, status);

CREATE TABLE acknowledgement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  acknowledgement_request_id uuid NOT NULL REFERENCES acknowledgement_request(id),
  user_id uuid NOT NULL REFERENCES platform.app_user(id),
  status varchar(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'excused')),
  opened_at timestamptz,
  confirmed_at timestamptz,
  reminded_at timestamptz,
  reminder_count smallint NOT NULL DEFAULT 0 CHECK (reminder_count >= 0),
  excused_reason varchar(200),
  CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL)),
  CHECK (confirmed_at IS NULL OR opened_at IS NOT NULL),
  CHECK (status <> 'excused' OR excused_reason IS NOT NULL)
);
CREATE UNIQUE INDEX acknowledgement_uq ON acknowledgement (acknowledgement_request_id, user_id);
CREATE INDEX acknowledgement_user_idx ON acknowledgement (user_id, status);

-- Retention and disposal review (D.8): rules per system and record class, reviews when a period ends, legal holds.
CREATE TABLE retention_rule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  management_system_id uuid NOT NULL REFERENCES management_system(id),
  record_class varchar(20) NOT NULL CHECK (record_class IN ('document_version', 'evidence_file', 'evidence_pack', 'audit_event', 'finding',
    'corrective_action', 'management_review', 'competence_record')),
  -- Required for document_version (the doc_type of the pack lookup), null for the other classes.
  doc_type varchar(20),
  retain_months smallint NOT NULL CHECK (retain_months BETWEEN 1 AND 1200),
  basis varchar(500),
  CHECK ((record_class = 'document_version') = (doc_type IS NOT NULL))
);
CREATE UNIQUE INDEX retention_rule_uq ON retention_rule (management_system_id, record_class, coalesce(doc_type, '')) WHERE deleted_at IS NULL;

CREATE TABLE retention_review (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  management_system_id uuid NOT NULL REFERENCES management_system(id),
  record_class varchar(20) NOT NULL CHECK (record_class IN ('document_version', 'evidence_file', 'evidence_pack', 'audit_event', 'finding',
    'corrective_action', 'management_review', 'competence_record')),
  item_id uuid NOT NULL,
  item_code varchar(60),
  item_title varchar(300),
  retention_ends_on date NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'kept', 'extended', 'awaiting_approval', 'disposed')),
  decision varchar(10) CHECK (decision IN ('keep', 'extend', 'dispose')),
  decided_by uuid REFERENCES platform.app_user(id),
  decided_at timestamptz,
  reason varchar(1000),
  keep_until date,
  approved_by uuid REFERENCES platform.app_user(id),
  approved_at timestamptz,
  rejected_note varchar(500),
  disposed_at timestamptz,
  file_action varchar(25) CHECK (file_action IN ('vault_content_deleted', 'owner_asked', 'none')),
  file_removed_by uuid REFERENCES platform.app_user(id),
  file_removed_at timestamptz,
  CHECK (status <> 'disposed' OR (decision = 'dispose' AND disposed_at IS NOT NULL AND approved_by IS NOT NULL)),
  CHECK (status <> 'awaiting_approval' OR decision = 'dispose'),
  CHECK (approved_by IS NULL OR approved_by IS DISTINCT FROM decided_by)
);
CREATE UNIQUE INDEX retention_review_open_uq ON retention_review (record_class, item_id) WHERE status IN ('open', 'awaiting_approval');
CREATE INDEX retention_review_ms_idx ON retention_review (management_system_id, status);
CREATE INDEX retention_review_due_idx ON retention_review (retention_ends_on) WHERE status IN ('kept', 'extended');

CREATE TABLE retention_hold (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  management_system_id uuid NOT NULL REFERENCES management_system(id),
  record_class varchar(20) NOT NULL CHECK (record_class IN ('document_version', 'evidence_file', 'evidence_pack', 'audit_event', 'finding',
    'corrective_action', 'management_review', 'competence_record')),
  item_id uuid NOT NULL,
  reason varchar(500) NOT NULL CHECK (length(btrim(reason)) > 0),
  set_by uuid REFERENCES platform.app_user(id),
  set_at timestamptz NOT NULL DEFAULT now(),
  released_by uuid REFERENCES platform.app_user(id),
  released_at timestamptz,
  release_reason varchar(500),
  CHECK ((released_at IS NULL) = (release_reason IS NULL))
);
-- One hold in force per item.
CREATE UNIQUE INDEX retention_hold_active_uq ON retention_hold (record_class, item_id) WHERE released_at IS NULL AND deleted_at IS NULL;

-- A replaced file (D.2 evidence.files, M3-06) and the content of a file removed by an approved disposal (D.8): the row
-- keeps its name, dates and hash, and every open and download path answers 404 content_disposed.
ALTER TABLE storage_object
  ADD COLUMN replaced_at timestamptz,
  ADD COLUMN content_disposed_at timestamptz,
  ADD COLUMN content_disposed_by uuid REFERENCES platform.app_user(id);

-- Periodic access review (D.9): the settings of the organisation, one review per period with one part per system.
CREATE TABLE access_review_setting (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  frequency_months smallint NOT NULL DEFAULT 3 CHECK (frequency_months IN (1, 3, 6, 12)),
  next_due_on date,
  days_to_complete smallint NOT NULL DEFAULT 14 CHECK (days_to_complete BETWEEN 1 AND 60),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1)
);
CREATE UNIQUE INDEX access_review_setting_org_uq ON access_review_setting (organization_id);

CREATE TABLE access_review (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  review_no varchar(20) NOT NULL,
  status varchar(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'cancelled')),
  opened_on date NOT NULL,
  due_on date NOT NULL,
  -- Null when the schedule opened it.
  opened_by uuid REFERENCES platform.app_user(id),
  completed_at timestamptz,
  completed_by uuid REFERENCES platform.app_user(id),
  cancel_reason varchar(500),
  summary jsonb,
  report_object_id uuid REFERENCES storage_object(id),
  CHECK (due_on >= opened_on),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL)
);
CREATE UNIQUE INDEX access_review_no_uq ON access_review (review_no);
-- One open review at a time.
CREATE UNIQUE INDEX access_review_open_uq ON access_review (organization_id) WHERE status = 'open';

CREATE TABLE access_review_part (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  access_review_id uuid NOT NULL REFERENCES access_review(id),
  -- Null for the organisation part (memberships, admin roles, linked company sign-in).
  management_system_id uuid REFERENCES management_system(id),
  status varchar(12) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'signed_off')),
  signed_off_by uuid REFERENCES platform.app_user(id),
  signed_off_at timestamptz,
  evidence_id uuid REFERENCES evidence(id),
  evidence_filed_at timestamptz,
  CHECK ((status = 'signed_off') = (signed_off_at IS NOT NULL))
);
CREATE UNIQUE INDEX access_review_part_uq ON access_review_part (access_review_id, management_system_id) NULLS NOT DISTINCT;

CREATE TABLE access_review_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform.app_user(id),
  updated_by uuid REFERENCES platform.app_user(id),
  deleted_at timestamptz,
  access_review_id uuid NOT NULL REFERENCES access_review(id),
  access_review_part_id uuid NOT NULL REFERENCES access_review_part(id),
  subject_user_id uuid NOT NULL REFERENCES platform.app_user(id),
  item_kind varchar(15) NOT NULL CHECK (item_kind IN ('membership', 'admin_role', 'business_role', 'auditor_access', 'linked_sign_in')),
  -- The ids of the reviewed row (membership, role grant, guest grant or linked identity).
  ref jsonb NOT NULL DEFAULT '{}'::jsonb,
  role varchar(30),
  granted_by uuid REFERENCES platform.app_user(id),
  granted_at timestamptz,
  valid_until date,
  last_sign_in_at timestamptz,
  decision varchar(10) CHECK (decision IN ('keep', 'change', 'revoke')),
  decision_note varchar(500),
  decided_by uuid REFERENCES platform.app_user(id),
  decided_at timestamptz,
  applied_at timestamptz,
  applied_by uuid REFERENCES platform.app_user(id),
  applied_action varchar(60),
  not_applied_reason varchar(500),
  CHECK ((decision IS NULL) = (decided_at IS NULL)),
  -- Nobody decides on their own access (REVIEW-OWN-ACCESS).
  CHECK (decided_by IS NULL OR decided_by <> subject_user_id),
  CHECK (applied_at IS NULL OR not_applied_reason IS NULL)
);
CREATE INDEX access_review_item_part_idx ON access_review_item (access_review_part_id);
CREATE INDEX access_review_item_subject_idx ON access_review_item (subject_user_id);

-- Stored tasks that are completed on their own screen (D3-13, C.3): a confirmation, an access review part, a personal
-- data check. The column grows from varchar(12) to fit the new sources.
ALTER TABLE task DROP CONSTRAINT task_source_rule_check;
ALTER TABLE task ALTER COLUMN source_rule TYPE varchar(20);
ALTER TABLE task ADD CONSTRAINT task_source_rule_check
  CHECK (source_rule IN ('BR-10', 'BR-11', 'BR-15', 'BR-31', 'manual', 'acknowledgement', 'access_review', 'privacy_check'));

-- The export of one person's data (D.6.3): kind personal_data in json, with the person and the request it answers.
ALTER TABLE export_file DROP CONSTRAINT export_file_kind_check;
ALTER TABLE export_file ADD CONSTRAINT export_file_kind_check
  CHECK (kind IN ('portfolio_board', 'readiness', 'soa', 'document_register', 'audit_trail', 'personal_data'));
ALTER TABLE export_file DROP CONSTRAINT export_file_format_check;
ALTER TABLE export_file ADD CONSTRAINT export_file_format_check CHECK (format IN ('pdf', 'xlsx', 'csv', 'json'));
ALTER TABLE export_file
  ADD COLUMN subject_user_id uuid REFERENCES platform.app_user(id),
  ADD COLUMN privacy_request_id uuid REFERENCES privacy_request(id),
  ADD CONSTRAINT export_file_personal_data_check CHECK ((kind = 'personal_data') = (subject_user_id IS NOT NULL));

-- Attested redaction of tenant audit entries (D.5.4): outside the hashed columns, written only by the definer function
-- of platform/0008 (the append-only trigger refuses every other update).
ALTER TABLE audit_trail
  ADD COLUMN redacted_at timestamptz,
  ADD COLUMN redaction_id uuid,
  ADD CONSTRAINT audit_trail_redaction_check CHECK ((redacted_at IS NULL) = (redaction_id IS NULL));

SELECT platform.secure_tenant_schema(current_schema());
