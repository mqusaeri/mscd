// What the organisation export holds and what it leaves out, with one reason per item (Milestone 3 D.4, rule R-21).
//
// - Every tenant table is listed in `TENANT_TABLES`: exported to `data/tenant/<table>.csv` and `.jsonl` (every row,
//   every column minus the excluded ones), or to the audit folder. The build exports every table of the schema, and
//   the coverage test (test/int/org-export/coverage.test.ts) fails on a tenant table that is not listed here, so a new
//   table is classified, and its secret columns excluded, before it ships.
// - Every platform table with `organization_id`, or with a foreign key to a table that has one, is listed in
//   `PLATFORM_TABLES`: exported to a file of `data/platform/` with its exported and excluded columns, or excluded with
//   a reason. The coverage test also fails on a column of an exported platform table that is in neither list.
// - `GENERAL_EXCLUSIONS` names what is not a table of its own (job queues, the build's own export objects).
// `exclusionList()` is the list the manifest carries.

export interface TenantTablePlan {
  /** `data`: `data/tenant/<table>.csv` and `.jsonl`; `audit`: the audit folder (with hashes and canonical texts). */
  file: 'data' | 'audit';
  /** Columns left out, each with its reason. */
  excludedColumns?: Readonly<Record<string, string>>;
  /** Rows left out, with the reason (the filter itself is in `tenant-data.ts`). */
  excludedRows?: string;
}

const SEALED_CREDENTIAL = 'Sealed repository credential (client secret, certificate key or token). It opens the repository and is a secret; the repository settings are in storage_repository';
const FEED_TOKEN = 'Hash of a calendar feed token. It is a secret that opens the feed; the feed itself holds only review dates that are in the exported tables';
const GUEST_CODE = 'Hash of the guest auditor sign-in link token. It is a secret that opens the guest sign-in';
const ENCRYPTION_HEADER = 'Encryption header of a Managed Vault file with its wrapped content key. The export holds the decrypted file instead, under files/';

/** Every tenant table and where it goes (R-21). */
export const TENANT_TABLES: Readonly<Record<string, TenantTablePlan>> = {
  acknowledgement: { file: 'data' },
  acknowledgement_request: { file: 'data' },
  access_review: { file: 'data' },
  access_review_item: { file: 'data' },
  access_review_part: { file: 'data' },
  access_review_setting: { file: 'data' },
  applicability_entry: { file: 'data' },
  applicability_entry_document: { file: 'data' },
  applicability_entry_risk: { file: 'data' },
  asset: { file: 'data' },
  audit_activity: { file: 'data' },
  audit_event: { file: 'data' },
  audit_prep_task: { file: 'data' },
  audit_trail: { file: 'audit' },
  auditor_access_grant: { file: 'data', excludedColumns: { token_hash: GUEST_CODE } },
  background_task: { file: 'data' },
  bc_plan: { file: 'data' },
  business_associate: { file: 'data' },
  business_impact_analysis: { file: 'data' },
  calendar_feed_token: { file: 'data', excludedColumns: { token_hash: FEED_TOKEN } },
  certification_cycle: { file: 'data' },
  chain_record: { file: 'data' },
  clause_readiness: { file: 'data' },
  competence_record: { file: 'data' },
  context_issue: { file: 'data' },
  corrective_action: { file: 'data' },
  corrective_action_finding: { file: 'data' },
  cycle_requirement_status: { file: 'data' },
  document: { file: 'data' },
  document_code_link: { file: 'data' },
  document_version: { file: 'data' },
  drift_result: { file: 'data' },
  due_diligence: { file: 'data' },
  entity_ms_link: { file: 'data' },
  erased_person: { file: 'data' },
  evidence: { file: 'data' },
  evidence_pack: { file: 'data' },
  evidence_pack_item: { file: 'data' },
  evidence_target: { file: 'data' },
  exercise: { file: 'data' },
  export_file: { file: 'data' },
  finding: { file: 'data' },
  freshness_threshold: { file: 'data' },
  implementation_activity_progress: { file: 'data' },
  import_run: { file: 'data' },
  interested_party: { file: 'data' },
  link_health_result: { file: 'data' },
  management_review: { file: 'data' },
  management_review_input: { file: 'data' },
  management_system: { file: 'data' },
  management_system_version: { file: 'data' },
  metric: { file: 'data' },
  metric_value: { file: 'data' },
  ms_alert: { file: 'data' },
  notification: { file: 'data' },
  operating_criteria: { file: 'data' },
  prioritized_activity: { file: 'data' },
  privacy_check: { file: 'data' },
  privacy_request: { file: 'data' },
  process: { file: 'data' },
  quality_objective: { file: 'data' },
  record_reference: { file: 'data' },
  reminder: { file: 'data' },
  repository_move_request: { file: 'data' },
  residual_acceptance: { file: 'data' },
  retention_hold: { file: 'data' },
  retention_review: { file: 'data' },
  retention_rule: { file: 'data' },
  risk: { file: 'data' },
  risk_treatment: { file: 'data' },
  self_assessment: { file: 'data' },
  self_assessment_evidence: { file: 'data' },
  storage_credential: { file: 'data', excludedColumns: { sealed_blob: SEALED_CREDENTIAL } },
  storage_object: {
    file: 'data',
    excludedColumns: { encryption: ENCRYPTION_HEADER },
    excludedRows: 'The parts and manifests of organisation exports, this one included: an export of exports would hold the same data again',
  },
  storage_repository: { file: 'data' },
  storage_routing_rule: { file: 'data' },
  task: { file: 'data' },
  trace_chain_instance: { file: 'data' },
  trace_chain_node: { file: 'data' },
  upload_intent: { file: 'data' },
  user_ms_role: { file: 'data' },
};

