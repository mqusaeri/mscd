// Area `audit-events` (owner from wave 9: WP-35): audit events (BR-42), preparation tasks (BR-43, A-23) and cycle
// items (TS 6.8) (D.2, D.3, C.13). Milestone 2 (D.2) lets MS Managers and Internal Auditors plan internal audits:
// creating an event needs `internal_audit.manage` for type `internal_audit` and `audit_event.manage` for every other
// type; changing one needs either permission, and the service refuses an Internal Auditor on an event that is not
// an internal audit (M2-05). The internal audit programme (D.1) is built by M2-05.
import { z } from 'zod';
import { AuditEventType, AuditOutcome, ClauseGroup, TaskProgressStatus } from '../enums.js';
import { Code, CommandResult, IsoDate, MsParams, MsRecordParams, PersonId, Uuid, defineRoute, named } from './common.js';
import type { PermissionByMember, RouteDef } from './common.js';

const Note = z.string().trim().min(1).max(2000);

const auditEventShape = {
  eventType: AuditEventType,
  nameEn: z.string().trim().min(1).max(200),
  nameId: z.string().trim().min(1).max(200),
  shortLabel: z.string().trim().min(1).max(80),
  scheduledAt: IsoDate,
  auditDays: z.int().min(1).max(365).optional(),
  leadAuditorName: z.string().trim().min(1).max(150).optional(),
  expectedFocus: z.string().trim().max(4000).optional(),
  prepWindowDays: z.int().min(0).max(365).optional(),
  /** Milestone 2 D.2: what an internal audit covers (scope, criteria, sample). */
  scopeText: z.string().trim().min(1).max(4000).optional(),
  /** Milestone 2 D.2: the audit report, a registered document of type record of the system. */
  reportDocumentId: Uuid.optional(),
};

export const AuditEventCreateRequest = named(
  'AuditEventCreateRequest',
  z.strictObject(auditEventShape),
  'POST /ms/{ms}/audit-events body',
  {
    valid: [
      { eventType: 'stage1', nameEn: 'Stage 1 audit', nameId: 'Audit tahap 1', shortLabel: 'Stage 1', scheduledAt: '2027-02-10', auditDays: 1, prepWindowDays: 60 },
      { eventType: 'internal_audit', nameEn: 'Internal audit 2026', nameId: 'Audit internal 2026', shortLabel: 'IA 2026', scheduledAt: '2026-12-08', auditDays: 2, prepWindowDays: 30, scopeText: 'Clauses 4 to 10 and Annex A themes 5 and 8, Jakarta office' },
    ],
    invalid: [
      { eventType: 'stage3', nameEn: 'x', nameId: 'x', shortLabel: 'x', scheduledAt: '2027-02-10' },
      { eventType: 'stage1', nameEn: 'x', nameId: 'x', shortLabel: 'x', scheduledAt: '2027-02-10', prepWindowDays: 400 },
      { eventType: 'internal_audit', nameEn: 'x', nameId: 'x', shortLabel: 'x', scheduledAt: '2027-02-10', reportDocumentId: 'report' },
    ],
  },
);
export type AuditEventCreateRequest = z.infer<typeof AuditEventCreateRequest>;

export const AuditEventPatch = named(
  'AuditEventPatch',
  z.strictObject({
    eventType: auditEventShape.eventType.optional(),
    nameEn: auditEventShape.nameEn.optional(),
    nameId: auditEventShape.nameId.optional(),
    shortLabel: auditEventShape.shortLabel.optional(),
    scheduledAt: IsoDate.optional(),
    auditDays: auditEventShape.auditDays.nullable(),
    leadAuditorName: auditEventShape.leadAuditorName.nullable(),
    expectedFocus: auditEventShape.expectedFocus.nullable(),
    prepWindowDays: auditEventShape.prepWindowDays,
    outcome: AuditOutcome.nullable().optional(),
    outcomeSummary: z.string().trim().max(4000).nullable().optional(),
    scopeText: auditEventShape.scopeText.nullable(),
    reportDocumentId: Uuid.nullable().optional(),
  }).refine((p) => Object.values(p).some((v) => v !== undefined), { message: 'Give at least one field' }),
  'PATCH /ms/{ms}/audit-events/{id} body; moving the date flags violating preparation tasks and notifies their holders (BR-42, A-26); reportDocumentId attaches the audit report (null removes it, Milestone 2 D.2)',
  {
    valid: [{ scheduledAt: '2026-11-19' }, { outcome: 'recommended', outcomeSummary: 'Certified, 1 OFI' }, { reportDocumentId: '0b7e8c2a-1d3f-4e5a-8b6c-7d8e9f0a1b2c' }, { scopeText: null }],
    invalid: [{}, { outcome: 'passed' }, { reportDocumentId: 'IA-REPORT' }],
  },
);
export type AuditEventPatch = z.infer<typeof AuditEventPatch>;

