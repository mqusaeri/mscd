// State machines of build plan C.13 as transition tables. A command looks up the rows its route performs for the
// `(from, to)` pair (`transitionsVia`); a pair without a row answers 409 `transition-not-allowed`, or 422 with the rule
// of a `rejections` entry of the same route (`rejectionFor`; D.3 answers 422 BR-04 when a treatment is closed without
// residual acceptance, or when residual acceptance meets a treatment that is not `implemented`). Several rows for one
// pair are alternatives: the actor needs the permission of one of them (for example `activity.transition` on an own
// record, or `activity.verify`). A row or rejection with `via` belongs to that dedicated route only; the machine's
// transition route performs the rows without `via`. A row with `permission: null` is performed by the system only
// (jobs). The RBAC suite and the contract tests read the same tables (J.5). Milestone 2 (docs/platform/MILESTONE-2.md
// J.8) adds the certification cycle and organisation status machines and moves the first certification of a system to
// `ms.certification` (D.2). Milestone 3 (docs/platform/MILESTONE-3.md J.8, M3-01) replaces the organisation status
// machine with the lifecycle of D.5 and adds the machines of organisation exports, organisation deletions, requests
// from one person, disposal reviews and access reviews.
import {
  ACCESS_REVIEW_STATUSES, ACTIVITY_STATUSES, APPROVAL_STATUSES, CERTIFICATION_CYCLE_STATUSES, CORRECTIVE_ACTION_STATUSES, DOCUMENT_STATUSES,
  FINDING_STATUSES, IMPLEMENTATION_STATUSES, MANAGEMENT_REVIEW_STATUSES, MS_STATUSES, ORGANIZATION_DELETION_STATUSES,
  ORGANIZATION_EXPORT_STATUSES, ORGANIZATION_STATUSES, PRIVACY_REQUEST_STATUSES, RETENTION_REVIEW_STATUSES, SELF_ASSESSMENT_STATUSES,
  TASK_PROGRESS_STATUSES, TREATMENT_STATUSES,
} from './enums.js';
import type { Permission, RuleId } from './enums.js';
import type { WorkPackageId } from './api/common.js';

export const MACHINE_ENTITIES = [
  'applicability_entry.implementation_status',
  'implementation_activity_progress.status',
  'document.status',
  'risk_treatment.status',
  'finding.status',
  'corrective_action.status',
  'management_review.status',
  'self_assessment.status',
  'audit_prep_task.status',
  'cycle_requirement_status.status',
  'user_ms_role.approval_status',
  'management_system.status',
  // Milestone 2 J.8
  'certification_cycle.status',
  'organization.status',
  // Milestone 3 J.8
  'organization_export.status',
  'organization_deletion.status',
  'privacy_request.status',
  'retention_review.status',
  'access_review.status',
] as const;
export type MachineEntity = (typeof MACHINE_ENTITIES)[number];

/** One row of a transition table (C.13). */
export interface Transition {
  entity: MachineEntity;
  /** Current state; null when the record is created in `to`. */
  from: string | null;
  to: string;
  /** Permission the actor needs (F.6); null when only the system performs the transition. */
  permission: Permission | null;
  /** Permissions the actor needs besides `permission` (D.3 "A and B"); the `via` route lists the same in `allOf`. */
  allOf?: readonly Permission[];
  /** An own-scoped grant of the permission is enough when the actor owns or holds the record (D.3 "(own)"). */
  own?: boolean;
  /** Rules evaluated on the transition. */
  rules: readonly RuleId[];
  /** Columns the transition sets besides the status. */
  sets: readonly string[];
  /** Request members that must be present (for example a note or a justification). */
  requires?: readonly string[];
  /** Route id when the transition is only reachable through a dedicated route. */
  via?: string;
  note?: string;
}

/**
 * A pair that has no transition row on a route and that the route's command rejects with a business rule (422
 * `business-rule`) instead of 409 `transition-not-allowed`, because D.3 names the rule for it. Not a transition: no
 * role may perform it.
 */
export interface Rejection {
  entity: MachineEntity;
  from: string;
  to: string;
  rule: RuleId;
  /** Route id when the rejection belongs to a dedicated route; absent for the machine's transition route. */
  via?: string;
  note: string;
}

/** A machine: its states, its owner work package, its rows and the pairs rejected with a rule. */
export interface Machine {
  entity: MachineEntity;
  owner: WorkPackageId;
  states: readonly string[];
  transitions: readonly Transition[];
  rejections: readonly Rejection[];
}

interface RowOptions {
  own?: boolean;
  allOf?: readonly Permission[];
  rules?: readonly RuleId[];
  sets?: readonly string[];
  requires?: readonly string[];
  via?: string;
  note?: string;
}

/** Builds rows from one or more source states to one target state. */
function rows<S extends string>(
  entity: MachineEntity,
  from: S | null | readonly (S | null)[],
  to: S,
  permission: Permission | null,
  options: RowOptions = {},
): Transition[] {
  const sources = Array.isArray(from) ? (from as readonly (S | null)[]) : [from as S | null];
  return sources.map((source) => ({
    entity,
    from: source,
    to,
    permission,
    ...(options.allOf ? { allOf: options.allOf } : {}),
    ...(options.own ? { own: true } : {}),
    rules: options.rules ?? [],
    sets: options.sets ?? [],
    ...(options.requires ? { requires: options.requires } : {}),
    ...(options.via ? { via: options.via } : {}),
    ...(options.note ? { note: options.note } : {}),
  }));
}