/** The excluded columns of a tenant table (none for a table this build does not know). */
export function excludedTenantColumns(table: string): ReadonlySet<string> {
  return new Set(Object.keys(TENANT_TABLES[table]?.excludedColumns ?? {}));
}

export interface PlatformTablePlan {
  /** The file of `data/platform/` (or of `audit/`) without extension; absent when the table is excluded. */
  file?: string;
  /** Exported columns, under the column name or the name the file gives them. */
  exported?: readonly string[];
  /** Columns left out of the file, each with its reason. */
  excludedColumns?: Readonly<Record<string, string>>;
  /** Why the whole table is left out. */
  excluded?: string;
  /** How rows are chosen or changed for the file. */
  note?: string;
}

const AUDIT_COLUMNS = [
  'seq', 'id', 'occurred_at', 'organization_id', 'management_system_id', 'actor_user_id', 'actor_kind', 'action', 'entity_type', 'entity_id',
  'entity_code', 'before_data', 'after_data', 'edition', 'request_id', 'source_ip', 'user_agent', 'prev_hash', 'row_hash', 'redacted_at', 'redaction_id',
] as const;

/** Every platform table that holds data of an organisation, and where it goes (R-21). */
export const PLATFORM_TABLES: Readonly<Record<string, PlatformTablePlan>> = {
  'platform.organization': {
    file: 'data/platform/organization',
    exported: ['id', 'slug', 'name', 'time_zone', 'site_count', 'status', 'local_login', 'region', 'created_at', 'updated_at', 'deleted_at', 'offboarding_ends_at'],
    excludedColumns: {
      schema_name: 'Name of the database schema inside this MSCD installation; it means nothing outside it',
      demo_deploy_label: 'Label of demonstration builds; never set for a customer organisation',
      position: 'Sort order of the operator console',
    },
  },
  'platform.org_membership': {
    file: 'data/platform/members',
    exported: ['organization_id', 'user_id', 'admin_roles', 'status', 'is_default', 'invited_by', 'accepted_at', 'created_at', 'updated_at', 'deleted_at'],
    note: 'One row per membership, with the account of the person; created_at is the date of the invitation',
  },
  'platform.app_user': {
    file: 'data/platform/members',
    exported: ['id', 'handle', 'email', 'display_name', 'job_title', 'kind', 'status', 'last_login_at', 'created_at', 'deleted_at', 'erased_at'],
    excludedColumns: {
      password_hash: 'Password hash: a secret of the account',
      password_changed_at: 'Security state of the account, kept by MSCD to enforce its password rules',
      failed_login_count: 'Security state of the account (lockout counter)',
      locked_until: 'Security state of the account (lockout)',
      mfa_required: 'Security state of the account (second factor policy)',
      mfa_failed_count: 'Security state of the account (second factor lockout counter)',
      mfa_lock_level: 'Security state of the account (second factor lockout)',
      mfa_locked_until: 'Security state of the account (second factor lockout)',
      is_demo: 'Marks demonstration accounts; never set for a customer account',
      created_by: 'Internal account that created the account record (the system or an installer)',
      updated_by: 'Internal account that last changed the account record',
      updated_at: 'Time of the last change of the account record, which several organisations may share',
    },
    note: 'Only accounts with a membership of this organisation; a person listed in erased_person appears under the pseudonym only',
  },
  'platform.identity_provider': {
    file: 'data/platform/identity_providers',
    exported: [
      'id', 'organization_id', 'slug', 'kind', 'display_name', 'icon', 'enabled', 'oidc_issuer', 'oidc_client_id', 'oidc_scopes', 'subject_mode', 'entra_tenant_id',
      'saml_entry_point', 'saml_idp_issuer', 'saml_idp_certs', 'saml_sp_entity_id', 'saml_mfa_authn_contexts', 'require_mfa_claim', 'accepted_amr', 'mfa_fallback',
      'jit_provisioning', 'allowed_email_domains', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at',
    ],
    excludedColumns: { oidc_client_secret_sealed: 'Sealed client secret of the identity provider: a secret' },
  },
  'platform.user_identity': {
    file: 'data/platform/linked_sign_in',
    exported: ['identity_provider_id', 'subject', 'user_id', 'email_at_link', 'link_method', 'linked_by', 'linked_at', 'last_login_at'],
    note: 'Links to the company sign-in providers of this organisation only; none for a person listed in erased_person',
  },
  'platform.verified_domain': {
    file: 'data/platform/verified_domains',
    exported: ['organization_id', 'domain', 'status', 'method', 'requested_at', 'verified_at', 'verified_by', 'last_checked_at'],
    excludedColumns: { txt_token_hash: 'Hash of the DNS verification token: a secret of the verification' },
  },
  'platform.session': {
    file: 'data/platform/sessions',
    exported: [
      'user_id', 'organization_id', 'auth_org_id', 'state', 'auth_method', 'identity_provider_id', 'auth_grant_id', 'amr', 'password_at', 'mfa_at', 'persistent',
      'created_at', 'last_seen_at', 'idle_expires_at', 'absolute_expires_at', 'revoked_at', 'revoke_reason', 'ip', 'user_agent',
    ],
    excludedColumns: {
      id_hash: 'Session id (its hash identifies the session cookie): a secret',
      csrf_token_hash: 'Hash of the session CSRF token: a secret',
    },
    note: 'Sessions in this organisation; none of a person listed in erased_person',
  },
  'platform.licence': {
    file: 'data/platform/licences',
    exported: ['id', 'organization_id', 'license_id', 'document', 'document_sha256', 'key_id', 'installed_at', 'installed_by', 'superseded_at'],
  },
  'platform.entitlement': {
    file: 'data/platform/entitlements',
    exported: [
      'organization_id', 'plan', 'source', 'max_users', 'max_management_systems', 'frameworks', 'storage_adapters', 'features', 'rate_user_per_minute',
      'rate_org_per_minute', 'valid_from', 'valid_until', 'grace_days', 'version', 'updated_at', 'updated_by',
    ],
  },
  'platform.organization_status_event': {
    file: 'data/platform/status_history',
    exported: ['id', 'organization_id', 'from_status', 'to_status', 'reason', 'actor_user_id', 'created_at'],
  },
  'platform.audit_log': {
    file: 'data/platform/audit_log',
    exported: [...AUDIT_COLUMNS],
    note:
      'Entries of this organisation in the platform chain. source_ip and user_agent are empty in entries whose actor is a platform operator or the system ' +
      '(they belong to the staff of the provider). The platform chain links the entries of every organisation of the installation, so these hashes ' +
      'cannot be checked from this export alone; MSCD checks them',
  },
  'platform.organization_export': {
    file: 'data/platform/exports',
    exported: [
      'id', 'organization_id', 'status', 'requested_via', 'requested_by', 'requested_at', 'decided_by', 'decided_at', 'decision_note', 'is_final', 'part_count',
      'file_count', 'size_bytes', 'parts', 'manifest_object_id', 'manifest_sha256', 'expires_at', 'completed_at', 'download_count', 'error', 'created_at', 'updated_at',
    ],
  },
  'platform.organization_deletion': {
    file: 'data/platform/deletions',
    exported: [
      'id', 'organization_id', 'status', 'scheduled_for', 'scheduled_by', 'reason', 'final_export_id', 'started_at', 'completed_at', 'failed_step', 'error',
      'report', 'vault_objects_deleted', 'certificate', 'certificate_signature', 'certificate_key_id', 'created_at', 'updated_at',
    ],
    excludedColumns: { notify_emails_sealed: 'Sealed email addresses for the deletion certificate, held only until it is sent' },
  },
  'platform.audit_anchor': {
    file: 'audit/anchors',
    exported: ['chain', 'seq', 'row_hash', 'anchored_at', 'payload', 'signature', 'key_id'],
    excludedColumns: {
      id: 'Internal row id of the anchor',
      exported_to: 'Where MSCD copied the anchor inside the installation',
    },
    note: 'The signed anchors of the tenant chain of this organisation, as GET /admin/audit-trail/anchors writes them, with the public anchor key',
  },
  'platform.invitation': {
    excluded:
      'Invitation links: the token hash is a secret. Who was invited, by whom and when is in members (invited_by, created_at, accepted_at)',
  },
  'platform.auth_transaction': { excluded: 'Short-lived sign-in transactions (minutes) with secret state, nonce and code hashes' },
  'platform.saml_assertion_seen': { excluded: 'Hashes of SAML assertion ids kept for a few minutes to refuse a replayed sign-in' },
  'platform.tenant_key': { excluded: 'Wrapped data key of the organisation: key material that opens the Managed Vault files, which the export holds decrypted' },
  'platform.idempotency_key': { excluded: 'Idempotency keys of requests, kept for 24 hours to answer a repeated request once' },
  'platform.daily_job_run': { excluded: 'Run ledger of the daily jobs of the scheduler (job name and date only)' },
};