export const PrepTaskCreate = named(
  'PrepTaskCreate',
  z.strictObject({ title: z.string().trim().min(1).max(255), ownerHandle: PersonId, dueAt: IsoDate, status: TaskProgressStatus.optional(), note: Note.optional() }),
  'POST /ms/{ms}/audit-events/{id}/prep-tasks body; the due date must be before the audit (BR-43)',
  { valid: [{ title: 'Brief auditees on sampling focus', ownerHandle: 'rina', dueAt: '2026-11-09' }], invalid: [{ title: '', ownerHandle: 'rina', dueAt: '2026-11-09' }, { title: 'x', ownerHandle: 'rina' }] },
);
export type PrepTaskCreate = z.infer<typeof PrepTaskCreate>;

export const PrepTaskPatch = named(
  'PrepTaskPatch',
  z.strictObject({ title: z.string().trim().min(1).max(255).optional(), ownerHandle: PersonId.optional(), dueAt: IsoDate.optional(), status: TaskProgressStatus.optional(), note: Note.nullable().optional() })
    .refine((p) => Object.values(p).some((v) => v !== undefined), { message: 'Give at least one field' }),
  'PATCH /ms/{ms}/prep-tasks/{id} body; status changes follow C.13 (blocked needs a note, A-23)',
  { valid: [{ status: 'done' }, { status: 'blocked', note: 'Waiting for the certifier' }, { dueAt: '2026-11-01' }], invalid: [{}, { status: 'finished' }] },
);
export type PrepTaskPatch = z.infer<typeof PrepTaskPatch>;

export const CycleItemPatch = named(
  'CycleItemPatch',
  z.strictObject({ status: TaskProgressStatus.optional(), note: Note.nullable().optional(), ownerHandle: PersonId.optional(), dueAt: IsoDate.optional() })
    .refine((p) => Object.values(p).some((v) => v !== undefined), { message: 'Give at least one field' }),
  'PATCH /ms/{ms}/cycle-items/{id} body (TS 6.8, C.13)',
  { valid: [{ status: 'in_progress' }, { note: '5 of 7 inputs prepared', ownerHandle: 'hendra' }], invalid: [{}, { status: 'progress' }] },
);
export type CycleItemPatch = z.infer<typeof CycleItemPatch>;

/** Milestone 2 D.2: internal audits need internal_audit.manage [MM, IA], every other event type audit_event.manage [MM]. */
const auditEventPermission = {
  source: 'body',
  member: 'eventType',
  cases: {
    'internal_audit': { permission: 'internal_audit.manage', scope: 'ms' },
    '*': { permission: 'audit_event.manage', scope: 'ms' },
  },
} as const satisfies PermissionByMember;

/** Milestone 2 D.2: either permission; the service checks the event type for holders of internal_audit.manage only. */
export const AUDIT_EVENT_OR_INTERNAL_AUDIT = [
  { permission: 'audit_event.manage', scope: 'ms' },
  { permission: 'internal_audit.manage', scope: 'ms' },
] as const;

export const auditEventsCreateRoute = defineRoute({
  id: 'audit-events.create',
  owner: 'WP-35',
  method: 'POST',
  path: '/api/v1/ms/:ms/audit-events',
  summary: 'Plan an audit event: internal_audit.manage for an internal audit, audit_event.manage for every other type',
  auth: 'session',
  permissionBy: auditEventPermission,
  msSource: 'path',
  params: MsParams,
  body: AuditEventCreateRequest,
  response: CommandResult,
  status: 201,
  errors: [404, 422],
  idempotent: true,
});

export const auditEventsUpdateRoute = defineRoute({
  id: 'audit-events.update',
  owner: 'WP-35',
  method: 'PATCH',
  path: '/api/v1/ms/:ms/audit-events/:id',
  summary: 'Change an audit event; count is the number of holders notified of a date change (BR-42); an Internal Auditor may change internal audits only',
  auth: 'session',
  anyOf: AUDIT_EVENT_OR_INTERNAL_AUDIT,
  msSource: 'path',
  params: MsRecordParams,
  body: AuditEventPatch,
  response: CommandResult,
  errors: [404, 412, 422],
  ifMatch: true,
});

export const prepTasksCreateRoute = defineRoute({
  id: 'prep-tasks.create',
  owner: 'WP-35',
  method: 'POST',
  path: '/api/v1/ms/:ms/audit-events/:id/prep-tasks',
  summary: 'Add a preparation task to an audit event (BR-43)',
  auth: 'session',
  permission: 'audit_event.manage',
  scope: 'ms',
  msSource: 'path',
  params: MsRecordParams,
  body: PrepTaskCreate,
  response: CommandResult,
  status: 201,
  errors: [404, 422],
  idempotent: true,
});