/** Builds rejections from one or more source states to one target state, on the transition route or `via` a dedicated one. */
function rejections<S extends string>(entity: MachineEntity, from: readonly S[], to: S, rule: RuleId, note: string, via?: string): Rejection[] {
  return from.map((source) => ({ entity, from: source, to, rule, ...(via ? { via } : {}), note }));
}

type ImplementationState = (typeof IMPLEMENTATION_STATUSES)[number];
const APPLICABILITY = 'applicability_entry.implementation_status' as const;
const applicability: Machine = {
  entity: APPLICABILITY,
  owner: 'WP-20',
  states: IMPLEMENTATION_STATUSES,
  transitions: [
    ...rows<ImplementationState>(APPLICABILITY, null, 'not_started', 'applicability.manage'),
    ...rows<ImplementationState>(APPLICABILITY, 'not_started', 'planned', 'applicability.manage'),
    ...rows<ImplementationState>(APPLICABILITY, ['not_started', 'planned', 'partially_implemented'], 'complete', 'applicability.complete', {
      own: true, sets: ['completed_by_user_id', 'completed_at'],
    }),
    ...rows<ImplementationState>(APPLICABILITY, 'planned', 'partially_implemented', 'applicability.complete', { own: true }),
    ...rows<ImplementationState>(APPLICABILITY, 'complete', 'implemented', 'applicability.verify', {
      rules: ['BR-01', 'VERIFY-SELF'], sets: ['verified_by_user_id', 'verified_at'],
    }),
    ...rows<ImplementationState>(APPLICABILITY, 'complete', 'partially_implemented', 'applicability.verify', { note: 'Rejection of a completed entry' }),
    ...rows<ImplementationState>(APPLICABILITY, 'partially_implemented', 'implemented', 'applicability.verify', {
      rules: ['BR-01', 'VERIFY-SELF'], sets: ['verified_by_user_id', 'verified_at'],
      note: 'VERIFY-SELF applies to every requirement verification (A.4 5.4)',
    }),
    ...rows<ImplementationState>(APPLICABILITY, [null, 'not_started', 'planned', 'partially_implemented', 'complete', 'implemented'], 'not_applicable', 'applicability.manage', {
      requires: ['exclusionJustification'],
    }),
    ...rows<ImplementationState>(APPLICABILITY, 'implemented', 'partially_implemented', null, {
      rules: ['BR-11', 'BR-31'], note: 'Automatic downgrade by freshness.recompute when no valid evidence keeps the entry implemented (E.3, TS 6.1)',
    }),
  ],
  rejections: [],
};

type ActivityState = (typeof ACTIVITY_STATUSES)[number];
const ACTIVITY = 'implementation_activity_progress.status' as const;
const activity: Machine = {
  entity: ACTIVITY,
  owner: 'WP-20',
  states: ACTIVITY_STATUSES,
  transitions: [
    ...rows<ActivityState>(ACTIVITY, 'not_started', 'in_progress', 'activity.transition', { own: true, rules: ['BR-12'] }),
    ...rows<ActivityState>(ACTIVITY, 'not_started', 'complete', 'activity.transition', {
      own: true, rules: ['BR-12', 'BR-40'], sets: ['completed_by_user_id', 'completed_at'],
      note: 'Two steps in one command (A.4 5.12): not_started to in_progress (BR-12, the checkpoint lock) then in_progress to complete (BR-40); two audit entries',
    }),
    ...rows<ActivityState>(ACTIVITY, 'in_progress', 'complete', 'activity.transition', {
      own: true, rules: ['BR-40'], sets: ['completed_by_user_id', 'completed_at'],
    }),
    ...rows<ActivityState>(ACTIVITY, 'complete', 'verified', 'activity.verify', {
      rules: ['VERIFY-SELF'], sets: ['verified_by_user_id', 'verified_at'],
      note: 'The verifier differs from the completer and the owner; another Management System Manager or a Programme Owner verifies when the Management System Manager owns the activity (A-48)',
    }),
    ...rows<ActivityState>(ACTIVITY, 'complete', 'in_progress', 'activity.verify', { requires: ['rejectReason'] }),
    ...rows<ActivityState>(ACTIVITY, ['not_started', 'in_progress', 'complete'], 'blocked', 'activity.transition', {
      own: true, rules: ['BR-39'], sets: ['blocker_gate_item_ref', 'blocker_reason'], requires: ['blockerGateItemRef', 'blockerReason'],
    }),
    ...rows<ActivityState>(ACTIVITY, ['not_started', 'in_progress', 'complete'], 'blocked', 'activity.verify', {
      rules: ['BR-39'], sets: ['blocker_gate_item_ref', 'blocker_reason'], requires: ['blockerGateItemRef', 'blockerReason'],
    }),
    ...rows<ActivityState>(ACTIVITY, 'blocked', 'in_progress', 'activity.transition', { own: true }),
  ],
  rejections: [],
};

type DocumentState = (typeof DOCUMENT_STATUSES)[number];
const DOCUMENT = 'document.status' as const;
const document: Machine = {
  entity: DOCUMENT,
  owner: 'WP-35',
  states: DOCUMENT_STATUSES,
  transitions: [
    ...rows<DocumentState>(DOCUMENT, ['draft', 'expired'], 'in_review', 'document.review', { own: true }),
    ...rows<DocumentState>(DOCUMENT, 'in_review', 'approved', 'document.approve', { rules: ['BR-16'] }),
    ...rows<DocumentState>(DOCUMENT, 'in_review', 'draft', 'document.approve', { requires: ['note'], note: 'Rejection of the version in review' }),
    ...rows<DocumentState>(DOCUMENT, 'approved', 'expired', null, { rules: ['BR-10'], note: 'tasks.overdue when next_review_at is past' }),
    ...rows<DocumentState>(DOCUMENT, ['draft', 'approved', 'expired'], 'in_review', 'document.version.create', {
      own: true, via: 'documents.versions',
      note: 'A new version puts the document in review (D.3; digest 5.10 "Upload new version (approved)"); a version already in review answers 409',
    }),
  ],
  rejections: [],
};

