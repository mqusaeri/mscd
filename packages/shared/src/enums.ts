// Enumerations of the MSCD contract (build plan C.4 to C.6, C.11, C.12, D.1, E.2, E.6, F.6, F.11), with the values
// that Milestone 2 adds (docs/platform/MILESTONE-2.md D.3 and J; marked "Milestone 2" below) and the values that
// Milestone 3 adds (docs/platform/MILESTONE-3.md D.3 and J; marked "Milestone 3" below, written by M3-01).
//
// Every database enumeration is a `varchar` column with a CHECK constraint; the arrays below hold exactly the
// values of those constraints, in the order the DDL lists them (R-07). Each array has a zod schema of the same
// name in PascalCase (registered with that name as its schema id) and a TypeScript type of the same name.
// Framework-specific enumerations (`doc_type`, `treatment_option`, lookup domains in general) are pack data and
// are not listed here (TS 1.1, C.1).
import { z } from 'zod';

function enumSchema<const T extends readonly [string, ...string[]]>(id: string, values: T, description: string) {
  return z.enum(values).meta({ id, description });
}

// ---------------------------------------------------------------------------------------------------------------
// Platform schema (C.4)
// ---------------------------------------------------------------------------------------------------------------

/** `deleted`: Milestone 3 J.7, the end of the lifecycle of D.5 (set by the purge only, never by a caller). */
export const ORGANIZATION_STATUSES = ['active', 'suspended', 'offboarding', 'archived', 'deleted'] as const;
export const OrganizationStatus = enumSchema('OrganizationStatus', ORGANIZATION_STATUSES, 'platform.organization.status (deleted: Milestone 3 J.7)');
export type OrganizationStatus = z.infer<typeof OrganizationStatus>;

export const LOCAL_LOGIN_POLICIES = ['allowed', 'admins_only', 'disabled'] as const;
export const LocalLoginPolicy = enumSchema('LocalLoginPolicy', LOCAL_LOGIN_POLICIES, 'platform.organization.local_login (F.4)');
export type LocalLoginPolicy = z.infer<typeof LocalLoginPolicy>;

export const DEPLOY_LABELS = ['saas', 'onprem'] as const;
export const DeployLabel = enumSchema('DeployLabel', DEPLOY_LABELS, 'Deployment label: SystemProfile.deploy, platform.organization.demo_deploy_label');
export type DeployLabel = z.infer<typeof DeployLabel>;

export const USER_KINDS = ['person', 'system', 'guest'] as const;
export const UserKind = enumSchema('UserKind', USER_KINDS, 'platform.app_user.kind');
export type UserKind = z.infer<typeof UserKind>;

export const ACCOUNT_STATUSES = ['active', 'invited', 'disabled'] as const;
export const AccountStatus = enumSchema('AccountStatus', ACCOUNT_STATUSES, 'platform.app_user.status');
export type AccountStatus = z.infer<typeof AccountStatus>;

export const MEMBERSHIP_STATUSES = ['active', 'invited', 'disabled'] as const;
export const MembershipStatus = enumSchema('MembershipStatus', MEMBERSHIP_STATUSES, 'platform.org_membership.status');
export type MembershipStatus = z.infer<typeof MembershipStatus>;

/** Organisation roles (F.6 TA, SA), stored in `platform.org_membership.admin_roles`. */
export const ORG_ROLES = ['tenant_admin', 'storage_admin'] as const;
export const OrgRole = enumSchema('OrgRole', ORG_ROLES, 'Organisation role (platform.org_membership.admin_roles, F.6)');
export type OrgRole = z.infer<typeof OrgRole>;

/** Platform roles (F.6 OP), stored in `platform.platform_role.role`. */
export const PLATFORM_ROLES = ['platform_operator'] as const;
export const PlatformRole = enumSchema('PlatformRole', PLATFORM_ROLES, 'Platform role (platform.platform_role.role, F.6)');
export type PlatformRole = z.infer<typeof PlatformRole>;

export const IDENTITY_PROVIDER_KINDS = ['oidc', 'saml'] as const;
export const IdentityProviderKind = enumSchema('IdentityProviderKind', IDENTITY_PROVIDER_KINDS, 'platform.identity_provider.kind');
export type IdentityProviderKind = z.infer<typeof IdentityProviderKind>;

export const IDENTITY_PROVIDER_ICONS = ['microsoft', 'google', 'generic'] as const;
export const IdentityProviderIcon = enumSchema('IdentityProviderIcon', IDENTITY_PROVIDER_ICONS, 'platform.identity_provider.icon');
export type IdentityProviderIcon = z.infer<typeof IdentityProviderIcon>;

export const SUBJECT_MODES = ['sub', 'entra'] as const;
export const SubjectMode = enumSchema('SubjectMode', SUBJECT_MODES, 'platform.identity_provider.subject_mode (F.8 step 3)');
export type SubjectMode = z.infer<typeof SubjectMode>;

export const MFA_FALLBACKS = ['local_totp', 'reject'] as const;
export const MfaFallback = enumSchema('MfaFallback', MFA_FALLBACKS, 'platform.identity_provider.mfa_fallback (F.5)');
export type MfaFallback = z.infer<typeof MfaFallback>;

export const IDENTITY_LINK_METHODS = ['invitation', 'session', 'admin', 'jit'] as const;
export const IdentityLinkMethod = enumSchema('IdentityLinkMethod', IDENTITY_LINK_METHODS, 'platform.user_identity.link_method (D-25)');
export type IdentityLinkMethod = z.infer<typeof IdentityLinkMethod>;

export const SESSION_STATES = ['mfa_pending', 'mfa_enrolment', 'active'] as const;
export const SessionState = enumSchema('SessionState', SESSION_STATES, 'platform.session.state (F.1)');
export type SessionState = z.infer<typeof SessionState>;

export const AUTH_METHODS = ['local', 'oidc', 'saml', 'demo', 'guest', 'test'] as const;
export const AuthMethod = enumSchema('AuthMethod', AUTH_METHODS, 'platform.session.auth_method');
export type AuthMethod = z.infer<typeof AuthMethod>;

export const MFA_FACTOR_KINDS = ['totp'] as const;
export const MfaFactorKind = enumSchema('MfaFactorKind', MFA_FACTOR_KINDS, 'platform.mfa_factor.kind');
export type MfaFactorKind = z.infer<typeof MfaFactorKind>;

export const AUTH_TRANSACTION_KINDS = ['oidc_login', 'oidc_link', 'saml_login', 'saml_link', 'repo_oauth', 'guest_otp'] as const;
export const AuthTransactionKind = enumSchema('AuthTransactionKind', AUTH_TRANSACTION_KINDS, 'platform.auth_transaction.kind');
export type AuthTransactionKind = z.infer<typeof AuthTransactionKind>;

export const PASSWORD_TOKEN_KINDS = ['reset', 'set_password'] as const;
export const PasswordTokenKind = enumSchema('PasswordTokenKind', PASSWORD_TOKEN_KINDS, 'platform.password_reset_token.kind');
export type PasswordTokenKind = z.infer<typeof PasswordTokenKind>;

export const PACK_INSTALL_STATUSES = ['validating', 'installed', 'failed', 'superseded'] as const;
export const PackInstallStatus = enumSchema('PackInstallStatus', PACK_INSTALL_STATUSES, 'platform.pack_install.status');
export type PackInstallStatus = z.infer<typeof PackInstallStatus>;

export const PACK_CATALOG_CHANNELS = ['managed', 'online', 'offline'] as const;
export const PackCatalogChannel = enumSchema('PackCatalogChannel', PACK_CATALOG_CHANNELS, 'platform.pack_catalog.channel; also the profile keys packs.channel and updates.channel');
export type PackCatalogChannel = z.infer<typeof PackCatalogChannel>;

export const ACTOR_KINDS = ['user', 'system', 'guest', 'operator'] as const;
export const ActorKind = enumSchema('ActorKind', ACTOR_KINDS, 'platform.audit_log.actor_kind and audit_trail.actor_kind');
export type ActorKind = z.infer<typeof ActorKind>;

/** Verification state of an email domain of an organisation (Milestone 2 J.7 `platform.verified_domain.status`). */
export const DOMAIN_STATUSES = ['pending', 'verified', 'failed'] as const;
export const DomainStatus = enumSchema('DomainStatus', DOMAIN_STATUSES, 'platform.verified_domain.status (Milestone 2 J.7)');
export type DomainStatus = z.infer<typeof DomainStatus>;

/** How a domain was verified: a DNS TXT record (SaaS) or the operator command (on-premise) (Milestone 2 J.7). */
export const DOMAIN_VERIFICATION_METHODS = ['dns', 'manual'] as const;
export const DomainVerificationMethod = enumSchema('DomainVerificationMethod', DOMAIN_VERIFICATION_METHODS, 'platform.verified_domain.method (Milestone 2 J.7)');
export type DomainVerificationMethod = z.infer<typeof DomainVerificationMethod>;

