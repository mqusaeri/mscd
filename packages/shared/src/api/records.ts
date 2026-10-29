// Area `records` (owner from wave 9: WP-35): commands that apply to many record types through `{entityType}`:
// assignment, completing a pending action, soft delete (BR-19, BR-22), and completing a stored task (D-29).
// Milestone 2 (D.1) adds the open items a person holds and their handover to a successor (M2-07): the MS Manager and
// the Programme Owner see the items of a system, the Tenant Admin counts only, without titles (H.13).
import { z } from 'zod';
import { CommandResult, Handle, IdParams, IsoDate, MsId, PersonId, RecordRef, RequiredReason, Uuid, defineRoute, named } from './common.js';
import type { RouteDef } from './common.js';

/**
 * Entity types a `{entityType}` path segment accepts (D.1): the chain and register tables. Anything else answers
 * 404 before a query runs.
 */
export const RECORD_ENTITY_TYPES = [
  'applicability_entry', 'document', 'evidence', 'implementation_activity_progress', 'context_issue', 'interested_party',
  'asset', 'risk', 'risk_treatment', 'metric', 'quality_objective', 'competence_record', 'process', 'prioritized_activity',
  'business_impact_analysis', 'bc_plan', 'exercise', 'business_associate', 'chain_record', 'audit_prep_task',
  'cycle_requirement_status', 'drift_result', 'finding', 'corrective_action', 'management_review', 'self_assessment',
  'audit_activity',
] as const;
export const RecordEntityType = z.enum(RECORD_ENTITY_TYPES).meta({ id: 'RecordEntityType', description: 'Entity type of a {entityType} path segment (D.1 RECORD_ENTITY_TYPES; competence_record: Milestone 2 D.3)' });
export type RecordEntityType = z.infer<typeof RecordEntityType>;

/** Tables that hold the explicit chain records of entity stages (C.10), the `x` assignment kind. */
export const STAGE_RECORD_ENTITY_TYPES = [
  'context_issue', 'risk', 'risk_treatment', 'metric', 'quality_objective', 'prioritized_activity', 'business_impact_analysis',
  'exercise', 'business_associate', 'chain_record',
] as const satisfies readonly RecordEntityType[];

/** Assignment kinds: the RecordKey kind of the item being reassigned (D.2 `AssignmentRequest`). */
export const ASSIGNMENT_KINDS = ['req', 'soa', 'doc', 'ev', 'act', 'x', 'prep', 'cycle', 'drift'] as const;
export const AssignmentKind = z.enum(ASSIGNMENT_KINDS).meta({ id: 'AssignmentKind', description: 'RecordKey kind of the assigned item (D.2 AssignmentRequest.kind)' });
export type AssignmentKind = z.infer<typeof AssignmentKind>;

/** Entity types each assignment kind applies to (WP-35 assignment table); another pair answers 422. */
export const ASSIGNMENT_KIND_ENTITY_TYPES: Readonly<Record<AssignmentKind, readonly RecordEntityType[]>> = {
  req: ['applicability_entry'],
  soa: ['applicability_entry'],
  doc: ['document'],
  ev: ['evidence'],
  act: ['implementation_activity_progress'],
  x: STAGE_RECORD_ENTITY_TYPES,
  prep: ['audit_prep_task'],
  cycle: ['cycle_requirement_status'],
  drift: ['drift_result'],
};

export const RecordParams = named(
  'RecordParams',
  z.strictObject({ ms: MsId, entityType: RecordEntityType, id: Uuid }),
  'Path parameters {ms}, {entityType} and {id}',
  { valid: [{ ms: 'isms', entityType: 'risk', id: '8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b' }], invalid: [{ ms: 'isms', entityType: 'app_user', id: '8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b' }, { ms: 'isms', entityType: 'risk', id: 'R-031' }] },
);
export type RecordParams = z.infer<typeof RecordParams>;

export const AssignmentRequest = named(
  'AssignmentRequest',
  z.strictObject({ kind: AssignmentKind, holder: PersonId, dueAt: IsoDate.nullable() }),
  'POST /ms/{ms}/records/{entityType}/{id}/assignment body: the kind selects the fields (a SoA checkpoint item never changes the control owner); holder none unassigns',
  { valid: [{ kind: 'x', holder: 'bagus', dueAt: '2026-10-20' }, { kind: 'soa', holder: 'none', dueAt: null }], invalid: [{ kind: 'task', holder: 'bagus', dueAt: null }, { kind: 'x', holder: 'bagus' }] },
);
export type AssignmentRequest = z.infer<typeof AssignmentRequest>;