/** Platform tables without organisation data that the export still names, so the list of what is left out is complete. */
export const ACCOUNT_TABLE_EXCLUSIONS: Readonly<Record<string, string>> = {
  'platform.mfa_factor': 'Authenticator (TOTP) secrets of accounts',
  'platform.mfa_recovery_code': 'Hashes of the recovery codes of accounts',
  'platform.password_reset_token': 'Hashes of password reset and set-password links',
  'platform.user_preference': 'Personal settings of an account (language, theme), which belong to the account and not to an organisation',
  'platform.rate_limit_bucket': 'Rate limit counters of requests',
  'platform.job_outbox': 'Job queue rows waiting to be relayed to the queue',
};

/** Items that are not one table (the job queues, keys outside the database, the export's own files). */
export const GENERAL_EXCLUSIONS: readonly { item: string; reason: string }[] = [
  { item: 'Job queue rows (pg-boss schema or the BullMQ queue)', reason: 'Work items of the worker; they hold record ids, not records' },
  { item: 'Key files of the installation (platform.key, storage.key, gateway.token, audit-anchor.key)', reason: 'Key material of the installation, shared by every organisation' },
  { item: 'Parts and manifests of organisation exports in the Managed Vault', reason: 'An export of exports would hold the same data again' },
  { item: 'Data of any other organisation', reason: 'The build reads the tenant schema of this organisation and platform rows of this organisation only' },
];

/** The exclusion list of the manifest: one item and reason per excluded table, column, row set and general item. */
export function exclusionList(): { item: string; reason: string }[] {
  const out: { item: string; reason: string }[] = [];
  for (const [table, plan] of Object.entries(TENANT_TABLES)) {
    for (const [column, reason] of Object.entries(plan.excludedColumns ?? {})) out.push({ item: `${table}.${column}`, reason });
    if (plan.excludedRows) out.push({ item: `${table} (some rows)`, reason: plan.excludedRows });
  }
  for (const [table, plan] of Object.entries(PLATFORM_TABLES)) {
    if (plan.excluded) out.push({ item: table, reason: plan.excluded });
    for (const [column, reason] of Object.entries(plan.excludedColumns ?? {})) out.push({ item: `${table}.${column}`, reason });
  }
  for (const [table, reason] of Object.entries(ACCOUNT_TABLE_EXCLUSIONS)) out.push({ item: table, reason });
  out.push(...GENERAL_EXCLUSIONS);
  return out;
}