/** Where the entitlement row of an organisation comes from (Milestone 2 J.7 `platform.entitlement.source`). */
export const ENTITLEMENT_SOURCES = ['preset', 'manual', 'signed_licence'] as const;
export const EntitlementSource = enumSchema('EntitlementSource', ENTITLEMENT_SOURCES, 'platform.entitlement.source (Milestone 2 J.7)');
export type EntitlementSource = z.infer<typeof EntitlementSource>;

/** State of a full organisation export (Milestone 3 J.7 `platform.organization_export.status`, machine of J.8). */
export const ORGANIZATION_EXPORT_STATUSES = ['requested', 'queued', 'building', 'ready', 'failed', 'rejected', 'expired'] as const;
export const OrganizationExportStatus = enumSchema('OrganizationExportStatus', ORGANIZATION_EXPORT_STATUSES, 'platform.organization_export.status (Milestone 3 J.7)');
export type OrganizationExportStatus = z.infer<typeof OrganizationExportStatus>;

/** Who asked for an organisation export: a Tenant Admin, the platform operator, or the move to offboarding (Milestone 3 J.7). */
export const EXPORT_REQUEST_SOURCES = ['tenant_admin', 'operator', 'offboarding'] as const;
export const ExportRequestSource = enumSchema('ExportRequestSource', EXPORT_REQUEST_SOURCES, 'platform.organization_export.requested_via (Milestone 3 J.7)');
export type ExportRequestSource = z.infer<typeof ExportRequestSource>;

/** State of the verified deletion of an organisation (Milestone 3 J.7 `platform.organization_deletion.status`). */
export const ORGANIZATION_DELETION_STATUSES = ['scheduled', 'cancelled', 'running', 'completed', 'failed'] as const;
export const OrganizationDeletionStatus = enumSchema('OrganizationDeletionStatus', ORGANIZATION_DELETION_STATUSES, 'platform.organization_deletion.status (Milestone 3 J.7)');
export type OrganizationDeletionStatus = z.infer<typeof OrganizationDeletionStatus>;

// ---------------------------------------------------------------------------------------------------------------
// Reference schema (C.5)
// ---------------------------------------------------------------------------------------------------------------

export const FRAMEWORK_VERSION_STATUSES = ['current', 'transition', 'withdrawn'] as const;
export const FrameworkVersionStatus = enumSchema('FrameworkVersionStatus', FRAMEWORK_VERSION_STATUSES, 'ref.framework_version.status and the pack manifest status (TS 6.3)');
export type FrameworkVersionStatus = z.infer<typeof FrameworkVersionStatus>;

export const APPLICABILITY_TARGETS = ['catalogue_item', 'requirement'] as const;
export const ApplicabilityTarget = enumSchema('ApplicabilityTarget', APPLICABILITY_TARGETS, 'ref.framework_version.applicability_target and every target_type column');
export type ApplicabilityTarget = z.infer<typeof ApplicabilityTarget>;

export const CLAUSE_GROUPS = ['4', '5', '6', '7', '8', '9', '10'] as const;
export const ClauseGroup = enumSchema('ClauseGroup', CLAUSE_GROUPS, 'ref.requirement.clause_group (Harmonized Structure clauses 4 to 10)');
export type ClauseGroup = z.infer<typeof ClauseGroup>;

export const MAPPING_TYPES = ['equivalent', 'partial', 'related', 'split', 'merged', 'changed', 'new', 'removed'] as const;
export const MappingType = enumSchema('MappingType', MAPPING_TYPES, 'ref.requirement_mapping.mapping_type');
export type MappingType = z.infer<typeof MappingType>;

export const CHAIN_SOURCES = ['entity', 'applicability', 'justification', 'document', 'evidence'] as const;
export const ChainSource = enumSchema('ChainSource', CHAIN_SOURCES, 'ref.traceability_chain_def.source (C.10)');
export type ChainSource = z.infer<typeof ChainSource>;

export const LANGS = ['en', 'id'] as const;
export const Lang = enumSchema('Lang', LANGS, 'Interface and label language: English or Indonesian (ref.label.lang)');
export type Lang = z.infer<typeof Lang>;

export const DRIFT_SEVERITIES = ['crit', 'risk', 'warn'] as const;
export const DriftSeverity = enumSchema('DriftSeverity', DRIFT_SEVERITIES, 'ref.drift_rule_def.severity');
export type DriftSeverity = z.infer<typeof DriftSeverity>;

export const DRIFT_SOURCE_KINDS = ['manual', 'unverif', 'nohash', 'metric', 'exercise', 'stale_risk', 'dd_expired'] as const;
export const DriftSourceKind = enumSchema('DriftSourceKind', DRIFT_SOURCE_KINDS, 'ref.drift_rule_def.source_kind (E.2 drift.evaluate)');
export type DriftSourceKind = z.infer<typeof DriftSourceKind>;

export const FINDING_CLASSIFICATIONS = ['major', 'minor', 'ofi', 'signal', 'not_a_finding'] as const;
export const FindingClassification = enumSchema('FindingClassification', FINDING_CLASSIFICATIONS, 'finding.classification and ref.finding_condition.classification');
export type FindingClassification = z.infer<typeof FindingClassification>;

export const AUDIT_EVENT_TYPES = ['stage1', 'stage2', 'surveillance', 'recertification', 'transition', 'special', 'internal_audit'] as const;
export const AuditEventType = enumSchema('AuditEventType', AUDIT_EVENT_TYPES, 'audit_event.event_type and ref.audit_activity_template.event_type (internal_audit: Milestone 2 J.7)');
export type AuditEventType = z.infer<typeof AuditEventType>;

/** Kinds of required documented information (Milestone 2 J.7 `ref.documented_info.kind`): documents to maintain, records to retain. */
export const DOCUMENTED_INFO_KINDS = ['maintain', 'retain'] as const;
export const DocumentedInfoKind = enumSchema('DocumentedInfoKind', DOCUMENTED_INFO_KINDS, 'ref.documented_info.kind (Milestone 2 J.7)');
export type DocumentedInfoKind = z.infer<typeof DocumentedInfoKind>;

/** Review kinds of a review input (Milestone 2 J.7 `ref.review_input_def.review_kind`). */
export const REVIEW_KINDS = ['management', 'governing_body'] as const;
export const ReviewKind = enumSchema('ReviewKind', REVIEW_KINDS, 'ref.review_input_def.review_kind (Milestone 2 J.7)');
export type ReviewKind = z.infer<typeof ReviewKind>;

// ---------------------------------------------------------------------------------------------------------------
// Tenant schemas (C.6)
// ---------------------------------------------------------------------------------------------------------------

export const MS_STATUSES = ['setup', 'implementing', 'certified', 'transitioning', 'archived'] as const;
export const MsStatus = enumSchema('MsStatus', MS_STATUSES, 'management_system.status (TS 6.2)');
export type MsStatus = z.infer<typeof MsStatus>;

export const MS_VERSION_ROLES = ['active', 'transition_target', 'previous'] as const;
export const MsVersionRole = enumSchema('MsVersionRole', MS_VERSION_ROLES, 'management_system_version.role');
export type MsVersionRole = z.infer<typeof MsVersionRole>;

/** Business roles per management system (F.6 MM, PO, DO, RO, IA, TM, EA, CI), `user_ms_role.role`. */
export const BUSINESS_ROLES = [
  'ms_manager', 'programme_owner', 'domain_owner', 'risk_owner',
  'internal_auditor', 'top_management', 'external_auditor', 'compliance_investigator',
] as const;
export const BusinessRole = enumSchema('BusinessRole', BUSINESS_ROLES, 'Business role in one management system (user_ms_role.role, F.6)');
export type BusinessRole = z.infer<typeof BusinessRole>;

export const APPROVAL_STATUSES = ['active', 'pending_approval', 'rejected'] as const;
export const ApprovalStatus = enumSchema('ApprovalStatus', APPROVAL_STATUSES, 'user_ms_role.approval_status (F.6 four-eyes grants)');
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

/** Entity types shared between management systems through `entity_ms_link` (TS 4.2). */
export const SHAREABLE_ENTITY_TYPES = [
  'context_issue', 'interested_party', 'asset', 'document', 'evidence', 'risk', 'audit_event', 'management_review', 'metric',
  'competence_record',
] as const;
export const ShareableEntityType = enumSchema('ShareableEntityType', SHAREABLE_ENTITY_TYPES, 'entity_ms_link.entity_type (competence_record: Milestone 2 J.7)');
export type ShareableEntityType = z.infer<typeof ShareableEntityType>;