export const CompleteActionRequest = named('CompleteActionRequest', z.strictObject({ note: z.string().trim().min(1).max(1000).optional() }), 'Body of complete-action and task completion: an optional note', {
  valid: [{}, { note: 'Reviewed with the owner' }],
  invalid: [{ note: '' }, { done: true }],
});
export type CompleteActionRequest = z.infer<typeof CompleteActionRequest>;

export const SoftDeleteRequest = named(
  'SoftDeleteRequest',
  z.strictObject({ reason: RequiredReason, confirm: z.boolean().optional() }),
  'POST .../delete body: a reason of 10 to 500 characters; confirm after 409 confirmation-required (BR-22)',
  { valid: [{ reason: 'Duplicate of R-014, merged' }, { reason: 'Shared document no longer used', confirm: true }], invalid: [{ reason: 'dup' }, { confirm: true }] },
);
export type SoftDeleteRequest = z.infer<typeof SoftDeleteRequest>;

export const recordsAssignRoute = defineRoute({
  id: 'records.assign',
  owner: 'WP-35',
  method: 'POST',
  path: '/api/v1/ms/:ms/records/:entityType/:id/assignment',
  summary: 'Reassign the holder and due date of an item (BR-43 for preparation tasks; warnings BR-41, BR-17)',
  auth: 'session',
  permission: 'record.assign',
  scope: 'ms',
  msSource: 'path',
  params: RecordParams,
  body: AssignmentRequest,
  response: CommandResult,
  errors: [404, 412, 422],
  ifMatch: true,
});

export const recordsCompleteActionRoute = defineRoute({
  id: 'records.complete-action',
  owner: 'WP-35',
  method: 'POST',
  path: '/api/v1/ms/:ms/records/:entityType/:id/complete-action',
  summary: 'Mark the pending action of a chain record or drift row done',
  auth: 'session',
  permission: 'record.complete_action',
  scope: 'ms',
  msSource: 'path',
  params: RecordParams,
  body: CompleteActionRequest,
  response: CommandResult,
  errors: [404, 409],
});

export const recordsDeleteRoute = defineRoute({
  id: 'records.delete',
  owner: 'WP-35',
  method: 'POST',
  path: '/api/v1/ms/:ms/records/:entityType/:id/delete',
  summary: 'Soft delete a record with a reason (BR-19, BR-22 confirmation, open dependants rejected)',
  auth: 'session',
  permission: 'record.delete',
  scope: 'ms',
  msSource: 'path',
  params: RecordParams,
  body: SoftDeleteRequest,
  response: CommandResult,
  errors: [404, 409, 422],
});

export const tasksCompleteRoute = defineRoute({
  id: 'tasks.complete',
  owner: 'WP-35',
  method: 'POST',
  path: '/api/v1/tasks/:id/complete',
  summary: "Complete a stored task (the task's owner only)",
  auth: 'session',
  params: IdParams,
  body: CompleteActionRequest,
  response: CommandResult,
  errors: [404, 409],
});

// ---------------------------------------------------------------------------------------------------------------
// Holdings and handover (Milestone 2 D.1, M2-07)
// ---------------------------------------------------------------------------------------------------------------

/** Kinds of open items a person can hold in a system (Milestone 2 M2-07). */
export const HOLDING_KINDS = [
  'applicability_entry', 'activity', 'document_owner', 'document_approver', 'evidence', 'risk', 'risk_treatment', 'finding',
  'corrective_action', 'prep_task', 'cycle_item', 'register_row', 'task',
] as const;
export const HoldingKind = z.enum(HOLDING_KINDS).meta({ id: 'HoldingKind', description: 'Kind of an open item a person holds (Milestone 2 M2-07)' });
export type HoldingKind = z.infer<typeof HoldingKind>;

export const HoldingParams = named('HoldingParams', z.strictObject({ ms: MsId, handle: Handle }), 'Path parameters {ms} and {handle}: the person whose items are listed or handed over', {
  valid: [{ ms: 'isms', handle: 'bagus' }],
  invalid: [{ ms: 'isms', handle: 'none' }, { ms: 'isms' }],
});
export type HoldingParams = z.infer<typeof HoldingParams>;

const EXAMPLE_HOLDING = {
  kind: 'risk', ref: { module: 'audit', entityType: 'risk', id: '8a1f2d3c-4b5e-4f60-9a7b-1c2d3e4f5a6b', code: 'R-014' }, code: 'R-014',
  title: 'Privileged credential misuse', dueAt: '2026-11-20',
} as const;