type TreatmentState = (typeof TREATMENT_STATUSES)[number];
const TREATMENT = 'risk_treatment.status' as const;
const treatment: Machine = {
  entity: TREATMENT,
  owner: 'WP-36',
  states: TREATMENT_STATUSES,
  transitions: [
    ...rows<TreatmentState>(TREATMENT, 'proposed', 'approved', 'risk.manage'),
    ...rows<TreatmentState>(TREATMENT, 'approved', 'in_progress', 'risk.treatment.update', { own: true }),
    ...rows<TreatmentState>(TREATMENT, 'in_progress', 'delayed', null, { note: 'Target date passed' }),
    ...rows<TreatmentState>(TREATMENT, 'in_progress', 'delayed', 'risk.treatment.update', { own: true }),
    ...rows<TreatmentState>(TREATMENT, 'delayed', 'in_progress', 'risk.treatment.update', { own: true }),
    ...rows<TreatmentState>(TREATMENT, ['in_progress', 'delayed'], 'implemented', 'risk.treatment.update', {
      own: true, sets: ['implemented_by_user_id', 'implemented_at'],
    }),
    ...rows<TreatmentState>(TREATMENT, 'implemented', 'residual_accepted', 'risk.residual.accept', {
      own: true, rules: ['BR-04'], via: 'risks.residual-acceptance',
      note: "Only through POST .../residual-acceptance by the risk's owner, never the implementer",
    }),
    ...rows<TreatmentState>(TREATMENT, 'residual_accepted', 'closed', 'risk.manage', { sets: ['closed_at'] }),
    ...rows<TreatmentState>(TREATMENT, ['approved', 'in_progress', 'delayed'], 'proposed', 'risk.manage', { note: 'Rework of an open treatment' }),
  ],
  rejections: [
    ...rejections<TreatmentState>(TREATMENT, ['proposed', 'approved', 'in_progress', 'delayed', 'implemented'], 'closed', 'BR-04',
      'Closing without residual acceptance (D.3 answers 422 BR-04); the risk owner accepts the residual risk first'),
    ...rejections<TreatmentState>(TREATMENT, ['proposed', 'approved', 'in_progress', 'delayed', 'residual_accepted', 'closed'], 'residual_accepted', 'BR-04',
      'Residual acceptance of a treatment that is not implemented (D.3 answers 422 BR-04)', 'risks.residual-acceptance'),
  ],
};

type FindingState = (typeof FINDING_STATUSES)[number];
const FINDING = 'finding.status' as const;
const finding: Machine = {
  entity: FINDING,
  owner: 'WP-37',
  states: FINDING_STATUSES,
  transitions: [
    ...rows<FindingState>(FINDING, 'open', 'in_progress', 'finding.manage'),
    ...rows<FindingState>(FINDING, ['open', 'in_progress'], 'closed', 'finding.manage', {
      rules: ['BR-06', 'BR-07', 'BR-08'], sets: ['closed_at', 'closed_by_user_id', 'close_note'],
      note: 'major: rca_text and systemic_check_text filled; major and minor: a linked corrective action closed with effective = true; ofi, signal and not_a_finding close with a close_note',
    }),
    ...rows<FindingState>(FINDING, 'closed', 'in_progress', 'finding.manage', { requires: ['note'], note: 'Reopen' }),
  ],
  rejections: [],
};

type CorrectiveActionState = (typeof CORRECTIVE_ACTION_STATUSES)[number];
const CORRECTIVE_ACTION = 'corrective_action.status' as const;
const CA_STEPS: readonly [CorrectiveActionState, CorrectiveActionState, string, string[]][] = [
  ['correction', 'rca', 'correction_text', ['correction_text']],
  ['rca', 'systemic_check', 'rca_text', ['rca_text']],
  ['systemic_check', 'action', 'systemic_check_text', ['systemic_check_text']],
  ['action', 'effectiveness_verification', 'action_text', ['action_text', 'implemented_by_user_id', 'implemented_at']],
];
const correctiveAction: Machine = {
  entity: CORRECTIVE_ACTION,
  owner: 'WP-37',
  states: CORRECTIVE_ACTION_STATUSES,
  transitions: [
    ...CA_STEPS.flatMap(([from, to, , sets]) => [
      ...rows<CorrectiveActionState>(CORRECTIVE_ACTION, from, to, 'corrective_action.update', { own: true, sets, requires: ['text'] }),
      ...rows<CorrectiveActionState>(CORRECTIVE_ACTION, from, to, 'corrective_action.manage', { sets, requires: ['text'] }),
    ]),
    ...rows<CorrectiveActionState>(CORRECTIVE_ACTION, 'effectiveness_verification', 'closed', 'corrective_action.verify', {
      rules: ['BR-09', 'BR-08'], sets: ['verified_by_user_id', 'verified_at', 'effective', 'verification_note'], requires: ['effective'],
      note: 'effective = true; the verifier differs from the implementer and the owner, on another day than the implementation',
    }),
    ...rows<CorrectiveActionState>(CORRECTIVE_ACTION, 'effectiveness_verification', 'action', 'corrective_action.verify', {
      rules: ['BR-09'], sets: ['verification_note'], requires: ['effective'], note: 'effective = false returns the action to the action step',
    }),
    ...rows<CorrectiveActionState>(CORRECTIVE_ACTION, ['correction', 'rca', 'systemic_check', 'action', 'effectiveness_verification'], 'cancelled', 'corrective_action.manage', {
      requires: ['note'],
    }),
  ],
  rejections: [],
};