export const CERTIFICATION_CYCLE_STATUSES = ['planned', 'active', 'certified', 'suspended', 'withdrawn', 'expired', 'closed'] as const;
export const CertificationCycleStatus = enumSchema('CertificationCycleStatus', CERTIFICATION_CYCLE_STATUSES, 'certification_cycle.status');
export type CertificationCycleStatus = z.infer<typeof CertificationCycleStatus>;

export const MS_ALERT_KINDS = ['connector', 'transition', 'beta', 'withdrawn_edition', 'licence', 'other'] as const;
export const MsAlertKind = enumSchema('MsAlertKind', MS_ALERT_KINDS, 'ms_alert.kind; also ManagementSystem.banner.kind');
export type MsAlertKind = z.infer<typeof MsAlertKind>;

export const ALERT_TONES = ['info', 'warn', 'bad'] as const;
export const AlertTone = enumSchema('AlertTone', ALERT_TONES, 'ms_alert.tone; also ManagementSystem.banner.tone');
export type AlertTone = z.infer<typeof AlertTone>;

export const CLAUSE_READINESS_SOURCES = ['seeded', 'manual', 'computed'] as const;
export const ClauseReadinessSource = enumSchema('ClauseReadinessSource', CLAUSE_READINESS_SOURCES, 'clause_readiness.source');
export type ClauseReadinessSource = z.infer<typeof ClauseReadinessSource>;

export const STORAGE_ADAPTERS = ['managed_vault', 'm365', 'google_drive', 'smb', 's3', 'webdav'] as const;
export const StorageAdapter = enumSchema('StorageAdapter', STORAGE_ADAPTERS, 'storage_repository.adapter; also the licence storage_adapters entitlement');
export type StorageAdapter = z.infer<typeof StorageAdapter>;

export const STORAGE_MODES = ['stored', 'pass_through', 'link', 'zero_transit'] as const;
export const StorageMode = enumSchema('StorageMode', STORAGE_MODES, 'storage_repository.modes and storage_routing_rule.mode');
export type StorageMode = z.infer<typeof StorageMode>;

export const OWNERSHIP_TYPES = ['organizational', 'personal'] as const;
export const OwnershipType = enumSchema('OwnershipType', OWNERSHIP_TYPES, 'storage_repository.ownership_type (BR-30)');
export type OwnershipType = z.infer<typeof OwnershipType>;

export const CONNECTION_STATUSES = ['ok', 'degraded', 'failed', 'revoked'] as const;
export const ConnectionStatus = enumSchema('ConnectionStatus', CONNECTION_STATUSES, 'storage_repository.connection_status (TS 5.7)');
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;

export const CREDENTIAL_KINDS = [
  'm365_certificate', 'google_service_account', 'oauth_refresh_token', 's3_access_key', 'smb_account', 'webdav_account',
] as const;
export const CredentialKind = enumSchema('CredentialKind', CREDENTIAL_KINDS, 'storage_credential.kind');
export type CredentialKind = z.infer<typeof CredentialKind>;

export const CLASSIFICATIONS = ['public', 'internal', 'confidential', 'restricted'] as const;
export const Classification = enumSchema('Classification', CLASSIFICATIONS, 'Information classification of documents, evidence, assets and routing rules');
export type Classification = z.infer<typeof Classification>;

export const OBJECT_KINDS = ['document', 'evidence'] as const;
export const ObjectKind = enumSchema('ObjectKind', OBJECT_KINDS, 'storage_routing_rule.object_kind and upload_intent.object_kind');
export type ObjectKind = z.infer<typeof ObjectKind>;

export const ROUTING_APPROVAL_STATUSES = ['active', 'pending_approval', 'rejected', 'superseded'] as const;
export const RoutingApprovalStatus = enumSchema('RoutingApprovalStatus', ROUTING_APPROVAL_STATUSES, 'storage_routing_rule.approval_status (BR-38, A-50)');
export type RoutingApprovalStatus = z.infer<typeof RoutingApprovalStatus>;

export const HASH_ALGORITHMS = ['sha256', 'sha1', 'md5', 'quickxor', 'none'] as const;
export const HashAlgorithm = enumSchema('HashAlgorithm', HASH_ALGORITHMS, 'storage_object.hash_algorithm');
export type HashAlgorithm = z.infer<typeof HashAlgorithm>;

export const HASH_SOURCES = ['computed', 'provider', 'none'] as const;
export const HashSource = enumSchema('HashSource', HASH_SOURCES, 'storage_object.hash_source');
export type HashSource = z.infer<typeof HashSource>;

export const LINK_STATUSES = [
  'intact', 'moved', 'version_changed', 'verification_pending', 'hash_mismatch', 'pinned_version_lost', 'missing', 'access_denied',
] as const;
export const LinkStatus = enumSchema('LinkStatus', LINK_STATUSES, 'storage_object.link_status (TS 6.4, E.4)');
export type LinkStatus = z.infer<typeof LinkStatus>;

export const LINK_STATUS_REASONS = ['unreachable', 'credential_invalid'] as const;
export const LinkStatusReason = enumSchema('LinkStatusReason', LINK_STATUS_REASONS, 'storage_object.link_status_reason (TS 5.7)');
export type LinkStatusReason = z.infer<typeof LinkStatusReason>;

export const LINK_CHECK_OUTCOMES = ['found', 'not_found', 'forbidden', 'unreachable', 'rate_limited', 'error'] as const;
export const LinkCheckOutcome = enumSchema('LinkCheckOutcome', LINK_CHECK_OUTCOMES, 'link_health_result.outcome');
export type LinkCheckOutcome = z.infer<typeof LinkCheckOutcome>;

export const UPLOAD_MODES = ['stored', 'pass_through', 'zero_transit'] as const;
export const UploadMode = enumSchema('UploadMode', UPLOAD_MODES, 'upload_intent.mode');
export type UploadMode = z.infer<typeof UploadMode>;

export const UPLOAD_INTENT_STATUSES = ['open', 'uploaded', 'completed', 'expired', 'failed'] as const;
export const UploadIntentStatus = enumSchema('UploadIntentStatus', UPLOAD_INTENT_STATUSES, 'upload_intent.status');
export type UploadIntentStatus = z.infer<typeof UploadIntentStatus>;

export const MOVE_REQUEST_STATUSES = ['open', 'done', 'rejected'] as const;
export const MoveRequestStatus = enumSchema('MoveRequestStatus', MOVE_REQUEST_STATUSES, 'repository_move_request.status');
export type MoveRequestStatus = z.infer<typeof MoveRequestStatus>;

/** Status of a quality objective (Milestone 2 D.3, J.7). */
export const QUALITY_OBJECTIVE_STATUSES = ['planned', 'on_track', 'at_risk', 'achieved', 'missed'] as const;
export const QualityObjectiveStatus = enumSchema('QualityObjectiveStatus', QUALITY_OBJECTIVE_STATUSES, 'quality_objective.status (Milestone 2 J.7)');
export type QualityObjectiveStatus = z.infer<typeof QualityObjectiveStatus>;

/** Proof kinds of a competence record (Milestone 2 D.3, J.7). */
export const COMPETENCE_PROOF_TYPES = ['certificate', 'training', 'experience', 'assessment'] as const;
export const CompetenceProofType = enumSchema('CompetenceProofType', COMPETENCE_PROOF_TYPES, 'competence_record.proof_type (Milestone 2 J.7)');
export type CompetenceProofType = z.infer<typeof CompetenceProofType>;

/** Kinds of bulk import (Milestone 2 D2-13, J.7): one dry run and one commit per file. */
export const IMPORT_KINDS = ['applicability', 'documents', 'risks', 'evidence'] as const;
export const ImportKind = enumSchema('ImportKind', IMPORT_KINDS, 'import_run.kind and the {kind} path member of the import routes (Milestone 2 J.7)');
export type ImportKind = z.infer<typeof ImportKind>;

export const IMPORT_RUN_STATUSES = ['validated', 'committing', 'committed', 'failed', 'expired'] as const;
export const ImportRunStatus = enumSchema('ImportRunStatus', IMPORT_RUN_STATUSES, 'import_run.status (Milestone 2 J.7)');
export type ImportRunStatus = z.infer<typeof ImportRunStatus>;

// Milestone 3 J.7: requests from one person about their own personal data (D.6).

/** What the person asks for (Milestone 3 D.6.3): a copy, a correction, a stop of processing, or an erasure. */
export const PRIVACY_REQUEST_TYPES = ['access', 'rectification', 'restriction', 'erasure'] as const;
export const PrivacyRequestType = enumSchema('PrivacyRequestType', PRIVACY_REQUEST_TYPES, 'privacy_request.request_type (Milestone 3 J.7)');
export type PrivacyRequestType = z.infer<typeof PrivacyRequestType>;

export const PRIVACY_REQUEST_STATUSES = ['received', 'in_progress', 'completed', 'refused', 'withdrawn'] as const;
export const PrivacyRequestStatus = enumSchema('PrivacyRequestStatus', PRIVACY_REQUEST_STATUSES, 'privacy_request.status (Milestone 3 J.7, J.8)');
export type PrivacyRequestStatus = z.infer<typeof PrivacyRequestStatus>;

