// Kysely row types of the tenant tables that migrations/tenant/0009_milestone3.sql creates (docs/platform/MILESTONE-3.md
// D.3, written by M3-01): requests from one person and their system checks with the erased people (M3-04), read
// confirmation requests and confirmations (M3-05), retention rules, disposal reviews and legal holds (M3-06), and the
// access review with its settings, parts and items (M3-07). The columns 0009 adds to existing tables are in the group
// file of each table.
// Hand-maintained (C.7): test/int/db/schema-types.test.ts compares TABLE_COLUMNS with the migrated database.
// Conventions as the other group files: columns with a database default are Generated<T>; timestamptz is Date; date
// is a 'YYYY-MM-DD' string; jsonb is read parsed and written as a JSON string; CHECK-listed values are unions.
import type { Generated } from 'kysely';
import { tableColumns, type GeneratedJson, type JsonObject, type NullableJson } from './index';

/** Business roles a read confirmation can name (Milestone 3 J.7 `document.acknowledgement_roles`). */
export type AcknowledgementRoleValue =
  | 'ms_manager' | 'programme_owner' | 'domain_owner' | 'risk_owner' | 'internal_auditor' | 'top_management' | 'compliance_investigator';
/** Record classes of retention (Milestone 3 J.7). */
export type RetentionRecordClassValue =
  | 'document_version' | 'evidence_file' | 'evidence_pack' | 'audit_event' | 'finding' | 'corrective_action' | 'management_review' | 'competence_record';

interface TenantColumns {
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
}

/** `privacy_request`: a request from one person about their own personal data (D.6). */
export interface PrivacyRequestTable extends TenantColumns {
  id: Generated<string>;
  request_no: string;
  request_type: 'access' | 'rectification' | 'restriction' | 'erasure';
  status: Generated<'received' | 'in_progress' | 'completed' | 'refused' | 'withdrawn'>;
  subject_kind: 'member' | 'other';
  subject_user_id: string | null;
  subject_name: string | null;
  subject_email: string | null;
  channel: 'self_service' | 'email' | 'letter' | 'provider' | 'other';
  received_at: Date;
  due_at: Date;
  identity_check_note: string | null;
  identity_checked_by: string | null;
  handled_by: string | null;
  closed_at: Date | null;
  outcome: string | null;
  result: NullableJson;
}

/** `privacy_check`: the check of one management system for an access or erasure request (D.6.4). */
export interface PrivacyCheckTable extends TenantColumns {
  id: Generated<string>;
  privacy_request_id: string;
  management_system_id: string;
  status: Generated<'open' | 'done'>;
  done_by: string | null;
  done_at: Date | null;
  note: string | null;
}

/** `erased_person`: a person erased in this organisation and the pseudonym it shows instead (D.6.5). */
export interface ErasedPersonTable extends TenantColumns {
  erased_user_id: string;
  pseudonym: string;
  privacy_request_id: string | null;
  erased_at: Generated<Date>;
  erased_by: string | null;
}

/** `acknowledgement_request`: the read confirmation request of one approved document version (D.7). */
export interface AcknowledgementRequestTable extends TenantColumns {
  id: Generated<string>;
  management_system_id: string;
  document_id: string;
  document_version_id: string;
  status: Generated<'open' | 'closed'>;
  audience_scope: 'system_roles' | 'roles' | 'organisation';
  audience_roles: AcknowledgementRoleValue[] | null;
  audience_count: Generated<number>;
  due_on: string;
  last_reminded_at: Date | null;
  closed_at: Date | null;
  closed_by: string | null;
  evidence_id: string | null;
}

/** `acknowledgement`: one person of a confirmation request (D.7). */
export interface AcknowledgementTable extends TenantColumns {
  id: Generated<string>;
  acknowledgement_request_id: string;
  user_id: string;
  status: Generated<'pending' | 'confirmed' | 'excused'>;
  opened_at: Date | null;
  confirmed_at: Date | null;
  reminded_at: Date | null;
  reminder_count: Generated<number>;
  excused_reason: string | null;
}

