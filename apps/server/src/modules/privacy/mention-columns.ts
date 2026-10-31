// The text columns the mention search of a personal data check reads (Milestone 3 D.6.4), and the text columns it leaves
// out with the reason. MSCD has no separate contact fields: a person who is not a member (a contact of an interested
// party, a business associate who is an individual, a lead auditor) is named in the free text of records, so the search
// reads the titles, descriptions, notes and justifications of every record of a system.
//
// `test/int/privacy/mention-columns.test.ts` fails on a tenant text column (`text`, `character varying`, `jsonb`,
// `json` and arrays) of a freshly migrated tenant schema that is in neither list, and on a listed column that no longer
// exists. A package that adds such a column lists it here: searched, with the scope that ties its rows to a system, or
// not searched, with the reason.
//
// Scope of a searched table:
// - `ms`: the row's own `management_system_id`;
// - `link`: the row is linked to the system through `entity_ms_link` (entity type = the table name);
// - `parent`: the row belongs to a parent row whose scope is `ms` or `link` (`column` names the parent's id);
// - `object`: a stored file that is the file of an evidence item or of a document version of the system;
// - `evidence`: an evidence item linked to the system, or one that targets an entry of the system.
// An organisation-wide document counts in every system, as the read model lists it there.

/** How a searched table's rows are tied to a management system. */
export type MentionScope =
  | { kind: 'ms' }
  | { kind: 'link' }
  | { kind: 'parent'; column: string; parent: string; parentScope: 'ms' | 'link' }
  | { kind: 'object' }
  | { kind: 'evidence' };

/** A searched table: the record kind and id a mention shows, its code, and the searched columns. */
export interface MentionTable {
  /** The record kind a mention names (the table of the record the screen opens); default the table itself. */
  kind?: string;
  /** SQL expression of the record kind over alias `t`, for a table whose rows name records of several kinds. */
  kindSql?: string;
  /** SQL expression of the record id over alias `t` (and the joins); default `t.id`. */
  recordId?: string;
  /** SQL expression of the business code over alias `t` (and the joins), or null when the record has none. */
  code: string | null;
  /** Extra joins over alias `t` (constant SQL). */
  joins?: string;
  scope: MentionScope;
  /** The searched text columns of the table. */
  columns: readonly string[];
  /** False for a table without `deleted_at`. */
  softDelete?: boolean;
}

const ms = { kind: 'ms' } as const;
const link = { kind: 'link' } as const;