/** The person is a member (an account of the organisation) or someone only named in the text of records. */
export const PRIVACY_SUBJECT_KINDS = ['member', 'other'] as const;
export const PrivacySubjectKind = enumSchema('PrivacySubjectKind', PRIVACY_SUBJECT_KINDS, 'privacy_request.subject_kind (Milestone 3 J.7)');
export type PrivacySubjectKind = z.infer<typeof PrivacySubjectKind>;

/** How the request reached the organisation. */
export const PRIVACY_CHANNELS = ['self_service', 'email', 'letter', 'provider', 'other'] as const;
export const PrivacyChannel = enumSchema('PrivacyChannel', PRIVACY_CHANNELS, 'privacy_request.channel (Milestone 3 J.7)');
export type PrivacyChannel = z.infer<typeof PrivacyChannel>;

/** One system check of a request, done by the system's manager (Milestone 3 D.6.4). */
export const PRIVACY_CHECK_STATUSES = ['open', 'done'] as const;
export const PrivacyCheckStatus = enumSchema('PrivacyCheckStatus', PRIVACY_CHECK_STATUSES, 'privacy_check.status (Milestone 3 J.7)');
export type PrivacyCheckStatus = z.infer<typeof PrivacyCheckStatus>;

// Milestone 3 J.7: read confirmation of policies (D.7).

/** Who is asked to confirm a document: the holders of a role in its systems, chosen roles, or the whole organisation. */
export const ACKNOWLEDGEMENT_SCOPES = ['system_roles', 'roles', 'organisation'] as const;
export const AcknowledgementScope = enumSchema('AcknowledgementScope', ACKNOWLEDGEMENT_SCOPES, 'document.acknowledgement_scope and acknowledgement_request.audience_scope (Milestone 3 J.7)');
export type AcknowledgementScope = z.infer<typeof AcknowledgementScope>;

/** Business roles a document can ask to confirm it: every business role but the external auditor (Milestone 3 D.7). */
export const ACKNOWLEDGEMENT_ROLES = [
  'ms_manager', 'programme_owner', 'domain_owner', 'risk_owner', 'internal_auditor', 'top_management', 'compliance_investigator',
] as const;
export const AcknowledgementRole = enumSchema('AcknowledgementRole', ACKNOWLEDGEMENT_ROLES, 'document.acknowledgement_roles elements (Milestone 3 J.7)');
export type AcknowledgementRole = z.infer<typeof AcknowledgementRole>;

export const ACKNOWLEDGEMENT_REQUEST_STATUSES = ['open', 'closed'] as const;
export const AcknowledgementRequestStatus = enumSchema('AcknowledgementRequestStatus', ACKNOWLEDGEMENT_REQUEST_STATUSES, 'acknowledgement_request.status (Milestone 3 J.7)');
export type AcknowledgementRequestStatus = z.infer<typeof AcknowledgementRequestStatus>;

export const ACKNOWLEDGEMENT_STATUSES = ['pending', 'confirmed', 'excused'] as const;
export const AcknowledgementStatus = enumSchema('AcknowledgementStatus', ACKNOWLEDGEMENT_STATUSES, 'acknowledgement.status (Milestone 3 J.7)');
export type AcknowledgementStatus = z.infer<typeof AcknowledgementStatus>;

// Milestone 3 J.7: retention and disposal review (D.8).

/** Kinds of record a retention rule covers (Milestone 3 D.8 "Record classes"). */
export const RETENTION_RECORD_CLASSES = [
  'document_version', 'evidence_file', 'evidence_pack', 'audit_event', 'finding', 'corrective_action', 'management_review', 'competence_record',
] as const;
export const RetentionRecordClass = enumSchema('RetentionRecordClass', RETENTION_RECORD_CLASSES, 'retention_rule, retention_review and retention_hold record_class (Milestone 3 J.7)');
export type RetentionRecordClass = z.infer<typeof RetentionRecordClass>;

export const RETENTION_REVIEW_STATUSES = ['open', 'kept', 'extended', 'awaiting_approval', 'disposed'] as const;
export const RetentionReviewStatus = enumSchema('RetentionReviewStatus', RETENTION_REVIEW_STATUSES, 'retention_review.status (Milestone 3 J.7, J.8)');
export type RetentionReviewStatus = z.infer<typeof RetentionReviewStatus>;

export const RETENTION_DECISIONS = ['keep', 'extend', 'dispose'] as const;
export const RetentionDecision = enumSchema('RetentionDecision', RETENTION_DECISIONS, 'retention_review.decision (Milestone 3 J.7)');
export type RetentionDecision = z.infer<typeof RetentionDecision>;

/** What a disposal did to the file: vault content deleted, the owner asked to delete it in the customer repository, or nothing. */
export const DISPOSAL_FILE_ACTIONS = ['vault_content_deleted', 'owner_asked', 'none'] as const;
export const DisposalFileAction = enumSchema('DisposalFileAction', DISPOSAL_FILE_ACTIONS, 'retention_review.file_action (Milestone 3 J.7)');
export type DisposalFileAction = z.infer<typeof DisposalFileAction>;

// Milestone 3 J.7: periodic access review (D.9).

export const ACCESS_REVIEW_STATUSES = ['open', 'completed', 'cancelled'] as const;
export const AccessReviewStatus = enumSchema('AccessReviewStatus', ACCESS_REVIEW_STATUSES, 'access_review.status (Milestone 3 J.7, J.8)');
export type AccessReviewStatus = z.infer<typeof AccessReviewStatus>;

export const ACCESS_REVIEW_PART_STATUSES = ['open', 'signed_off'] as const;
export const AccessReviewPartStatus = enumSchema('AccessReviewPartStatus', ACCESS_REVIEW_PART_STATUSES, 'access_review_part.status (Milestone 3 J.7)');
export type AccessReviewPartStatus = z.infer<typeof AccessReviewPartStatus>;

/** The rights an access review takes a snapshot of (Milestone 3 D.9 "Opening"). */
export const ACCESS_REVIEW_ITEM_KINDS = ['membership', 'admin_role', 'business_role', 'auditor_access', 'linked_sign_in'] as const;
export const AccessReviewItemKind = enumSchema('AccessReviewItemKind', ACCESS_REVIEW_ITEM_KINDS, 'access_review_item.item_kind (Milestone 3 J.7)');
export type AccessReviewItemKind = z.infer<typeof AccessReviewItemKind>;

export const ACCESS_REVIEW_DECISIONS = ['keep', 'change', 'revoke'] as const;
export const AccessReviewDecision = enumSchema('AccessReviewDecision', ACCESS_REVIEW_DECISIONS, 'access_review_item.decision (Milestone 3 J.7)');
export type AccessReviewDecision = z.infer<typeof AccessReviewDecision>;

export const ISSUE_TYPES = ['internal', 'external'] as const;
export const IssueType = enumSchema('IssueType', ISSUE_TYPES, 'context_issue.issue_type');
export type IssueType = z.infer<typeof IssueType>;

export const TREATMENT_STATUSES = ['proposed', 'approved', 'in_progress', 'delayed', 'implemented', 'residual_accepted', 'closed'] as const;
export const TreatmentStatus = enumSchema('TreatmentStatus', TREATMENT_STATUSES, 'risk_treatment.status (C.13)');
export type TreatmentStatus = z.infer<typeof TreatmentStatus>;

export const BIA_STATUSES = ['draft', 'approved'] as const;
export const BiaStatus = enumSchema('BiaStatus', BIA_STATUSES, 'business_impact_analysis.status');
export type BiaStatus = z.infer<typeof BiaStatus>;

export const BC_PLAN_STATUSES = ['draft', 'approved', 'tested', 'untested'] as const;
export const BcPlanStatus = enumSchema('BcPlanStatus', BC_PLAN_STATUSES, 'bc_plan.status');
export type BcPlanStatus = z.infer<typeof BcPlanStatus>;

export const DUE_DILIGENCE_STATUSES = ['draft', 'completed', 'expired', 'superseded'] as const;
export const DueDiligenceStatus = enumSchema('DueDiligenceStatus', DUE_DILIGENCE_STATUSES, 'due_diligence.status');
export type DueDiligenceStatus = z.infer<typeof DueDiligenceStatus>;

export const REFERENCE_DIRECTIONS = ['up', 'down'] as const;
export const ReferenceDirection = enumSchema('ReferenceDirection', REFERENCE_DIRECTIONS, 'record_reference.direction (D-11)');
export type ReferenceDirection = z.infer<typeof ReferenceDirection>;