type ManagementReviewState = (typeof MANAGEMENT_REVIEW_STATUSES)[number];
const MANAGEMENT_REVIEW = 'management_review.status' as const;
const managementReview: Machine = {
  entity: MANAGEMENT_REVIEW,
  owner: 'WP-37',
  states: MANAGEMENT_REVIEW_STATUSES,
  transitions: [
    ...rows<ManagementReviewState>(MANAGEMENT_REVIEW, 'planned', 'held', 'management_review.manage', { sets: ['held_at'] }),
    ...rows<ManagementReviewState>(MANAGEMENT_REVIEW, 'held', 'closed', 'management_review.manage', {
      rules: ['BR-13', 'BR-14'], sets: ['closed_at', 'closed_by_user_id', 'decisions_recorded', 'decisions_text'],
    }),
  ],
  rejections: [],
};

type SelfAssessmentState = (typeof SELF_ASSESSMENT_STATUSES)[number];
const SELF_ASSESSMENT = 'self_assessment.status' as const;
const selfAssessment: Machine = {
  entity: SELF_ASSESSMENT,
  owner: 'WP-37',
  states: SELF_ASSESSMENT_STATUSES,
  transitions: SELF_ASSESSMENT_STATUSES.flatMap((to) =>
    rows<SelfAssessmentState>(
      SELF_ASSESSMENT,
      [null, ...SELF_ASSESSMENT_STATUSES.filter((s) => s !== to)],
      to,
      'self_assessment.manage',
      to === 'gap' ? { requires: ['ownerHandle', 'targetFixAt'], sets: ['assessed_at'] } : { sets: ['assessed_at'] },
    ),
  ),
  rejections: [],
};

type ProgressState = (typeof TASK_PROGRESS_STATUSES)[number];
function progressMachine(entity: MachineEntity, permission: Permission): Machine {
  return {
    entity,
    owner: 'WP-35',
    states: TASK_PROGRESS_STATUSES,
    transitions: [
      ...rows<ProgressState>(entity, 'not_started', 'in_progress', permission, { own: true }),
      ...rows<ProgressState>(entity, 'in_progress', 'done', permission, { own: true }),
      ...rows<ProgressState>(entity, ['not_started', 'in_progress', 'done', 'overdue'], 'blocked', permission, { own: true, requires: ['note'] }),
      ...rows<ProgressState>(entity, 'blocked', 'in_progress', permission, { own: true }),
      ...rows<ProgressState>(entity, 'overdue', 'in_progress', permission, { own: true, note: 'A-23' }),
      ...rows<ProgressState>(entity, 'overdue', 'done', permission, { own: true, note: 'A-23' }),
      ...rows<ProgressState>(entity, ['not_started', 'in_progress'], 'overdue', null, { note: 'tasks.overdue when due_at is past (TS 6.7, 6.8)' }),
    ],
    rejections: [],
  };
}

type ApprovalState = (typeof APPROVAL_STATUSES)[number];
const ROLE_APPROVAL = 'user_ms_role.approval_status' as const;
const roleApproval: Machine = {
  entity: ROLE_APPROVAL,
  owner: 'WP-39',
  states: APPROVAL_STATUSES,
  transitions: [
    ...rows<ApprovalState>(ROLE_APPROVAL, 'pending_approval', 'active', 'user.manage', {
      rules: ['SOD-SELF-GRANT'], sets: ['approved_by'], note: 'The actor differs from requested_by and from the grantee',
    }),
    ...rows<ApprovalState>(ROLE_APPROVAL, 'pending_approval', 'rejected', 'user.manage', {
      rules: ['SOD-SELF-GRANT'], sets: ['approved_by'], note: 'The actor differs from requested_by and from the grantee',
    }),
  ],
  rejections: [],
};

type MsState = (typeof MS_STATUSES)[number];
const MANAGEMENT_SYSTEM = 'management_system.status' as const;
const managementSystem: Machine = {
  entity: MANAGEMENT_SYSTEM,
  owner: 'WP-12',
  states: MS_STATUSES,
  transitions: [
    ...rows<MsState>(MANAGEMENT_SYSTEM, null, 'setup', 'ms.admin', {
      allOf: ['pack.activate'], rules: ['BR-21', 'LIC-MS'], via: 'admin.ms.create', note: 'Creation needs ms.admin and pack.activate (D.3)',
    }),
    ...rows<MsState>(MANAGEMENT_SYSTEM, 'setup', 'implementing', 'ms.admin', {
      via: 'admin.ms.update', note: 'PATCH /admin/management-systems/{id} with status implementing',
    }),
    ...rows<MsState>(MANAGEMENT_SYSTEM, ['setup', 'implementing', 'certified', 'transitioning'], 'archived', 'ms.admin', {
      via: 'admin.ms.update', note: 'PATCH /admin/management-systems/{id} with status archived',
    }),
    ...rows<MsState>(MANAGEMENT_SYSTEM, 'certified', 'transitioning', 'ms.transition', {
      rules: ['LIC-FEATURE'], requires: ['targetEdition'], sets: ['transition_target_version_id'], note: 'Feature edition_transition',
    }),
    ...rows<MsState>(MANAGEMENT_SYSTEM, 'transitioning', 'certified', 'ms.transition', {
      rules: ['LIC-FEATURE'], note: 'After the transition audit recommended certification; feature edition_transition',
    }),
    ...rows<MsState>(MANAGEMENT_SYSTEM, 'implementing', 'certified', 'ms.transition', {
      via: 'ms.certification', requires: ['certificateNo', 'issuedAt', 'expiresAt', 'certificationBody'],
      note: 'Recording the first certificate after a Stage 2 audit with outcome recommended or recommended_with_conditions (Milestone 2 D.2, D.4)',
    }),
  ],
  rejections: [],
};