export const Holdings = named(
  'Holdings',
  z.object({
    handle: Handle,
    ms: MsId,
    items: z.array(z.object({ kind: HoldingKind, ref: RecordRef, code: z.string(), title: z.string(), dueAt: IsoDate.nullable() })),
    counts: z.partialRecord(HoldingKind, z.int().min(0)),
  }),
  'GET /ms/{ms}/holdings/{handle}: the open items a person holds in the system, with counts per kind (Milestone 2 D.1)',
  { valid: [{ handle: 'bagus', ms: 'isms', items: [EXAMPLE_HOLDING], counts: { risk: 1 } }, { handle: 'bagus', ms: 'isms', items: [], counts: {} }], invalid: [{ handle: 'bagus', ms: 'isms', items: [{ ...EXAMPLE_HOLDING, kind: 'gate' }], counts: {} }] },
);
export type Holdings = z.infer<typeof Holdings>;

export const HoldingsReassign = named(
  'HoldingsReassign',
  z.strictObject({ successor: Handle, kinds: z.array(HoldingKind).min(1).optional(), confirm: z.boolean().optional() }),
  'POST /ms/{ms}/holdings/{handle}/reassign body: the successor and the kinds to move (all when absent); BR-16, BR-17 and BR-41 apply per record (Milestone 2 D.1)',
  { valid: [{ successor: 'sari' }, { successor: 'sari', kinds: ['risk', 'risk_treatment'] }], invalid: [{ successor: 'none' }, { successor: 'sari', kinds: [] }, {}] },
);
export type HoldingsReassign = z.infer<typeof HoldingsReassign>;

export const UserHoldings = named(
  'UserHoldings',
  z.object({
    systems: z.array(z.object({
      ms: MsId,
      name: z.string(),
      primaryManager: z.object({ handle: Handle, displayName: z.string(), email: z.string() }).nullable(),
      counts: z.partialRecord(HoldingKind, z.int().min(0)),
      total: z.int().min(0),
    })),
  }),
  'GET /admin/users/{id}/holdings: counts per system and record kind with the primary manager of each system, no titles (F.6, Milestone 2 D.1)',
  {
    valid: [{ systems: [{ ms: 'isms', name: 'Information security management system', primaryManager: { handle: 'rina', displayName: 'Rina Kusuma', email: 'rina.kusuma@nusantaradigital.co.id' }, counts: { risk: 3, evidence: 2 }, total: 5 }] }, { systems: [] }],
    invalid: [{ systems: [{ ms: 'isms', name: 'x', primaryManager: null, counts: { risk: -1 }, total: 0 }] }],
  },
);
export type UserHoldings = z.infer<typeof UserHoldings>;

export const recordsHoldingsRoute = defineRoute({
  id: 'records.holdings',
  owner: 'M2-07',
  method: 'GET',
  path: '/api/v1/ms/:ms/holdings/:handle',
  summary: 'Open items a person holds in the system (Management System Manager and Programme Owner)',
  auth: 'session',
  permission: 'record.assign',
  scope: 'ms',
  msSource: 'path',
  params: HoldingParams,
  response: Holdings,
  errors: [404],
});

export const recordsHoldingsReassignRoute = defineRoute({
  id: 'records.holdings.reassign',
  owner: 'M2-07',
  method: 'POST',
  path: '/api/v1/ms/:ms/holdings/:handle/reassign',
  summary: 'Hand all or chosen kinds of open items over to a successor in one transaction, with warnings per record (audited holdings.reassigned)',
  auth: 'session',
  permission: 'record.assign',
  scope: 'ms',
  msSource: 'path',
  params: HoldingParams,
  body: HoldingsReassign,
  response: CommandResult,
  errors: [404, 409, 422],
});

export const adminUsersHoldingsRoute = defineRoute({
  id: 'admin.users.holdings',
  owner: 'M2-07',
  method: 'GET',
  path: '/api/v1/admin/users/:id/holdings',
  summary: 'Counts of open items of a member per system and record kind, with the primary manager of each system (no titles)',
  auth: 'session',
  permission: 'user.manage',
  scope: 'org',
  params: IdParams,
  response: UserHoldings,
  errors: [404],
});

export const routes: RouteDef[] = [
  recordsAssignRoute, recordsCompleteActionRoute, recordsDeleteRoute, tasksCompleteRoute,
  recordsHoldingsRoute, recordsHoldingsReassignRoute, adminUsersHoldingsRoute,
];