/** `retention_rule`: the retention period of a record class (and document type) of one system (D.8). */
export interface RetentionRuleTable extends TenantColumns {
  id: Generated<string>;
  management_system_id: string;
  record_class: RetentionRecordClassValue;
  doc_type: string | null;
  retain_months: number;
  basis: string | null;
}

/** `retention_review`: the disposal review of an item whose retention period ended (D.8, machine of J.8). */
export interface RetentionReviewTable extends TenantColumns {
  id: Generated<string>;
  management_system_id: string;
  record_class: RetentionRecordClassValue;
  item_id: string;
  item_code: string | null;
  item_title: string | null;
  retention_ends_on: string;
  status: Generated<'open' | 'kept' | 'extended' | 'awaiting_approval' | 'disposed'>;
  decision: 'keep' | 'extend' | 'dispose' | null;
  decided_by: string | null;
  decided_at: Date | null;
  reason: string | null;
  keep_until: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  rejected_note: string | null;
  disposed_at: Date | null;
  file_action: 'vault_content_deleted' | 'owner_asked' | 'none' | null;
  file_removed_by: string | null;
  file_removed_at: Date | null;
}

/** `retention_hold`: a legal hold that keeps an item whatever its period says (D.8). */
export interface RetentionHoldTable extends TenantColumns {
  id: Generated<string>;
  management_system_id: string;
  record_class: RetentionRecordClassValue;
  item_id: string;
  reason: string;
  set_by: string | null;
  set_at: Generated<Date>;
  released_by: string | null;
  released_at: Date | null;
  release_reason: string | null;
}

/** `access_review_setting`: how often the organisation reviews access (D.9); one row per organisation. */
export interface AccessReviewSettingTable extends TenantColumns {
  id: Generated<string>;
  frequency_months: Generated<1 | 3 | 6 | 12>;
  next_due_on: string | null;
  days_to_complete: Generated<number>;
  version: Generated<number>;
}

/** `access_review`: one periodic access review (D.9, machine of J.8). */
export interface AccessReviewTable extends TenantColumns {
  id: Generated<string>;
  review_no: string;
  status: Generated<'open' | 'completed' | 'cancelled'>;
  opened_on: string;
  due_on: string;
  opened_by: string | null;
  completed_at: Date | null;
  completed_by: string | null;
  cancel_reason: string | null;
  summary: NullableJson;
  report_object_id: string | null;
}

/** `access_review_part`: the organisation part (no system) or the part of one system of an access review (D.9). */
export interface AccessReviewPartTable extends TenantColumns {
  id: Generated<string>;
  access_review_id: string;
  management_system_id: string | null;
  status: Generated<'open' | 'signed_off'>;
  signed_off_by: string | null;
  signed_off_at: Date | null;
  evidence_id: string | null;
  evidence_filed_at: Date | null;
}

/** `access_review_item`: one right of the snapshot of an access review, with its decision and how it was applied (D.9). */
export interface AccessReviewItemTable extends TenantColumns {
  id: Generated<string>;
  access_review_id: string;
  access_review_part_id: string;
  subject_user_id: string;
  item_kind: 'membership' | 'admin_role' | 'business_role' | 'auditor_access' | 'linked_sign_in';
  ref: GeneratedJson<JsonObject>;
  role: string | null;
  granted_by: string | null;
  granted_at: Date | null;
  valid_until: string | null;
  last_sign_in_at: Date | null;
  decision: 'keep' | 'change' | 'revoke' | null;
  decision_note: string | null;
  decided_by: string | null;
  decided_at: Date | null;
  applied_at: Date | null;
  applied_by: string | null;
  applied_action: string | null;
  not_applied_reason: string | null;
}