type CycleState = (typeof CERTIFICATION_CYCLE_STATUSES)[number];
const CYCLE = 'certification_cycle.status' as const;
const CYCLE_MOVE = { via: 'ms.cycles.transition', requires: ['reason'] } as const;
/** Milestone 2 J.8, D.4: one open cycle (`planned` or `active`) per system; a certified cycle stays while the next one runs. */
const certificationCycle: Machine = {
  entity: CYCLE,
  owner: 'M2-02',
  states: CERTIFICATION_CYCLE_STATUSES,
  transitions: [
    ...(['planned', 'active'] as const).flatMap((to) => rows<CycleState>(CYCLE, null, to, 'audit_event.manage', {
      via: 'ms.cycles.create', requires: ['cycleStart'], note: 'Start certification cycle on screen, with its cycle items (D.4)',
    })),
    ...rows<CycleState>(CYCLE, null, 'active', null, {
      sets: ['cycle_start', 'cycle_end'], note: 'The first stage1 or recertification audit event of a system without an open cycle (D.4)',
    }),
    ...rows<CycleState>(CYCLE, 'planned', 'active', null, { note: 'The first stage1 audit event activates a planned cycle and copies its cycle items (D.4)' }),
    ...rows<CycleState>(CYCLE, 'planned', 'active', 'audit_event.manage', { via: 'ms.cycles.create', note: 'Start certification cycle on a system with a planned cycle' }),
    ...rows<CycleState>(CYCLE, 'active', 'certified', 'ms.transition', {
      via: 'ms.certification', requires: ['certificateNo', 'issuedAt', 'expiresAt', 'certificationBody'],
      sets: ['certificate_no', 'certified_at', 'certificate_expires_at', 'certification_body', 'certified_scope'],
      note: 'Only after a stage2 or recertification event of the cycle with outcome recommended or recommended_with_conditions (D.4)',
    }),
    ...rows<CycleState>(CYCLE, 'certified', 'closed', null, { note: 'The next cycle of the system is certified (D.4 recertification)' }),
    ...rows<CycleState>(CYCLE, 'certified', 'expired', null, { note: 'certificate.expiry: certificate_expires_at has passed (D.4)' }),
    ...rows<CycleState>(CYCLE, 'certified', 'suspended', 'ms.transition', { ...CYCLE_MOVE, note: 'Suspension decided by the certification body' }),
    ...rows<CycleState>(CYCLE, 'suspended', 'certified', 'ms.transition', { ...CYCLE_MOVE, note: 'Reinstatement decided by the certification body' }),
    ...rows<CycleState>(CYCLE, 'suspended', 'withdrawn', 'ms.transition', { ...CYCLE_MOVE, note: 'Withdrawal decided by the certification body' }),
    ...rows<CycleState>(CYCLE, 'active', 'closed', 'ms.transition', { ...CYCLE_MOVE, note: 'An active cycle that will not reach certification' }),
  ],
  rejections: [],
};

type OrganizationState = (typeof ORGANIZATION_STATUSES)[number];
const ORGANIZATION = 'organization.status' as const;
/**
 * Milestone 3 J.8 (replaces the machine of Milestone 2 J.8, M2-02): the platform operator moves an organisation
 * through `ops.organizations.status` or `tenant set-status`; the system ends the read-only period, purges an archived
 * organisation on its date and archives an organisation again when a verified deletion certificate is re-applied after
 * a restore (D.5.1, D.5.6).
 */
const STATUS_MOVE = { via: 'ops.organizations.status', requires: ['reason'], note: 'Also the operator command tenant set-status' } as const;
const STATUS_MOVE_CONFIRMED = { ...STATUS_MOVE, requires: ['reason', 'confirmSlug'], note: 'confirmSlug equal to the slug; also the operator command tenant set-status' } as const;
const organization: Machine = {
  entity: ORGANIZATION,
  owner: 'M3-01',
  states: ORGANIZATION_STATUSES,
  transitions: [
    ...rows<OrganizationState>(ORGANIZATION, 'active', 'suspended', 'ops.tenants.manage', STATUS_MOVE),
    ...rows<OrganizationState>(ORGANIZATION, 'active', 'offboarding', 'ops.tenants.manage', {
      ...STATUS_MOVE_CONFIRMED, sets: ['offboarding_ends_at'],
      note: 'confirmSlug equal to the slug; also tenant set-status. Read-only for lifecycle.offboarding_days; queues the final export (D.4, D.5.1)',
    }),
    ...rows<OrganizationState>(ORGANIZATION, 'suspended', 'active', 'ops.tenants.manage', STATUS_MOVE),
    ...rows<OrganizationState>(ORGANIZATION, 'suspended', 'offboarding', 'ops.tenants.manage', {
      ...STATUS_MOVE_CONFIRMED, sets: ['offboarding_ends_at'],
      note: 'confirmSlug equal to the slug; also tenant set-status. Read-only for lifecycle.offboarding_days; queues the final export (D.4, D.5.1)',
    }),
    ...rows<OrganizationState>(ORGANIZATION, 'offboarding', 'active', 'ops.tenants.manage', STATUS_MOVE),
    ...rows<OrganizationState>(ORGANIZATION, 'offboarding', 'archived', 'ops.tenants.manage', {
      ...STATUS_MOVE_CONFIRMED, note: 'confirmSlug equal to the slug; also tenant set-status. Ends every session and schedules the deletion (D.5.1)',
    }),
    ...rows<OrganizationState>(ORGANIZATION, 'offboarding', 'archived', null, {
      note: 'org.lifecycle when offboarding_ends_at has passed (D.5.1); also tenant purge --reapply with a verified deletion certificate that names this organisation (D.5.6)',
    }),
    ...rows<OrganizationState>(ORGANIZATION, 'archived', 'offboarding', 'ops.tenants.manage', {
      ...STATUS_MOVE_CONFIRMED, sets: ['offboarding_ends_at'],
      note: 'Only while the deletion is scheduled, which it cancels; a new read-only end 7 days ahead and a new final export (D.2, D.5.1)',
    }),
    ...rows<OrganizationState>(ORGANIZATION, 'archived', 'deleted', null, { note: 'org.purge on the deletion date; deleted is final (D.5.2)' }),
    ...rows<OrganizationState>(ORGANIZATION, ['active', 'suspended'], 'archived', null, {
      note: 'tenant purge --reapply after a restore, with a deletion certificate whose signature verifies and that names this organisation (D.5.6)',
    }),
  ],
  rejections: [],
};