/** Searched tables and columns (D.6.4). */
export const MENTION_TABLES: Readonly<Record<string, MentionTable>> = {
  access_review_item: {
    kind: 'access_review',
    recordId: 't.access_review_id',
    code: '(select r.review_no from access_review r where r.id = t.access_review_id)',
    scope: { kind: 'parent', column: 'access_review_part_id', parent: 'access_review_part', parentScope: 'ms' },
    columns: ['decision_note', 'not_applied_reason'],
  },
  applicability_entry: {
    code: 'coalesce(ci.item_code, rq.requirement_code)',
    joins: 'left join ref.catalogue_item ci on ci.id = t.catalogue_item_id left join ref.requirement rq on rq.id = t.requirement_id',
    scope: ms,
    columns: ['inclusion_justification', 'exclusion_justification', 'gate_reason', 'status_note'],
  },
  asset: { code: 't.code', scope: link, columns: ['title'] },
  audit_activity: { code: 't.target_code', scope: ms, columns: ['title', 'note', 'key_questions', 'evidence_to_request'] },
  audit_event: {
    code: 't.short_label',
    scope: ms,
    columns: ['name_en', 'name_id', 'lead_auditor_name', 'scope_text', 'expected_focus', 'outcome_summary'],
  },
  audit_prep_task: { code: 't.template_code', scope: ms, columns: ['title', 'note'] },
  bc_plan: { code: 't.code', scope: ms, columns: ['title'] },
  business_associate: { code: 't.code', scope: ms, columns: ['title', 'pending_action'] },
  business_impact_analysis: { code: 't.code', scope: ms, columns: ['title', 'pending_action', 'dependencies', 'resources_required'] },
  certification_cycle: { code: 't.certificate_no', scope: ms, columns: ['certified_scope'] },
  chain_record: { code: 't.code', scope: ms, columns: ['title', 'pending_action'] },
  competence_record: { code: null, scope: link, columns: ['role_title', 'competence_required', 'pending_action'] },
  context_issue: { code: 't.code', scope: link, columns: ['title', 'description', 'pending_action'] },
  corrective_action: {
    code: 't.code',
    scope: ms,
    columns: ['title', 'action_text', 'correction_text', 'rca_text', 'systemic_check_text', 'verification_note'],
  },
  cycle_requirement_status: { code: 't.requirement_code', scope: ms, columns: ['condition_note'] },
  document: { code: 't.doc_code', scope: link, columns: ['title', 'external_source', 'external_ref'] },
  document_version: {
    kind: 'document',
    recordId: 't.document_id',
    code: '(select d.doc_code from document d where d.id = t.document_id)',
    scope: { kind: 'parent', column: 'document_id', parent: 'document', parentScope: 'link' },
    columns: ['change_summary', 'rejection_note'],
  },
  due_diligence: { code: null, scope: ms, columns: ['conditions'] },
  entity_ms_link: { kindSql: 't.entity_type', recordId: 't.entity_id', code: null, scope: ms, columns: ['relevance_note'] },
  evidence: { code: 't.evidence_code', scope: { kind: 'evidence' }, columns: ['title', 'external_ref'] },
  evidence_pack_item: {
    kind: 'evidence_pack',
    recordId: 't.evidence_pack_id',
    code: 't.evidence_code',
    scope: { kind: 'parent', column: 'evidence_pack_id', parent: 'evidence_pack', parentScope: 'ms' },
    columns: ['exception_reason'],
    softDelete: false,
  },
  evidence_target: {
    kind: 'evidence',
    recordId: 't.evidence_id',
    code: '(select e.evidence_code from evidence e where e.id = t.evidence_id)',
    scope: ms,
    columns: ['mapping_note'],
  },
  exercise: { code: 't.code', scope: ms, columns: ['title', 'lessons', 'pending_action'] },
  finding: { code: 't.code', scope: ms, columns: ['title', 'close_note', 'rca_text', 'systemic_check_text', 'status_note'] },
  implementation_activity_progress: {
    code: "t.phase_no || '.' || t.activity_no",
    scope: ms,
    columns: ['title', 'blocker_reason', 'expected_outcome'],
  },
  interested_party: { code: 't.code', scope: link, columns: ['title', 'requirements'] },
  management_review: { code: 't.code', scope: link, columns: ['title', 'decisions_text'] },
  management_review_input: {
    kind: 'management_review',
    recordId: 't.management_review_id',
    code: '(select r.code from management_review r where r.id = t.management_review_id)',
    scope: ms,
    columns: ['content'],
  },
  metric: { code: 't.code', scope: link, columns: ['title', 'pending_action'] },
  metric_value: {
    kind: 'metric',
    recordId: 't.metric_id',
    code: '(select m.code from metric m where m.id = t.metric_id)',
    scope: { kind: 'parent', column: 'metric_id', parent: 'metric', parentScope: 'link' },
    columns: ['note'],
  },
  operating_criteria: { code: null, scope: ms, columns: ['description'] },
  prioritized_activity: { code: 't.code', scope: ms, columns: ['title', 'product_service', 'mbco_note', 'pending_action'] },
  process: { code: 't.code', scope: ms, columns: ['title', 'inputs', 'outputs'] },
  quality_objective: {
    code: 't.code',
    scope: ms,
    columns: ['title', 'statement', 'target_text', 'evaluation_method', 'resources', 'result', 'pending_action'],
  },
  residual_acceptance: {
    kind: 'risk',
    recordId: 't.risk_id',
    code: '(select r.code from risk r where r.id = t.risk_id)',
    scope: { kind: 'parent', column: 'risk_id', parent: 'risk', parentScope: 'link' },
    columns: ['note'],
  },
  retention_hold: { code: null, scope: ms, columns: ['reason', 'release_reason'] },
  retention_review: { code: 't.item_code', scope: ms, columns: ['item_title', 'reason', 'rejected_note'] },
  retention_rule: { code: 't.record_class', scope: ms, columns: ['basis'] },
  risk: { code: 't.code', scope: link, columns: ['title', 'description', 'pending_action'] },
  risk_treatment: { code: 't.code', scope: ms, columns: ['title', 'pending_action'] },
  self_assessment: { code: null, scope: ms, columns: ['note'] },
  storage_object: { code: null, scope: { kind: 'object' }, columns: ['display_name', 'folder_path', 'provider_modified_by'] },
  storage_routing_rule: { code: null, scope: ms, columns: ['note'] },
  task: { code: 't.entity_code', scope: ms, columns: ['title_en', 'title_id'] },
};

/** Why a text column is not searched. */
const WHY = {
  code: 'A code, number, label or key that the system, the pack or a fixed list gives',
  status: 'A value from a fixed list (status, type, kind, role or classification)',
  system: 'Written by the system, never typed by a person',
  audit: 'Audit trail: the erasure redacts the entries that name the person (D.5.4), the chain stays verifiable',
  request: 'Part of the personal data request itself, kept as proof that the request was answered (D.6.5)',
  notification: "Messages to members: the erasure deletes the person's own notifications, the others age out (D.6.7)",
  settings: 'Settings of the organisation, its systems or its repositories, not about a person',
  secret: 'Sealed credentials and account keys of a repository',
  transient: 'An upload in progress; it expires within hours and is never shown as a record',
  organisation: 'Organisation level text of an access review or a repository move, which no system check reads; the Tenant Admin who answers the request checks it',
  guest: "A guest auditor's own address, removed when the grant is revoked through Auditor access",
  ratings: 'Ratings and numbers per period, not free text',
} as const;