/** Tables of this group as Kysely table keys (tenant tables are unqualified: the request transaction sets search_path, D-03). */
export interface TenantMilestone3Tables {
  privacy_request: PrivacyRequestTable;
  privacy_check: PrivacyCheckTable;
  erased_person: ErasedPersonTable;
  acknowledgement_request: AcknowledgementRequestTable;
  acknowledgement: AcknowledgementTable;
  retention_rule: RetentionRuleTable;
  retention_review: RetentionReviewTable;
  retention_hold: RetentionHoldTable;
  access_review_setting: AccessReviewSettingTable;
  access_review: AccessReviewTable;
  access_review_part: AccessReviewPartTable;
  access_review_item: AccessReviewItemTable;
}

declare module './index' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface DB extends TenantMilestone3Tables {}
}

const STANDARD = ['organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at'] as const;

/** Column names per table, checked against the interfaces above by the compiler and against the database by the drift test. */
export const TABLE_COLUMNS = tableColumns<TenantMilestone3Tables>()({
  privacy_request: [
    'id', ...STANDARD, 'request_no', 'request_type', 'status', 'subject_kind', 'subject_user_id', 'subject_name', 'subject_email', 'channel',
    'received_at', 'due_at', 'identity_check_note', 'identity_checked_by', 'handled_by', 'closed_at', 'outcome', 'result',
  ],
  privacy_check: ['id', ...STANDARD, 'privacy_request_id', 'management_system_id', 'status', 'done_by', 'done_at', 'note'],
  erased_person: ['erased_user_id', ...STANDARD, 'pseudonym', 'privacy_request_id', 'erased_at', 'erased_by'],
  acknowledgement_request: [
    'id', ...STANDARD, 'management_system_id', 'document_id', 'document_version_id', 'status', 'audience_scope', 'audience_roles',
    'audience_count', 'due_on', 'last_reminded_at', 'closed_at', 'closed_by', 'evidence_id',
  ],
  acknowledgement: [
    'id', ...STANDARD, 'acknowledgement_request_id', 'user_id', 'status', 'opened_at', 'confirmed_at', 'reminded_at', 'reminder_count',
    'excused_reason',
  ],
  retention_rule: ['id', ...STANDARD, 'management_system_id', 'record_class', 'doc_type', 'retain_months', 'basis'],
  retention_review: [
    'id', ...STANDARD, 'management_system_id', 'record_class', 'item_id', 'item_code', 'item_title', 'retention_ends_on', 'status', 'decision',
    'decided_by', 'decided_at', 'reason', 'keep_until', 'approved_by', 'approved_at', 'rejected_note', 'disposed_at', 'file_action',
    'file_removed_by', 'file_removed_at',
  ],
  retention_hold: [
    'id', ...STANDARD, 'management_system_id', 'record_class', 'item_id', 'reason', 'set_by', 'set_at', 'released_by', 'released_at',
    'release_reason',
  ],
  access_review_setting: ['id', ...STANDARD, 'frequency_months', 'next_due_on', 'days_to_complete', 'version'],
  access_review: [
    'id', ...STANDARD, 'review_no', 'status', 'opened_on', 'due_on', 'opened_by', 'completed_at', 'completed_by', 'cancel_reason', 'summary',
    'report_object_id',
  ],
  access_review_part: [
    'id', ...STANDARD, 'access_review_id', 'management_system_id', 'status', 'signed_off_by', 'signed_off_at', 'evidence_id', 'evidence_filed_at',
  ],
  access_review_item: [
    'id', ...STANDARD, 'access_review_id', 'access_review_part_id', 'subject_user_id', 'item_kind', 'ref', 'role', 'granted_by', 'granted_at',
    'valid_until', 'last_sign_in_at', 'decision', 'decision_note', 'decided_by', 'decided_at', 'applied_at', 'applied_by', 'applied_action',
    'not_applied_reason',
  ],
});