type OrganizationExportState = (typeof ORGANIZATION_EXPORT_STATUSES)[number];
const ORGANIZATION_EXPORT = 'organization_export.status' as const;
/** Milestone 3 J.8, D.4: a full export of the organisation, approved by a second Tenant Admin when there is one. */
const organizationExport: Machine = {
  entity: ORGANIZATION_EXPORT,
  owner: 'M3-01',
  states: ORGANIZATION_EXPORT_STATUSES,
  transitions: [
    ...rows<OrganizationExportState>(ORGANIZATION_EXPORT, null, 'requested', 'org.export.manage', {
      via: 'exports.organization.create', note: 'When another active Tenant Admin exists, who approves it (H.2)',
    }),
    ...rows<OrganizationExportState>(ORGANIZATION_EXPORT, null, 'queued', 'org.export.manage', {
      via: 'exports.organization.create', note: 'With a single Tenant Admin, queued at once with a warning (H.2)',
    }),
    ...rows<OrganizationExportState>(ORGANIZATION_EXPORT, null, 'queued', 'ops.tenants.manage', {
      via: 'ops.exports.create', requires: ['reason'], note: 'The platform operator queues an export for the Tenant Admins and never downloads it',
    }),
    ...rows<OrganizationExportState>(ORGANIZATION_EXPORT, null, 'queued', null, { sets: ['is_final'], note: 'The move to offboarding queues the final export (D.4)' }),
    ...rows<OrganizationExportState>(ORGANIZATION_EXPORT, 'requested', 'queued', 'org.export.manage', {
      via: 'exports.organization.decide', rules: ['SOD-SELF-APPROVE'], sets: ['decided_by', 'decided_at'], note: 'Another Tenant Admin approves; the requester is refused',
    }),
    ...rows<OrganizationExportState>(ORGANIZATION_EXPORT, 'requested', 'rejected', 'org.export.manage', {
      via: 'exports.organization.decide', rules: ['SOD-SELF-APPROVE'], sets: ['decided_by', 'decided_at', 'decision_note'], note: 'Another Tenant Admin rejects; the requester is refused',
    }),
    ...rows<OrganizationExportState>(ORGANIZATION_EXPORT, 'requested', 'expired', null, { note: '7 days without a decision' }),
    ...rows<OrganizationExportState>(ORGANIZATION_EXPORT, 'queued', 'building', null, { note: 'org-export.build starts' }),
    ...rows<OrganizationExportState>(ORGANIZATION_EXPORT, 'failed', 'building', null, {
      note: 'The one retry of org-export.build starts the failed attempt again, unless another export of the organisation is queued or building',
    }),
    ...rows<OrganizationExportState>(ORGANIZATION_EXPORT, 'building', 'ready', null, {
      sets: ['parts', 'manifest_object_id', 'manifest_sha256', 'expires_at', 'completed_at'], note: 'org-export.build stored every part and the manifest',
    }),
    ...rows<OrganizationExportState>(ORGANIZATION_EXPORT, 'building', 'failed', null, {
      sets: ['error'], note: 'org-export.build failed, or cleanup.expired found it building for 24 hours while no build ran',
    }),
    ...rows<OrganizationExportState>(ORGANIZATION_EXPORT, 'queued', 'failed', null, {
      sets: ['error'],
      note: 'org-export.build found the organisation neither active nor offboarding, or cleanup.expired found it queued for 24 hours while no build ran',
    }),
    ...rows<OrganizationExportState>(ORGANIZATION_EXPORT, 'ready', 'expired', null, { note: 'cleanup.expired deletes the content of an expired export (D.4)' }),
  ],
  rejections: [],
};