export const prepTasksUpdateRoute = defineRoute({
  id: 'prep-tasks.update',
  owner: 'WP-35',
  method: 'PATCH',
  path: '/api/v1/ms/:ms/prep-tasks/:id',
  summary: 'Update a preparation task (status per C.13; BR-43 for the due date)',
  auth: 'session',
  permission: 'prep_task.update',
  machine: 'audit_prep_task.status',
  scope: 'ms',
  msSource: 'path',
  params: MsRecordParams,
  body: PrepTaskPatch,
  response: CommandResult,
  errors: [404, 409, 412, 422],
  ifMatch: true,
});

export const cycleItemsUpdateRoute = defineRoute({
  id: 'cycle-items.update',
  owner: 'WP-35',
  method: 'PATCH',
  path: '/api/v1/ms/:ms/cycle-items/:id',
  summary: 'Update a cycle requirement item (status per C.13)',
  auth: 'session',
  permission: 'cycle_item.update',
  machine: 'cycle_requirement_status.status',
  scope: 'ms',
  msSource: 'path',
  params: MsRecordParams,
  body: CycleItemPatch,
  response: CommandResult,
  errors: [404, 409, 412, 422],
  ifMatch: true,
});

// ---------------------------------------------------------------------------------------------------------------
// Internal audit programme (Milestone 2 D.1, M2-05)
// ---------------------------------------------------------------------------------------------------------------

export const InternalAuditProgrammeQuery = named(
  'InternalAuditProgrammeQuery',
  z.strictObject({ cycle: Uuid.optional() }),
  'GET /ms/{ms}/internal-audit/programme query: the certification cycle (default: the open or newest cycle)',
  { valid: [{}, { cycle: '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d' }], invalid: [{ cycle: 'current' }, { year: 2026 }] },
);
export type InternalAuditProgrammeQuery = z.infer<typeof InternalAuditProgrammeQuery>;

const EXAMPLE_PROGRAMME_ROW = {
  code: '9.2', title: 'Internal audit', kind: 'clause', clauseGroup: '9', covered: true,
  audits: [{ eventId: '7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e', shortLabel: 'IA 2026', scheduledAt: '2026-12-08', activities: 2 }],
} as const;

export const InternalAuditProgramme = named(
  'InternalAuditProgramme',
  z.object({
    cycle: z.object({ id: Uuid, cycleStart: IsoDate, cycleEnd: IsoDate }).nullable(),
    rows: z.array(z.object({
      code: Code,
      title: z.string(),
      kind: z.enum(['clause', 'control']),
      clauseGroup: ClauseGroup.nullable(),
      covered: z.boolean(),
      audits: z.array(z.object({ eventId: Uuid, shortLabel: z.string(), scheduledAt: IsoDate, activities: z.int().min(0) })),
    })),
  }),
  'Clauses 4 to 10 and the applicable controls of a cycle with the internal audits that covered them; uncovered rows have no audits (Milestone 2 D.1)',
  {
    valid: [{ cycle: { id: '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d', cycleStart: '2025-03-14', cycleEnd: '2028-03-13' }, rows: [EXAMPLE_PROGRAMME_ROW, { ...EXAMPLE_PROGRAMME_ROW, code: 'A.5.23', title: 'Cloud services', kind: 'control', clauseGroup: null, covered: false, audits: [] }] }, { cycle: null, rows: [] }],
    invalid: [{ cycle: null, rows: [{ ...EXAMPLE_PROGRAMME_ROW, kind: 'annex' }] }, { rows: [] }],
  },
);
export type InternalAuditProgramme = z.infer<typeof InternalAuditProgramme>;

export const internalAuditProgrammeRoute = defineRoute({
  id: 'internal-audit.programme',
  owner: 'M2-05',
  method: 'GET',
  path: '/api/v1/ms/:ms/internal-audit/programme',
  summary: 'Internal audit programme of a cycle: clauses 4 to 10 and applicable controls with the internal audits that covered them',
  auth: 'session',
  permission: 'ms.read',
  scope: 'ms',
  msSource: 'path',
  params: MsParams,
  query: InternalAuditProgrammeQuery,
  response: InternalAuditProgramme,
  errors: [404],
});

export const routes: RouteDef[] = [
  auditEventsCreateRoute, auditEventsUpdateRoute, prepTasksCreateRoute, prepTasksUpdateRoute, cycleItemsUpdateRoute, internalAuditProgrammeRoute,
];