export const DOCUMENT_STATUSES = ['draft', 'in_review', 'approved', 'expired'] as const;
export const DocumentStatus = enumSchema('DocumentStatus', DOCUMENT_STATUSES, 'document.status (C.13)');
export type DocumentStatus = z.infer<typeof DocumentStatus>;

/** Origin of a registered document (Milestone 2 D.3, J.7): written by the organisation or received from outside. */
export const DOCUMENT_ORIGINS = ['internal', 'external'] as const;
export const DocumentOrigin = enumSchema('DocumentOrigin', DOCUMENT_ORIGINS, 'document.origin (Milestone 2 J.7)');
export type DocumentOrigin = z.infer<typeof DocumentOrigin>;

export const DOCUMENT_VERSION_STATUSES = ['draft', 'in_review', 'approved', 'rejected', 'superseded'] as const;
export const DocumentVersionStatus = enumSchema('DocumentVersionStatus', DOCUMENT_VERSION_STATUSES, 'document_version.status');
export type DocumentVersionStatus = z.infer<typeof DocumentVersionStatus>;

export const IMPLEMENTATION_STATUSES = [
  'not_started', 'planned', 'partially_implemented', 'complete', 'implemented', 'not_applicable',
] as const;
export const ImplementationStatus = enumSchema('ImplementationStatus', IMPLEMENTATION_STATUSES, 'applicability_entry.implementation_status (C.13, A.4 5.1)');
export type ImplementationStatus = z.infer<typeof ImplementationStatus>;

export const FRESHNESS_STATUSES = ['fresh', 'aging', 'expired', 'critical'] as const;
export const FreshnessStatus = enumSchema('FreshnessStatus', FRESHNESS_STATUSES, 'evidence.freshness_status and applicability_entry.freshness_status (E.3); the same codes on the UI wire');
export type FreshnessStatus = z.infer<typeof FreshnessStatus>;

export const INTEGRITY_STATUSES = ['ok', 'degraded', 'broken'] as const;
export const IntegrityStatus = enumSchema('IntegrityStatus', INTEGRITY_STATUSES, 'evidence.integrity_status and applicability_entry.integrity_status (A-05)');
export type IntegrityStatus = z.infer<typeof IntegrityStatus>;

export const AUDIT_OUTCOMES = ['recommended', 'recommended_with_conditions', 'not_recommended'] as const;
export const AuditOutcome = enumSchema('AuditOutcome', AUDIT_OUTCOMES, 'audit_event.outcome (A-03)');
export type AuditOutcome = z.infer<typeof AuditOutcome>;

/** `audit_prep_task.status` and `cycle_requirement_status.status` (TS 6.7, 6.8). */
export const TASK_PROGRESS_STATUSES = ['not_started', 'in_progress', 'done', 'blocked', 'overdue'] as const;
export const TaskProgressStatus = enumSchema('TaskProgressStatus', TASK_PROGRESS_STATUSES, 'audit_prep_task.status and cycle_requirement_status.status');
export type TaskProgressStatus = z.infer<typeof TaskProgressStatus>;

export const FINDING_SOURCES = ['certification_audit', 'internal_audit', 'self_assessment', 'other'] as const;
export const FindingSource = enumSchema('FindingSource', FINDING_SOURCES, 'finding.source');
export type FindingSource = z.infer<typeof FindingSource>;

export const FINDING_STATUSES = ['open', 'in_progress', 'closed'] as const;
export const FindingStatus = enumSchema('FindingStatus', FINDING_STATUSES, 'finding.status (C.13)');
export type FindingStatus = z.infer<typeof FindingStatus>;

export const CORRECTIVE_ACTION_STATUSES = [
  'correction', 'rca', 'systemic_check', 'action', 'effectiveness_verification', 'closed', 'cancelled',
] as const;
export const CorrectiveActionStatus = enumSchema('CorrectiveActionStatus', CORRECTIVE_ACTION_STATUSES, 'corrective_action.status (C.13)');
export type CorrectiveActionStatus = z.infer<typeof CorrectiveActionStatus>;

export const MANAGEMENT_REVIEW_STATUSES = ['planned', 'held', 'closed'] as const;
export const ManagementReviewStatus = enumSchema('ManagementReviewStatus', MANAGEMENT_REVIEW_STATUSES, 'management_review.status (C.13)');
export type ManagementReviewStatus = z.infer<typeof ManagementReviewStatus>;

export const ACTIVITY_STATUSES = ['not_started', 'in_progress', 'complete', 'verified', 'blocked'] as const;
export const ActivityStatus = enumSchema('ActivityStatus', ACTIVITY_STATUSES, 'implementation_activity_progress.status (C.13, TS 6.6; locked is derived, D-13)');
export type ActivityStatus = z.infer<typeof ActivityStatus>;

export const REMINDER_CHANNELS = ['email', 'in_app'] as const;
export const ReminderChannel = enumSchema('ReminderChannel', REMINDER_CHANNELS, 'reminder.channels (D-22: email and in-app only)');
export type ReminderChannel = z.infer<typeof ReminderChannel>;

export const EMAIL_STATUSES = ['pending', 'sent', 'failed', 'skipped'] as const;
export const EmailStatus = enumSchema('EmailStatus', EMAIL_STATUSES, 'notification.email_status');
export type EmailStatus = z.infer<typeof EmailStatus>;

export const BACKGROUND_TASK_KINDS = ['evidence_pack', 'export', 'link_health_run', 'pack_install', 'import'] as const;
export const BackgroundTaskKind = enumSchema('BackgroundTaskKind', BACKGROUND_TASK_KINDS, 'background_task.kind');
export type BackgroundTaskKind = z.infer<typeof BackgroundTaskKind>;

export const BACKGROUND_TASK_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const;
export const BackgroundTaskStatus = enumSchema('BackgroundTaskStatus', BACKGROUND_TASK_STATUSES, 'background_task.status');
export type BackgroundTaskStatus = z.infer<typeof BackgroundTaskStatus>;

export const EVIDENCE_PACK_STATUSES = ['queued', 'building', 'ready', 'failed'] as const;
export const EvidencePackStatus = enumSchema('EvidencePackStatus', EVIDENCE_PACK_STATUSES, 'evidence_pack.status');
export type EvidencePackStatus = z.infer<typeof EvidencePackStatus>;

/** `personal_data`: Milestone 3 J.7, the export of one person's data (D.6.3), made only by `exports.person.create` and `exports.me.create`. */
export const EXPORT_KINDS = ['portfolio_board', 'readiness', 'soa', 'document_register', 'audit_trail', 'personal_data'] as const;
export const ExportKind = enumSchema('ExportKind', EXPORT_KINDS, 'export_file.kind (personal_data: Milestone 3 J.7)');
export type ExportKind = z.infer<typeof ExportKind>;

/** The kinds `POST /exports` accepts: the five of Milestone 1 (Milestone 3 D.2: its body refuses `personal_data`). */
export const EXPORT_REQUEST_KINDS = ['portfolio_board', 'readiness', 'soa', 'document_register', 'audit_trail'] as const satisfies readonly ExportKind[];
export const ExportRequestKind = enumSchema('ExportRequestKind', EXPORT_REQUEST_KINDS, 'ExportRequest.type: the export kinds of POST /exports (Milestone 1)');
export type ExportRequestKind = z.infer<typeof ExportRequestKind>;

/** `json`: Milestone 3 J.7, the format of a personal data export. */
export const EXPORT_FORMATS = ['pdf', 'xlsx', 'csv', 'json'] as const;
export const ExportFormat = enumSchema('ExportFormat', EXPORT_FORMATS, 'export_file.format (json: Milestone 3 J.7)');
export type ExportFormat = z.infer<typeof ExportFormat>;

/** The formats `POST /exports` accepts (Milestone 1). */
export const EXPORT_REQUEST_FORMATS = ['pdf', 'xlsx', 'csv'] as const satisfies readonly ExportFormat[];
export const ExportRequestFormat = enumSchema('ExportRequestFormat', EXPORT_REQUEST_FORMATS, 'ExportRequest.format: the formats of POST /exports (Milestone 1)');
export type ExportRequestFormat = z.infer<typeof ExportRequestFormat>;

export const SELF_ASSESSMENT_STATUSES = ['not_assessed', 'conforming', 'gap', 'not_applicable'] as const;
export const SelfAssessmentStatus = enumSchema('SelfAssessmentStatus', SELF_ASSESSMENT_STATUSES, 'self_assessment.status (C.13)');
export type SelfAssessmentStatus = z.infer<typeof SelfAssessmentStatus>;

export const AUDIT_ACTIVITY_STATUSES = ['planned', 'done', 'cancelled'] as const;
export const AuditActivityStatus = enumSchema('AuditActivityStatus', AUDIT_ACTIVITY_STATUSES, 'audit_activity.status');
export type AuditActivityStatus = z.infer<typeof AuditActivityStatus>;