type OrganizationDeletionState = (typeof ORGANIZATION_DELETION_STATUSES)[number];
const ORGANIZATION_DELETION = 'organization_deletion.status' as const;
/** Milestone 3 J.8, D.5: the verified deletion of an archived organisation, run by the worker on its date. */
const organizationDeletion: Machine = {
  entity: ORGANIZATION_DELETION,
  owner: 'M3-01',
  states: ORGANIZATION_DELETION_STATUSES,
  transitions: [
    ...rows<OrganizationDeletionState>(ORGANIZATION_DELETION, null, 'scheduled', null, {
      sets: ['scheduled_for'], note: 'The move to archived schedules the deletion for archiving plus lifecycle.deletion_grace_days (D.5.1)',
    }),
    ...rows<OrganizationDeletionState>(ORGANIZATION_DELETION, null, 'scheduled', 'ops.tenants.manage', {
      via: 'ops.deletion.schedule', requires: ['scheduledFor', 'reason', 'confirmSlug'], sets: ['scheduled_for', 'scheduled_by'],
      note: 'An archived organisation, not earlier than archiving plus lifecycle.deletion_min_grace_days; the date may change while scheduled',
    }),
    ...rows<OrganizationDeletionState>(ORGANIZATION_DELETION, 'scheduled', 'cancelled', 'ops.tenants.manage', { via: 'ops.deletion.cancel', requires: ['reason'] }),
    ...rows<OrganizationDeletionState>(ORGANIZATION_DELETION, 'scheduled', 'cancelled', null, { note: 'The organisation returns to offboarding (D.5.1)' }),
    ...rows<OrganizationDeletionState>(ORGANIZATION_DELETION, 'scheduled', 'running', null, {
      sets: ['started_at'], note: 'org.lifecycle on the date, which queues org.purge; also tenant purge --reapply with a verified deletion certificate (D.5.6)',
    }),
    ...rows<OrganizationDeletionState>(ORGANIZATION_DELETION, 'running', 'completed', null, {
      sets: ['completed_at', 'report', 'certificate', 'certificate_signature', 'certificate_key_id'], note: 'org.purge: every step and check passed, certificate signed (D.5.2 to D.5.5)',
    }),
    ...rows<OrganizationDeletionState>(ORGANIZATION_DELETION, 'running', 'failed', null, { sets: ['failed_step', 'error'], note: 'org.purge: a step or a check failed; the operators are alerted' }),
    ...rows<OrganizationDeletionState>(ORGANIZATION_DELETION, 'failed', 'running', 'ops.tenants.manage', {
      via: 'ops.deletion.retry', requires: ['reason'], note: 'Runs the purge again from failed_step',
    }),
    ...rows<OrganizationDeletionState>(ORGANIZATION_DELETION, [null, 'cancelled'], 'running', null, {
      note: 'tenant purge --reapply after a restore, with a verified deletion certificate (D.5.6)',
    }),
  ],
  rejections: [],
};

type PrivacyRequestState = (typeof PRIVACY_REQUEST_STATUSES)[number];
const PRIVACY_REQUEST = 'privacy_request.status' as const;
/** Milestone 3 J.8, D.6: a request from one person about their own personal data, answered by a Tenant Admin. */
const privacyRequest: Machine = {
  entity: PRIVACY_REQUEST,
  owner: 'M3-01',
  states: PRIVACY_REQUEST_STATUSES,
  transitions: [
    ...rows<PrivacyRequestState>(PRIVACY_REQUEST, null, 'received', 'privacy_request.manage', {
      via: 'privacy-requests.create', requires: ['type', 'subject', 'receivedAt', 'channel'], sets: ['request_no', 'due_at'],
    }),
    ...rows<PrivacyRequestState>(PRIVACY_REQUEST, null, 'received', null, {
      sets: ['request_no', 'due_at'], note: 'The person through me.privacy-requests.create (an active session acting on its own data, channel self_service)',
    }),
    ...rows<PrivacyRequestState>(PRIVACY_REQUEST, 'received', 'in_progress', 'privacy_request.manage', {
      via: 'privacy-requests.update', requires: ['identityCheckNote'], sets: ['identity_check_note', 'identity_checked_by', 'handled_by'],
    }),
    ...rows<PrivacyRequestState>(PRIVACY_REQUEST, 'in_progress', 'completed', 'privacy_request.manage', {
      via: 'privacy-requests.close', requires: ['outcome'], sets: ['closed_at', 'outcome', 'result'], note: 'After the action of its type (D.6.3)',
    }),
    ...rows<PrivacyRequestState>(PRIVACY_REQUEST, ['received', 'in_progress'], 'refused', 'privacy_request.manage', {
      via: 'privacy-requests.update', requires: ['reason'], sets: ['closed_at', 'outcome'],
    }),
    ...rows<PrivacyRequestState>(PRIVACY_REQUEST, ['received', 'in_progress'], 'withdrawn', 'privacy_request.manage', {
      via: 'privacy-requests.update', requires: ['reason'], sets: ['closed_at', 'outcome'],
    }),
  ],
  rejections: [],
};

type RetentionReviewState = (typeof RETENTION_REVIEW_STATUSES)[number];
const RETENTION_REVIEW = 'retention_review.status' as const;
/** Milestone 3 J.8, D.8: the disposal review of an item whose retention period ended. */
const retentionReview: Machine = {
  entity: RETENTION_REVIEW,
  owner: 'M3-01',
  states: RETENTION_REVIEW_STATUSES,
  transitions: [
    ...rows<RetentionReviewState>(RETENTION_REVIEW, null, 'open', null, { note: 'retention.review: the retention period of the item ended, no hold, no keep-until date ahead' }),
    ...rows<RetentionReviewState>(RETENTION_REVIEW, 'open', 'kept', 'retention.manage', {
      via: 'retention.reviews.decide', requires: ['reason', 'keepUntil'], sets: ['decision', 'decided_by', 'decided_at', 'reason', 'keep_until'],
    }),
    ...rows<RetentionReviewState>(RETENTION_REVIEW, 'open', 'extended', 'retention.manage', {
      via: 'retention.reviews.decide', requires: ['reason', 'extendMonths'], sets: ['decision', 'decided_by', 'decided_at', 'reason', 'retention_ends_on'],
    }),
    ...rows<RetentionReviewState>(RETENTION_REVIEW, 'open', 'awaiting_approval', 'retention.manage', {
      via: 'retention.reviews.decide', requires: ['reason'], rules: ['RET-HOLD', 'RET-NOT-DUE', 'RET-CURRENT'], sets: ['decision', 'decided_by', 'decided_at', 'reason'],
      note: 'Decision dispose; disposal_approval_pending to the other managers and Programme Owners',
    }),
    ...rows<RetentionReviewState>(RETENTION_REVIEW, 'awaiting_approval', 'disposed', 'retention.approve', {
      via: 'retention.reviews.approve', rules: ['SOD-SELF-APPROVE'], sets: ['approved_by', 'approved_at', 'disposed_at', 'file_action'],
      note: 'A second person approves; the disposal runs at once (D.8)',
    }),
    ...rows<RetentionReviewState>(RETENTION_REVIEW, 'awaiting_approval', 'open', 'retention.approve', {
      via: 'retention.reviews.reject', requires: ['note'], sets: ['rejected_note'],
    }),
    ...rows<RetentionReviewState>(RETENTION_REVIEW, ['kept', 'extended'], 'open', null, { note: 'retention.review on the keep-until date or the new end date' }),
  ],
  rejections: [],
};