function columns(reason: string, list: readonly string[]): Record<string, string> {
  return Object.fromEntries(list.map((c) => [c, reason]));
}

/** Text columns that are not searched, by table, each with the reason. */
export const NOT_SEARCHED: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  access_review: { ...columns(WHY.organisation, ['cancel_reason']), ...columns(WHY.code, ['review_no']), ...columns(WHY.status, ['status']), ...columns(WHY.system, ['summary']) },
  access_review_item: { ...columns(WHY.system, ['applied_action', 'ref']), ...columns(WHY.status, ['decision', 'item_kind', 'role']) },
  access_review_part: columns(WHY.status, ['status']),
  acknowledgement: { ...columns(WHY.system, ['excused_reason']), ...columns(WHY.status, ['status']) },
  acknowledgement_request: columns(WHY.status, ['audience_roles', 'audience_scope', 'status']),
  applicability_entry: columns(WHY.status, ['freshness_status', 'implementation_status', 'integrity_status', 'target_type']),
  asset: { ...columns(WHY.status, ['asset_type', 'classification']), ...columns(WHY.code, ['code']) },
  audit_activity: { ...columns(WHY.code, ['clause_ref', 'target_code', 'template_code']), ...columns(WHY.status, ['status']) },
  audit_event: { ...columns(WHY.status, ['event_type', 'outcome']), ...columns(WHY.code, ['short_label']) },
  audit_prep_task: { ...columns(WHY.status, ['status']), ...columns(WHY.code, ['template_code']) },
  audit_trail: columns(WHY.audit, ['action', 'actor_kind', 'after_data', 'before_data', 'edition', 'entity_code', 'entity_type', 'request_id', 'user_agent']),
  auditor_access_grant: columns(WHY.guest, ['email']),
  background_task: columns(WHY.system, ['error', 'job_id', 'kind', 'params', 'result', 'status']),
  bc_plan: { ...columns(WHY.code, ['code']), ...columns(WHY.status, ['status']) },
  business_associate: { ...columns(WHY.status, ['bribery_risk_level', 'category', 'jurisdiction']), ...columns(WHY.code, ['code']) },
  business_impact_analysis: { ...columns(WHY.code, ['code']), ...columns(WHY.ratings, ['impact_over_time']), ...columns(WHY.status, ['status']) },
  certification_cycle: { ...columns(WHY.code, ['certificate_no']), ...columns(WHY.settings, ['certification_body']), ...columns(WHY.status, ['status']) },
  chain_record: { ...columns(WHY.code, ['code', 'stage_key']), ...columns(WHY.status, ['related_entity_type']) },
  clause_readiness: columns(WHY.status, ['source']),
  competence_record: columns(WHY.status, ['proof_type']),
  context_issue: { ...columns(WHY.code, ['code']), ...columns(WHY.status, ['issue_type']) },
  corrective_action: { ...columns(WHY.code, ['code']), ...columns(WHY.status, ['status']) },
  cycle_requirement_status: { ...columns(WHY.code, ['requirement_code']), ...columns(WHY.status, ['status']), ...columns(WHY.system, ['title']) },
  document: {
    ...columns(WHY.status, ['acknowledgement_roles', 'acknowledgement_scope', 'classification', 'origin', 'status']),
    ...columns(WHY.code, ['doc_code', 'doc_type']),
  },
  document_code_link: columns(WHY.code, ['pack_code']),
  document_version: { ...columns(WHY.status, ['status']), ...columns(WHY.code, ['version_label']) },
  drift_result: { ...columns(WHY.code, ['entity_code', 'rule_code']), ...columns(WHY.status, ['entity_type']), ...columns(WHY.system, ['title']) },
  due_diligence: columns(WHY.status, ['outcome', 'status', 'subject_type']),
  entity_ms_link: columns(WHY.status, ['entity_type']),
  erased_person: columns(WHY.request, ['pseudonym']),
  evidence: { ...columns(WHY.status, ['classification', 'freshness_status', 'integrity_status']), ...columns(WHY.code, ['evidence_code', 'frequency_code']) },
  evidence_pack: { ...columns(WHY.system, ['pack_folder', 'scope']), ...columns(WHY.status, ['status']) },
  evidence_pack_item: {
    ...columns(WHY.system, ['copy_location', 'external_version_id', 'hash_algorithm', 'hash_value', 'link_status']),
    ...columns(WHY.code, ['evidence_code', 'requirement_codes']),
  },
  evidence_target: columns(WHY.status, ['target_type']),
  exercise: { ...columns(WHY.code, ['code']), ...columns(WHY.status, ['exercise_type']) },
  export_file: columns(WHY.system, ['file_name', 'format', 'kind']),
  finding: { ...columns(WHY.status, ['classification', 'source', 'status']), ...columns(WHY.code, ['clause_ref', 'code', 'target_code']) },
  freshness_threshold: columns(WHY.code, ['frequency_code']),
  implementation_activity_progress: {
    ...columns(WHY.code, ['blocker_gate_item_ref', 'clause_ref', 'output_document_code', 'template_pack_version']),
    ...columns(WHY.status, ['status']),
  },
  import_run: columns(WHY.system, ['file_name', 'kind', 'results', 'status']),
  interested_party: columns(WHY.code, ['code']),
  link_health_result: columns(WHY.system, ['detail', 'job_id', 'observed_folder_path', 'observed_hash', 'observed_version_id', 'outcome', 'status_after', 'status_before']),
  management_review: { ...columns(WHY.code, ['code']), ...columns(WHY.status, ['status']) },
  management_review_input: columns(WHY.system, ['source_refs']),
  management_system: columns(WHY.settings, ['certification_body', 'code', 'color', 'display', 'name', 'scope_statement', 'slug', 'status']),
  management_system_version: columns(WHY.status, ['role']),
  metric: { ...columns(WHY.code, ['code', 'frequency_code']), ...columns(WHY.status, ['unit']) },
  ms_alert: columns(WHY.system, ['kind', 'source_ref', 'text_en', 'text_id', 'tone']),
  notification: {
    ...columns(WHY.notification, ['body_en', 'body_id', 'title_en', 'title_id']),
    ...columns(WHY.system, ['email_status', 'entity_ref', 'kind', 'last_error']),
  },
  operating_criteria: columns(WHY.code, ['frequency_code']),
  prioritized_activity: columns(WHY.code, ['code']),
  privacy_check: columns(WHY.request, ['note', 'status']),
  privacy_request: columns(WHY.request, [
    'channel', 'identity_check_note', 'outcome', 'request_no', 'request_type', 'result', 'status', 'subject_email', 'subject_kind', 'subject_name',
  ]),
  process: columns(WHY.code, ['code']),
  quality_objective: { ...columns(WHY.code, ['code']), ...columns(WHY.status, ['status']) },
  record_reference: { ...columns(WHY.status, ['direction', 'entity_type']), ...columns(WHY.code, ['target_code']) },
  reminder: columns(WHY.system, ['channels', 'entity_type', 'record_key']),
  repository_move_request: { ...columns(WHY.organisation, ['note']), ...columns(WHY.status, ['status']) },
  retention_hold: columns(WHY.status, ['record_class']),
  retention_review: { ...columns(WHY.status, ['decision', 'file_action', 'record_class', 'status']), ...columns(WHY.code, ['item_code']) },
  retention_rule: { ...columns(WHY.code, ['doc_type']), ...columns(WHY.status, ['record_class']) },
  risk: { ...columns(WHY.code, ['code', 'risk_profile_code']), ...columns(WHY.ratings, ['impact_dimensions']), ...columns(WHY.status, ['treatment_option']) },
  risk_treatment: { ...columns(WHY.code, ['code']), ...columns(WHY.status, ['status', 'target_type']) },
  self_assessment: columns(WHY.status, ['status']),
  storage_credential: columns(WHY.secret, ['credential_ref', 'external_account', 'key_id', 'kind', 'sealed_blob']),
  storage_object: columns(WHY.system, [
    'encryption', 'external_item_id', 'external_version_id', 'folder_id', 'hash_algorithm', 'hash_source', 'hash_value', 'link_status',
    'link_status_reason', 'mime_type', 'version_label', 'web_url',
  ]),
  storage_repository: columns(WHY.settings, [
    'adapter', 'config', 'connection_message_en', 'connection_message_id', 'connection_status', 'credential_ref', 'display', 'modes', 'name',
    'ownership_type', 'slug',
  ]),
  storage_routing_rule: columns(WHY.status, ['approval_status', 'classification', 'mode', 'object_kind']),
  task: { ...columns(WHY.code, ['entity_code']), ...columns(WHY.status, ['entity_type', 'source_rule', 'status']) },
  trace_chain_instance: columns(WHY.code, ['anchor_code']),
  trace_chain_node: columns(WHY.code, ['record_code', 'stage_key']),
  upload_intent: { ...columns(WHY.transient, ['correlation_code', 'folder_path', 'original_name', 'stored_name']), ...columns(WHY.status, ['mode', 'object_kind', 'status']) },
  user_ms_role: columns(WHY.status, ['approval_status', 'role']),
};