/**
 * `acknowledgement`, `access_review`, `privacy_check`: Milestone 3 J.7, stored tasks that are completed on their own
 * screen and never with "Mark done" (D3-13, D.2 `tasks.complete`).
 */
export const TASK_SOURCE_RULES = ['BR-10', 'BR-11', 'BR-15', 'BR-31', 'manual', 'acknowledgement', 'access_review', 'privacy_check'] as const;
export const TaskSourceRule = enumSchema('TaskSourceRule', TASK_SOURCE_RULES, 'task.source_rule (D-29, Milestone 3 J.7)');
export type TaskSourceRule = z.infer<typeof TaskSourceRule>;

export const TASK_STATUSES = ['open', 'done', 'cancelled'] as const;
export const TaskStatus = enumSchema('TaskStatus', TASK_STATUSES, 'task.status');
export type TaskStatus = z.infer<typeof TaskStatus>;

/** Notification kinds of E.6 (`notification.kind`, `varchar(40)` without a CHECK constraint). */
export const NOTIFICATION_KINDS = [
  'reminder', 'freshness_downgrade', 'evidence_aging', 'evidence_anomaly', 'document_new_version', 'document_review_due',
  'document_expired', 'task_overdue', 'finding_overdue', 'prep_task_assigned', 'audit_date_changed', 'drift_detected',
  'connector_revoked', 'credential_expiring', 'licence_state', 'licence_expiring', 'edition_withdrawn', 'move_request',
  'role_grant_pending', 'export_ready', 'evidence_pack_ready', 'account', 'security',
  // Milestone 2 J.4
  'membership_invited', 'certificate_expiring', 'import_finished', 'pack_content_updated', 'organization_status_changed',
  // Milestone 3 J.4
  'organization_export_requested', 'organization_export_ready', 'organization_lifecycle', 'privacy_request_received', 'privacy_request_due',
  'privacy_check_requested', 'acknowledgement_requested', 'acknowledgement_overdue', 'retention_review_due', 'disposal_approval_pending',
  'access_review_due', 'access_review_overdue',
] as const;
export const NotificationKind = enumSchema('NotificationKind', NOTIFICATION_KINDS, 'notification.kind (E.6, Milestone 2 J.4, Milestone 3 J.4)');
export type NotificationKind = z.infer<typeof NotificationKind>;

// ---------------------------------------------------------------------------------------------------------------
// UI codes on the wire of /ui/* (C.11, C.12, UI 4.2)
// ---------------------------------------------------------------------------------------------------------------

/** Requirement status codes of the UI (C.11); `blocked` is derived from `holds_gate`, never stored (A.4 5.2). */
export const REQ_STATUSES = ['implemented', 'partial', 'planned', 'ns', 'blocked', 'na', 'complete'] as const;
export const ReqStatus = enumSchema('ReqStatus', REQ_STATUSES, 'UI requirement status code (C.11)');
export type ReqStatus = z.infer<typeof ReqStatus>;

export const DOC_STATUSES = ['approved', 'expired', 'review', 'draft'] as const;
export const DocStatus = enumSchema('DocStatus', DOC_STATUSES, 'UI document status code (C.11)');
export type DocStatus = z.infer<typeof DocStatus>;

/** Activity status codes of the UI (C.11); `locked` is derived (D-13). */
export const ACT_STATUSES = ['verified', 'complete', 'progress', 'blocked', 'ns', 'locked'] as const;
export const ActStatus = enumSchema('ActStatus', ACT_STATUSES, 'UI activity status code (C.11)');
export type ActStatus = z.infer<typeof ActStatus>;

/** Three-state code of preparation tasks and cycle items in the UI tuples (C.11, UI 1.10). */
export const TUPLE_STATUSES = ['done', 'progress', 'open'] as const;
export const TupleStatus = enumSchema('TupleStatus', TUPLE_STATUSES, 'UI code of PREP and CYCLE_ITEMS tuples (C.11)');
export type TupleStatus = z.infer<typeof TupleStatus>;

export const FINDING_CLASS_LABELS = ['Major', 'Minor', 'OFI'] as const;
export const FindingClassLabel = enumSchema('FindingClassLabel', FINDING_CLASS_LABELS, 'UI finding classification in PAST tuples (C.11)');
export type FindingClassLabel = z.infer<typeof FindingClassLabel>;

export const OPEN_CLOSED = ['open', 'closed'] as const;
export const OpenClosed = enumSchema('OpenClosed', OPEN_CLOSED, 'UI finding state in PAST tuples (C.11)');
export type OpenClosed = z.infer<typeof OpenClosed>;

export const ITEM_STATUSES = ['pending', 'overdue', 'missing'] as const;
export const ItemStatus = enumSchema('ItemStatus', ITEM_STATUSES, 'UI chain item status (D-12, C.11)');
export type ItemStatus = z.infer<typeof ItemStatus>;

export const REPO_STATUSES = ['ok', 'warn', 'bad'] as const;
export const RepoStatus = enumSchema('RepoStatus', REPO_STATUSES, 'UI repository status (C.11)');
export type RepoStatus = z.infer<typeof RepoStatus>;

export const INTEG_IDS = ['ok', 'nohash', 'pending', 'changed', 'moved', 'missing', 'revoked'] as const;
export const IntegId = enumSchema('IntegId', INTEG_IDS, 'UI integrity code (C.12)');
export type IntegId = z.infer<typeof IntegId>;

/** Integrity codes the UI lists as "cannot be verified" (A.4 5.3, C.12). */
export const UNVERIFIABLE_INTEG_IDS = ['changed', 'moved', 'missing', 'revoked'] as const satisfies readonly IntegId[];

/** Repository kinds of `LOC[slug][1]` (G.5); the web adds colour and icon by kind. */
export const LOC_KINDS = ['sp', 'od', 'gd', 'vault', 'smb'] as const;
export const LocKind = enumSchema('LocKind', LOC_KINDS, 'UI repository kind of LOC entries (G.5)');
export type LocKind = z.infer<typeof LocKind>;

/** Kinds of `RecordKey` (`<ms>:<kind>:<business id>`, UI 0, G.5); `task` keys address stored tasks (D-29). */
export const RECORD_KEY_KINDS = ['req', 'soa', 'doc', 'ev', 'x', 'act', 'drift', 'prep', 'cycle', 'task'] as const;
export const RecordKeyKind = enumSchema('RecordKeyKind', RECORD_KEY_KINDS, 'Kind segment of a RecordKey (G.5)');
export type RecordKeyKind = z.infer<typeof RecordKeyKind>;

export const CHAIN_ITEM_KINDS = ['req', 'soa', 'doc', 'ev', 'x'] as const;
export const ChainItemKind = enumSchema('ChainItemKind', CHAIN_ITEM_KINDS, 'UI chain item kind (UI 2.3)');
export type ChainItemKind = z.infer<typeof ChainItemKind>;

/** `TaskList` item kinds: chain item kinds plus `task` for stored tasks (D.2, D-29). */
export const TASK_ITEM_KINDS = ['req', 'soa', 'doc', 'ev', 'x', 'task'] as const;
export const TaskItemKind = enumSchema('TaskItemKind', TASK_ITEM_KINDS, 'TaskList item kind (D.2)');
export type TaskItemKind = z.infer<typeof TaskItemKind>;

export const STAGE_SRCS = ['req', 'soa', 'doc', 'ev'] as const;
export const StageSrc = enumSchema('StageSrc', STAGE_SRCS, 'UI chain stage source; absent for entity stages (G.5)');
export type StageSrc = z.infer<typeof StageSrc>;

export const DRIFT_SRCS = ['unverif', 'metric', 'exercise', 'nohash'] as const;
export const DriftSrc = enumSchema('DriftSrc', DRIFT_SRCS, 'UI drift pattern with live rows (G.5)');
export type DriftSrc = z.infer<typeof DriftSrc>;

/** UI roles (UI 1.4): the persona a screen is rendered for. */
export const UI_ROLES = ['manager', 'owner', 'auditor', 'top'] as const;
export const UiRole = enumSchema('UiRole', UI_ROLES, 'UI role per management system (F.7)');
export type UiRole = z.infer<typeof UiRole>;

/** Labels of the UI roles, as the sample `ROLES` shows them (G.5 `ROLES`). */
export const UI_ROLE_LABELS: Readonly<Record<UiRole, readonly [string, string]>> = {
  manager: ['Management System Manager', 'Management System Manager'],
  owner: ['Domain Owner', 'Pemilik Domain'],
  auditor: ['Internal Auditor', 'Auditor Internal'],
  top: ['Top Management', 'Manajemen Puncak'],
};

/** Frequency codes of the sample and the development packs (UI 1.16). Frequencies are pack data (A-43). */
export const FREQUENCY_CODES = ['daily', 'weekly', 'monthly', 'quarterly', 'semi', 'annual', 'event'] as const;