type AccessReviewState = (typeof ACCESS_REVIEW_STATUSES)[number];
const ACCESS_REVIEW = 'access_review.status' as const;
/** Milestone 3 J.8, D.9: one periodic access review of the organisation, with one part per management system. */
const accessReview: Machine = {
  entity: ACCESS_REVIEW,
  owner: 'M3-01',
  states: ACCESS_REVIEW_STATUSES,
  transitions: [
    ...rows<AccessReviewState>(ACCESS_REVIEW, null, 'open', null, { sets: ['review_no', 'opened_on', 'due_on'], note: 'access-review.open on the due date, one open review at a time' }),
    ...rows<AccessReviewState>(ACCESS_REVIEW, null, 'open', 'access_review.manage', {
      via: 'access-reviews.create', sets: ['review_no', 'opened_on', 'due_on', 'opened_by'], note: 'One open review at a time',
    }),
    ...rows<AccessReviewState>(ACCESS_REVIEW, 'open', 'completed', 'access_review.manage', {
      via: 'access-reviews.complete', sets: ['completed_at', 'completed_by', 'summary', 'report_object_id'],
      note: 'Every part signed off and every revocation applied or explained; REVIEW-SINGLE-ADMIN warns when one Tenant Admin reviewed alone',
    }),
    ...rows<AccessReviewState>(ACCESS_REVIEW, 'open', 'cancelled', 'access_review.manage', { via: 'access-reviews.cancel', requires: ['reason'], sets: ['cancel_reason'] }),
  ],
  rejections: [],
};

/** Every machine of C.13, keyed by entity. */
export const MACHINES: Readonly<Record<MachineEntity, Machine>> = {
  'applicability_entry.implementation_status': applicability,
  'implementation_activity_progress.status': activity,
  'document.status': document,
  'risk_treatment.status': treatment,
  'finding.status': finding,
  'corrective_action.status': correctiveAction,
  'management_review.status': managementReview,
  'self_assessment.status': selfAssessment,
  'audit_prep_task.status': progressMachine('audit_prep_task.status', 'prep_task.update'),
  'cycle_requirement_status.status': progressMachine('cycle_requirement_status.status', 'cycle_item.update'),
  'user_ms_role.approval_status': roleApproval,
  'management_system.status': managementSystem,
  'certification_cycle.status': certificationCycle,
  'organization.status': organization,
  'organization_export.status': organizationExport,
  'organization_deletion.status': organizationDeletion,
  'privacy_request.status': privacyRequest,
  'retention_review.status': retentionReview,
  'access_review.status': accessReview,
};

/** Every transition row of every machine. */
export const TRANSITIONS: readonly Transition[] = MACHINE_ENTITIES.flatMap((entity) => MACHINES[entity].transitions);

/** Every rejection of every machine. */
export const REJECTIONS: readonly Rejection[] = MACHINE_ENTITIES.flatMap((entity) => MACHINES[entity].rejections);

/** Every row for one `(from, to)` pair, whatever route performs it. Commands use `transitionsVia` instead. */
export function transitionsFor(entity: MachineEntity, from: string | null, to: string): Transition[] {
  return MACHINES[entity].transitions.filter((t) => t.from === from && t.to === to);
}

/**
 * The rows of a pair that one route performs: `via` null for the machine's transition route (the rows without
 * `via`), or the id of a dedicated route (the rows whose `via` is that id). Commands look up their rows with this; an
 * empty list means 409 `transition-not-allowed`, unless `rejectionFor` with the same `via` names a rule (422).
 */
export function transitionsVia(entity: MachineEntity, from: string | null, to: string, via: string | null): Transition[] {
  return transitionsFor(entity, from, to).filter((t) => (t.via ?? null) === via);
}

/**
 * The rejection of a pair that has no rows on one route (`via` as for `transitionsVia`): the command answers 422 with
 * its rule instead of 409.
 */
export function rejectionFor(entity: MachineEntity, from: string | null, to: string, via: string | null): Rejection | undefined {
  return MACHINES[entity].rejections.find((r) => r.from === from && r.to === to && (r.via ?? null) === via);
}

/**
 * Permissions of the rows one route performs (`via` as for `transitionsVia`; the default null is the machine's
 * transition route): what that route's guard accepts. Rows of dedicated routes do not count for the transition route.
 */
export function machinePermissions(entity: MachineEntity, via: string | null = null): Permission[] {
  const out = new Set<Permission>();
  for (const t of MACHINES[entity].transitions) if (t.permission && (t.via ?? null) === via) out.add(t.permission);
  return [...out];
}