// ---------------------------------------------------------------------------------------------------------------
// Authorisation (F.6, F.7)
// ---------------------------------------------------------------------------------------------------------------

/** Permission codes of the F.6 matrix, in the order of the matrix. */
export const PERMISSIONS = [
  'ms.read',
  'applicability.complete', 'applicability.verify', 'applicability.manage',
  'activity.transition', 'activity.verify', 'phase.verify',
  'record.assign', 'record.complete_action', 'record.delete',
  'document.review', 'document.approve', 'document.manage', 'document.version.create',
  'evidence.file.submit', 'evidence.manage',
  'register.manage', 'metric.record',
  'risk.manage', 'risk.treatment.update', 'risk.residual.accept',
  'entity_link.manage', 'ms.transition', 'reminder.send',
  'audit.pending.all', 'audit.pending.aggregate', 'audit_event.manage',
  'prep_task.update', 'cycle_item.update',
  'finding.raise', 'finding.manage',
  'corrective_action.manage', 'corrective_action.update', 'corrective_action.verify',
  'self_assessment.manage', 'management_review.manage',
  'evidence_pack.build', 'auditor_access.grant', 'export.run', 'link_health.run',
  'storage.move.request', 'storage.object.read', 'audit_trail.read',
  'storage.repository.read', 'storage.repository.manage', 'storage.repository.test', 'storage.routing.manage',
  'storage.object.metadata.read',
  'pack.read', 'pack.activate', 'pack.install',
  'license.read', 'license.manage',
  'user.manage', 'idp.manage', 'org.settings.manage', 'ms.admin',
  'audit_trail.metadata.read',
  'ops.read', 'ops.jobs.run', 'ops.users.manage',
  // Milestone 2 J.2
  'internal_audit.manage', 'ops.tenants.manage', 'ops.entitlements.manage',
  // Milestone 3 J.2
  'org.export.manage', 'privacy_request.manage', 'privacy_request.assist', 'acknowledgement.manage', 'retention.manage', 'retention.approve',
  'access_review.manage', 'access_review.decide',
] as const;
export const Permission = enumSchema('Permission', PERMISSIONS, 'Permission code (F.6, Milestone 2 J.2, Milestone 3 J.2)');
export type Permission = z.infer<typeof Permission>;

export const PERMISSION_SCOPES = ['ms', 'org', 'platform'] as const;
export const PermissionScope = enumSchema('PermissionScope', PERMISSION_SCOPES, 'Where a permission is checked (D.1 RouteDef.scope, F.6)');
export type PermissionScope = z.infer<typeof PermissionScope>;

export const TENANCY_MODES = ['single', 'multi'] as const;
export const TenancyMode = enumSchema('TenancyMode', TENANCY_MODES, 'Profile key tenancy.mode (I.1)');
export type TenancyMode = z.infer<typeof TenancyMode>;

// ---------------------------------------------------------------------------------------------------------------
// Errors and rules (D.1, D.5)
// ---------------------------------------------------------------------------------------------------------------

/** Base URI of every problem `type` (D.1): `<base><slug>`. */
export const PROBLEM_TYPE_BASE = 'https://mscd.cyberlentera.com/problems/';

/** Problem slugs of the api (D.1). */
export const PROBLEM_SLUGS = [
  'validation', 'unauthenticated', 'csrf', 'forbidden', 'read-only-mode', 'organisation-inactive', 'not-found',
  'transition-not-allowed', 'confirmation-required', 'reauth-required', 'conflict', 'precondition-failed',
  'payload-too-large', 'business-rule', 'rate-limited', 'dependency-unavailable', 'internal',
  // Milestone 2 J.6: a route stub whose building package has not landed yet.
  'not-implemented',
] as const;
export const ProblemSlug = enumSchema('ProblemSlug', PROBLEM_SLUGS, 'Problem slug of the api (D.1, Milestone 2 J.6)');
export type ProblemSlug = z.infer<typeof ProblemSlug>;

/** HTTP status of every problem slug (D.1). */
export const PROBLEM_STATUS: Readonly<Record<ProblemSlug, number>> = {
  'validation': 400,
  'unauthenticated': 401,
  'csrf': 403,
  'forbidden': 403,
  'read-only-mode': 403,
  'organisation-inactive': 403,
  'not-found': 404,
  'transition-not-allowed': 409,
  'confirmation-required': 409,
  'reauth-required': 409,
  'conflict': 409,
  'precondition-failed': 412,
  'payload-too-large': 413,
  'business-rule': 422,
  'rate-limited': 429,
  'dependency-unavailable': 503,
  'internal': 500,
  'not-implemented': 501,
};

/** The problem `type` URI of a slug (D.1). */
export function problemType(slug: ProblemSlug | GatewayProblemSlug): string {
  return PROBLEM_TYPE_BASE + slug;
}

/** Problem slugs of the storage gateway (D.5). */
export const GATEWAY_PROBLEM_SLUGS = [
  'bad-request', 'not-found', 'forbidden', 'outside-root', 'unreachable', 'rate-limited', 'unsupported', 'too-large', 'internal',
] as const;
export const GatewayProblemSlug = enumSchema('GatewayProblemSlug', GATEWAY_PROBLEM_SLUGS, 'Problem slug of the storage gateway (D.5)');
export type GatewayProblemSlug = z.infer<typeof GatewayProblemSlug>;

/** Business rule ids BR-01 to BR-50 (digest 6.2 to 6.4). */
export const BUSINESS_RULE_IDS = [
  'BR-01', 'BR-02', 'BR-03', 'BR-04', 'BR-05', 'BR-06', 'BR-07', 'BR-08', 'BR-09', 'BR-10',
  'BR-11', 'BR-12', 'BR-13', 'BR-14', 'BR-15', 'BR-16', 'BR-17', 'BR-18', 'BR-19', 'BR-20',
  'BR-21', 'BR-22', 'BR-23', 'BR-24', 'BR-25', 'BR-26', 'BR-27', 'BR-28', 'BR-29', 'BR-30',
  'BR-31', 'BR-32', 'BR-33', 'BR-34', 'BR-35', 'BR-36', 'BR-37', 'BR-38', 'BR-39', 'BR-40',
  'BR-41', 'BR-42', 'BR-43', 'BR-44', 'BR-45', 'BR-46', 'BR-47', 'BR-48', 'BR-49', 'BR-50',
] as const;
export const BusinessRuleId = enumSchema('BusinessRuleId', BUSINESS_RULE_IDS, 'Business rule id (digest 6.2 to 6.4)');
export type BusinessRuleId = z.infer<typeof BusinessRuleId>;

/**
 * Rule ids of the problem `rule` member besides the business rules (D.1), then the platform rule ids of Milestone 2
 * (J.6): `APPL-ASSESS` (a clause row can never be marked not applicable) and `PACK-ROW-REMOVED` (a pack version drops
 * a code without marking it retired), then those of Milestone 3 (J.6): `ACK-OPEN-FIRST` (a policy is opened before it
 * is confirmed), `RET-HOLD`, `RET-NOT-DUE` and `RET-CURRENT` (a disposal of an item under a hold, before its period
 * ends, or of a current item), `SOD-SELF-APPROVE` (a person approves what they asked for), `REVIEW-OWN-ACCESS`
 * (a person decides on their own access) and `ERASE-OPEN-ITEMS` (an erasure while the person holds open items).
 */
export const PLATFORM_RULE_IDS = [
  'LIC-USERS', 'LIC-MS', 'LIC-FEATURE', 'LIC-BINDING', 'VERIFY-SELF', 'NOT-A-MEMBER', 'SOD-SELF-GRANT',
  'APPL-ASSESS', 'PACK-ROW-REMOVED',
  'ACK-OPEN-FIRST', 'RET-HOLD', 'RET-NOT-DUE', 'RET-CURRENT', 'SOD-SELF-APPROVE', 'REVIEW-OWN-ACCESS', 'ERASE-OPEN-ITEMS',
] as const;

/**
 * Warning rule ids that are not business rules: `AUD-INDEP`, auditor independence (Milestone 2 J.6), and
 * `REVIEW-SINGLE-ADMIN`, an access review that completes with the single Tenant Admin's own items not reviewed
 * (Milestone 3 J.6).
 */
export const PLATFORM_WARNING_RULE_IDS = ['AUD-INDEP', 'REVIEW-SINGLE-ADMIN'] as const;

export const RULE_IDS = [...BUSINESS_RULE_IDS, ...PLATFORM_RULE_IDS, ...PLATFORM_WARNING_RULE_IDS] as const;
export const RuleId = enumSchema('RuleId', RULE_IDS, 'Rule id of a problem or warning (D.1, Milestone 2 J.6, Milestone 3 J.6)');
export type RuleId = z.infer<typeof RuleId>;

/** Warn-and-allow rules: the command succeeds with `warnings` (D.1, Milestone 2 J.6, Milestone 3 J.6). */
export const WARNING_RULE_IDS = [
  'BR-03', 'BR-17', 'BR-23', 'BR-30', 'BR-32', 'BR-36', 'BR-41', 'BR-47', ...PLATFORM_WARNING_RULE_IDS,
] as const satisfies readonly RuleId[];

/** Rules that answer 409 `confirmation-required` until the request carries `confirm: true` (D.1). */
export const CONFIRMATION_RULE_IDS = ['BR-22', 'BR-38'] as const satisfies readonly RuleId[];

// ---------------------------------------------------------------------------------------------------------------
// Licence features (D-15)
// ---------------------------------------------------------------------------------------------------------------

export const LICENCE_FEATURES = ['integrated_mode', 'edition_transition', 'link_health_monitor', 'auditor_guest_access'] as const;
export const LicenceFeature = enumSchema('LicenceFeature', LICENCE_FEATURES, 'Licensable feature checked by LicenceGate.assertFeature (D-15)');
export type LicenceFeature = z.infer<typeof LicenceFeature>;

// ---------------------------------------------------------------------------------------------------------------
// Jobs (E.2) and audit actions (F.11)
// ---------------------------------------------------------------------------------------------------------------

export const JOB_NAMES = [
  'scheduler.tick', 'freshness.recompute', 'freshness.sweep', 'tasks.overdue', 'documents.review-alerts',
  'audit-prep.generate', 'license.check', 'packs.lifecycle', 'edition.withdrawn-alerts', 'link-health.plan',
  'link-health.check', 'link-health.repository', 'drift.evaluate', 'integrity.rehash', 'cycle.derive',
  'notifications.dispatch', 'notifications.digest', 'evidence-pack.build', 'export.build', 'pack.install',
  'audit.verify-chain', 'cleanup.expired',
  // Milestone 2 J.3
  'readiness.recompute', 'certificate.expiry', 'import.run', 'applicability.sync', 'entitlement.expiry', 'domain.verify',
  // Milestone 3 J.3
  'org-export.build', 'org.lifecycle', 'org.purge', 'privacy.deadlines', 'acknowledgement.reminders', 'retention.review', 'access-review.open',
] as const;
export const JobName = enumSchema('JobName', JOB_NAMES, 'Worker job name (E.2, Milestone 2 J.3, Milestone 3 J.3)');
export type JobName = z.infer<typeof JobName>;

/** Jobs an operator may start with `POST /ops/jobs/{name}/run` (D.3 Operations); `org.lifecycle` joins in Milestone 3 (D.2). */
export const OPS_RUNNABLE_JOBS = [
  'freshness.sweep', 'link-health.plan', 'link-health.repository', 'audit.verify-chain', 'cleanup.expired',
  'notifications.dispatch', 'packs.lifecycle', 'drift.evaluate', 'cycle.derive',
  'org.lifecycle',
] as const satisfies readonly JobName[];
export const OpsRunnableJob = enumSchema('OpsRunnableJob', OPS_RUNNABLE_JOBS, 'Job name accepted by POST /ops/jobs/{name}/run');
export type OpsRunnableJob = z.infer<typeof OpsRunnableJob>;

/** Audit trail actions (F.11). */
export const AUDIT_ACTIONS = [
  'auth.login', 'auth.login_failed', 'auth.logout', 'auth.mfa_enrolled', 'auth.mfa_failed', 'auth.mfa_locked',
  'auth.mfa_reset', 'auth.recovery_code_used', 'auth.password_reset', 'auth.password_changed', 'auth.session_revoked',
  'auth.persona_switch', 'auth.org_switched', 'auth.guest_code_sent', 'auth.guest_login',
  'identity.linked', 'identity.registered', 'idp.created', 'idp.updated', 'idp.deleted',
  'user.invited', 'user.created', 'user.updated', 'membership.updated', 'org.settings_updated',
  'role.granted', 'role.grant_requested', 'role.grant_approved', 'role.grant_rejected', 'role.revoked',
  'tenant.created', 'tenant.domain_verified',
  'licence.installed', 'licence.rejected', 'licence.state_changed', 'licence.clock_rollback',
  'pack.installed', 'pack.install_failed', 'pack.rejected',
  'ms.created', 'ms.updated', 'ms.transition',
  'applicability.created', 'applicability.updated', 'applicability.transition', 'activity.transition', 'phase.verified',
  'record.assigned', 'record.action_completed', 'record.deleted',
  'register.created', 'register.updated', 'risk.treatment_transition', 'risk.residual_accepted', 'metric.value_recorded',
  'evidence.created', 'evidence.updated', 'evidence.target_added', 'evidence.target_removed',
  'entity_link.created', 'entity_link.removed',
  'finding.created', 'finding.updated', 'finding.transition', 'corrective_action.created', 'corrective_action.transition',
  'self_assessment.updated', 'audit_activity.updated',
  'management_review.created', 'management_review.input_updated', 'management_review.transition',
  'document.created', 'document.updated', 'document.transition', 'document.version_created',
  'evidence.file_linked', 'evidence.file_uploaded', 'file.opened', 'file.downloaded',
  'reminder.sent', 'task.completed', 'audit_event.created', 'audit_event.updated', 'prep_task.updated', 'cycle_item.updated',
  'storage.repository.created', 'storage.repository.updated', 'storage.credential.set', 'storage.credential.revoked',
  'storage.routing.requested', 'storage.routing.approved', 'storage.routing.rejected', 'storage.move_requested',
  'link_status.changed', 'freshness.downgrade', 'evidence_pack.built', 'evidence_pack.downloaded',
  'export.created', 'export.downloaded', 'calendar_feed.created', 'calendar_feed.revoked',
  'auditor_access.granted', 'auditor_access.revoked', 'auditor.read', 'authz.denied',
  'ops.job_run', 'ops.diagnostics_exported',
  // Milestone 2 J.5
  'ms.certified', 'certification_cycle.created', 'certification_cycle.expired', 'certification_cycle.closed',
  'certification_cycle.transitioned', 'org.updated', 'freshness_threshold.changed', 'auth.recovery_codes_regenerated',
  'membership.declined', 'holdings.reassigned', 'import.validated', 'import.committed', 'ops.organization_created',
  'ops.operator_created', 'ops.operator_revoked', 'applicability.seeded', 'pack.content_synced', 'document_code.linked',
  // Milestone 2 J.5, SaaS track
  'ops.organization_status_changed', 'ops.domain_added', 'ops.domain_verified', 'ops.domain_verification_failed',
  'ops.domain_removed', 'ops.entitlements_changed',
  // Milestone 2 D.1 management review PATCH (M2-07, orchestrator decision)
  'management_review.updated',
  // Milestone 3 J.5, tenant audit trail
  'organization_export.requested', 'organization_export.decided', 'organization_export.built', 'organization_export.failed',
  'organization_export.downloaded', 'privacy_request.created', 'privacy_request.updated', 'privacy_request.rectified',
  'privacy_request.restricted', 'privacy_request.erased', 'privacy_request.closed', 'privacy_check.done', 'privacy.audit_redacted',
  'acknowledgement_request.created', 'acknowledgement_request.reminded', 'acknowledgement_request.closed', 'acknowledgement.opened',
  'acknowledgement.confirmed', 'retention_rule.changed', 'retention_review.decided', 'retention_review.approved', 'retention_review.rejected',
  'retention_review.file_removed', 'retention_hold.created', 'retention_hold.released', 'record.disposed', 'access_review.settings_changed',
  'access_review.opened', 'access_review.item_decided', 'access_review.item_applied', 'access_review.signed_off', 'access_review.completed',
  'access_review.cancelled',
  // Milestone 3 J.5, platform audit log
  'ops.export_requested', 'ops.deletion_scheduled', 'ops.deletion_cancelled', 'ops.deletion_retried', 'tenant.offboarding_ended',
  'tenant.purge_started', 'tenant.purged', 'tenant.purge_failed', 'tenant.audit_redacted', 'user.anonymised', 'user.audit_redacted',
  'identity.unlinked',
] as const;
export const AuditAction = enumSchema('AuditAction', AUDIT_ACTIONS, 'Audit trail action (F.11, Milestone 2 J.5, Milestone 3 J.5)');
export type AuditAction = z.infer<typeof AuditAction>;

/** Action prefixes written to `platform.audit_log`; every other action goes to the tenant `audit_trail` (F.11). */
export const PLATFORM_AUDIT_ACTION_PREFIXES = ['auth.', 'identity.', 'idp.', 'user.', 'membership.', 'tenant.', 'licence.', 'pack.', 'ops.'] as const;

/** True when the action is written to `platform.audit_log` (F.11). */
export function isPlatformAuditAction(action: AuditAction): boolean {
  return PLATFORM_AUDIT_ACTION_PREFIXES.some((prefix) => action.startsWith(prefix));
}
