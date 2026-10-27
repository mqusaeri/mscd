// Area `admin-ms` (owner from wave 5: WP-12): management systems and their status transitions (D.2
// `ManagementSystemCreate`, `MsTransitionRequest`; D.3 "Administration"; C.13 `management_system.status`; D-30).
// Milestone 2 (D.1, D.4, J.8) adds the certification cycles of a system and the certificate record, built by M2-05:
// a system moves to `certified` only through `ms.certification`.
import { z } from 'zod';
import { ApplicabilityTarget, AuditEventType, AuditOutcome, CertificationCycleStatus, MsStatus } from '../enums.js';
import { PackEdition, PackId } from '../pack/manifest.js';
import {
  Color, CommandResult, IdParams, Instant, IsoDate, MsId, MsParams, MsRecordParams, RepositorySlug, Uuid, defineRoute, named,
} from './common.js';
import type { RouteDef } from './common.js';

const EXAMPLE_MS_VIEW = {
  id: '5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c', slug: 'qms', code: 'QMS', name: 'Quality management system', frameworkCode: 'ISO9001',
  frameworkName: 'ISO 9001', edition: '2015', packId: 'ISO9001-2015', packVersion: '1.4.2', transitionTargetEdition: '2026',
  applicabilityTarget: 'requirement', status: 'transitioning', scopeStatement: 'Software product development and support',
  certificationBody: 'Lembaga Sertifikasi Garuda Mutu', color: '#3a6fd8', defaultRepository: 'vault', position: 1, createdAt: '2026-02-02T03:00:00Z',
} as const;

export const ManagementSystemView = named(
  'ManagementSystemView',
  z.object({
    id: Uuid,
    slug: MsId,
    code: z.string(),
    name: z.string(),
    frameworkCode: z.string(),
    frameworkName: z.string(),
    edition: z.string(),
    packId: z.string(),
    packVersion: z.string(),
    transitionTargetEdition: z.string().nullable(),
    applicabilityTarget: ApplicabilityTarget,
    status: MsStatus,
    scopeStatement: z.string(),
    certificationBody: z.string().nullable(),
    color: Color,
    defaultRepository: RepositorySlug,
    position: z.int(),
    createdAt: Instant,
  }),
  'Management system as the administration screens see it',
  { valid: [EXAMPLE_MS_VIEW, { ...EXAMPLE_MS_VIEW, transitionTargetEdition: null, certificationBody: null, status: 'implementing' }], invalid: [{ ...EXAMPLE_MS_VIEW, status: 'live' }, { ...EXAMPLE_MS_VIEW, slug: 'QMS' }] },
);
export type ManagementSystemView = z.infer<typeof ManagementSystemView>;

export const ManagementSystemCreate = named(
  'ManagementSystemCreate',
  z.strictObject({
    slug: MsId,
    code: z.string().trim().min(1).max(20),
    name: z.string().trim().min(1).max(150),
    packId: PackId,
    edition: PackEdition,
    scopeStatement: z.string().trim().min(1).max(4000),
    defaultRepository: RepositorySlug,
    certificationBody: z.string().trim().max(150).optional(),
    color: Color,
  }),
  'POST /admin/management-systems body: activates an installed edition and copies its activity templates (D-30)',
  {
    valid: [{ slug: 'bcms', code: 'BCMS', name: 'Business continuity management system', packId: 'ISO22301-2019', edition: '2019', scopeStatement: 'Data centre operations: Jakarta', defaultRepository: 'gd', color: '#1f7a48' }],
    invalid: [{ slug: 'BCMS', code: 'BCMS', name: 'x', packId: 'ISO22301-2019', edition: '2019', scopeStatement: 'x', defaultRepository: 'gd', color: '#1f7a48' }, { slug: 'bcms', code: 'BCMS', name: 'x', packId: 'ISO22301-2019', edition: '2019', scopeStatement: '', defaultRepository: 'gd', color: '#1f7a48' }],
  },
);
export type ManagementSystemCreate = z.infer<typeof ManagementSystemCreate>;

export const ManagementSystemPatch = named(
  'ManagementSystemPatch',
  z.strictObject({
    scopeStatement: z.string().trim().min(1).max(4000).optional(),
    certificationBody: z.string().trim().max(150).nullable().optional(),
    color: Color.optional(),
    defaultRepository: RepositorySlug.optional(),
    status: z.enum(['implementing', 'archived']).optional(),
  }).refine((p) => Object.values(p).some((v) => v !== undefined), { message: 'Give at least one field' }),
  'PATCH /admin/management-systems/{id} body: scope, certification body, colour, default repository, and the ms.admin transitions of C.13 (setup to implementing, archive)',
  { valid: [{ color: '#e8731a' }, { status: 'implementing' }, { certificationBody: null }], invalid: [{}, { status: 'certified' }, { slug: 'x' }] },
);
export type ManagementSystemPatch = z.infer<typeof ManagementSystemPatch>;

export const MsTransitionRequest = named(
  'MsTransitionRequest',
  z.discriminatedUnion('to', [
    z.strictObject({ to: z.literal('transitioning'), targetEdition: PackEdition }),
    z.strictObject({ to: z.literal('certified') }),
  ]),
  'POST /ms/{ms}/transitions body: start an edition transition, or return to certified after the transition audit (C.13, feature edition_transition)',
  { valid: [{ to: 'transitioning', targetEdition: '2026' }, { to: 'certified' }], invalid: [{ to: 'transitioning' }, { to: 'archived' }, { to: 'certified', targetEdition: '2026' }] },
);
export type MsTransitionRequest = z.infer<typeof MsTransitionRequest>;

// ---------------------------------------------------------------------------------------------------------------
// Certification cycles (Milestone 2 D.1, D.4, J.8)
// ---------------------------------------------------------------------------------------------------------------

const EXAMPLE_CYCLE = {
  id: '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d', status: 'certified', cycleStart: '2025-03-14', cycleEnd: '2028-03-13', certificateNo: 'ISMS-2025-0147',
  certifiedAt: '2025-03-14', certificateExpiresAt: '2028-03-13', certificationBody: 'PT Sertifikasi Nusantara',
  certifiedScope: 'Data centre and managed services operations: Jakarta and Surabaya',
  events: [
    { id: '7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e', eventType: 'stage2', shortLabel: 'Stage 2', scheduledAt: '2025-02-20', outcome: 'recommended', scopeText: null, reportDocumentId: null },
    {
      id: '8c9d0e1f-2a3b-4c4d-8e5f-6a7b8c9d0e1f', eventType: 'internal_audit', shortLabel: 'IA 2025', scheduledAt: '2025-11-12', outcome: null,
      scopeText: 'Clauses 4 to 10 and Annex A themes 5 and 8, Jakarta office', reportDocumentId: '0b7e8c2a-1d3f-4e5a-8b6c-7d8e9f0a1b2c',
    },
  ],
  items: { total: 12, done: 12 },
  etag: 'W/"1790000000000"',
} as const;

export const CertificationCycleItem = named(
  'CertificationCycleItem',
  z.object({
    id: Uuid,
    status: CertificationCycleStatus,
    cycleStart: IsoDate,
    cycleEnd: IsoDate,
    certificateNo: z.string().nullable(),
    certifiedAt: IsoDate.nullable(),
    certificateExpiresAt: IsoDate.nullable(),
    certificationBody: z.string().nullable(),
    certifiedScope: z.string().nullable(),
    events: z.array(z.object({
      id: Uuid,
      eventType: AuditEventType,
      shortLabel: z.string(),
      scheduledAt: IsoDate,
      outcome: AuditOutcome.nullable(),
      /** What an internal audit covered (D.2), null when not given. */
      scopeText: z.string().nullable(),
      /** The audit report (D.2), null when none is attached; the client finds its code among the documents the scope policy shows. */
      reportDocumentId: Uuid.nullable(),
    })),
    items: z.object({ total: z.int().min(0), done: z.int().min(0) }),
    /** The cycle's weak ETag, sent as `If-Match` on `ms.cycles.transition` (R-18). */
    etag: z.string(),
  }),
  'A certification cycle of a system with its dates, certificate, audit events (with the scope and report of an internal audit) and the ETag for its transitions (Milestone 2 D.1, D.2, D.4)',
  {
    valid: [EXAMPLE_CYCLE, { ...EXAMPLE_CYCLE, status: 'active', certificateNo: null, certifiedAt: null, certificateExpiresAt: null, certificationBody: null, certifiedScope: null, events: [], items: { total: 12, done: 3 } }],
    invalid: [{ ...EXAMPLE_CYCLE, status: 'lapsed' }, { ...EXAMPLE_CYCLE, items: { total: -1, done: 0 } }, { ...EXAMPLE_CYCLE, etag: undefined }],
  },
);
export type CertificationCycleItem = z.infer<typeof CertificationCycleItem>;

export const CertificationCycleCreate = named(
  'CertificationCycleCreate',
  z.strictObject({ cycleStart: IsoDate, cycleEnd: IsoDate.optional() }),
  'POST /ms/{ms}/certification-cycles body: start a cycle and its cycle items; cycleEnd defaults to three years later (Milestone 2 D.4)',
  { valid: [{ cycleStart: '2026-11-01' }, { cycleStart: '2026-11-01', cycleEnd: '2029-10-31' }], invalid: [{}, { cycleStart: '1 Nov 2026' }, { cycleStart: '2026-11-01', status: 'active' }] },
);
export type CertificationCycleCreate = z.infer<typeof CertificationCycleCreate>;

export const CertificationRecord = named(
  'CertificationRecord',
  z.strictObject({
    certificateNo: z.string().trim().min(1).max(60),
    issuedAt: IsoDate,
    expiresAt: IsoDate,
    certificationBody: z.string().trim().min(1).max(200),
    certifiedScope: z.string().trim().min(1).max(4000).optional(),
  }).refine((r) => r.expiresAt > r.issuedAt, { message: 'expiresAt must be after issuedAt', path: ['expiresAt'] }),
  'POST /ms/{ms}/certification body: the certificate after a stage2 or recertification audit with outcome recommended or recommended_with_conditions (Milestone 2 D.4)',
  {
    valid: [{ certificateNo: 'ISMS-2027-0031', issuedAt: '2027-03-20', expiresAt: '2030-03-19', certificationBody: 'PT Sertifikasi Nusantara' }, { certificateNo: 'QMS-88', issuedAt: '2027-01-10', expiresAt: '2030-01-09', certificationBody: 'Garuda Mutu', certifiedScope: 'Software development' }],
    invalid: [{ certificateNo: 'X', issuedAt: '2027-03-20', expiresAt: '2026-03-19', certificationBody: 'Y' }, { certificateNo: '', issuedAt: '2027-03-20', expiresAt: '2030-03-19', certificationBody: 'Y' }, { issuedAt: '2027-03-20' }],
  },
);
export type CertificationRecord = z.infer<typeof CertificationRecord>;

export const CycleTransitionRequest = named(
  'CycleTransitionRequest',
  z.strictObject({ to: z.enum(['certified', 'suspended', 'withdrawn', 'closed']), reason: z.string().trim().min(3).max(1000) }),
  'POST /ms/{ms}/certification-cycles/{id}/transitions body: the manual moves of J.8 (suspend, reinstate, withdraw, close an active cycle), each with a reason',
  { valid: [{ to: 'suspended', reason: 'Suspended by the certification body after the surveillance audit' }, { to: 'closed', reason: 'Project stopped' }], invalid: [{ to: 'suspended' }, { to: 'expired', reason: 'Lapsed' }, { to: 'closed', reason: '' }] },
);
export type CycleTransitionRequest = z.infer<typeof CycleTransitionRequest>;

export const adminMsListRoute = defineRoute({
  id: 'admin.ms.list',
  owner: 'WP-12',
  method: 'GET',
  path: '/api/v1/admin/management-systems',
  summary: 'Management systems of the organisation',
  auth: 'session',
  permission: 'ms.admin',
  scope: 'org',
  response: z.array(ManagementSystemView),
  errors: [],
});

export const adminMsCreateRoute = defineRoute({
  id: 'admin.ms.create',
  owner: 'WP-12',
  method: 'POST',
  path: '/api/v1/admin/management-systems',
  summary: 'Create a management system on an installed edition (ms.admin and pack.activate; BR-21, LIC-MS)',
  auth: 'session',
  permission: 'ms.admin',
  allOf: ['pack.activate'],
  scope: 'org',
  body: ManagementSystemCreate,
  response: ManagementSystemView,
  status: 201,
  errors: [409, 422],
  idempotent: true,
});

export const adminMsUpdateRoute = defineRoute({
  id: 'admin.ms.update',
  owner: 'WP-12',
  method: 'PATCH',
  path: '/api/v1/admin/management-systems/:id',
  summary: 'Change scope, certification body, colour, default repository or the setup and archive status',
  auth: 'session',
  permission: 'ms.admin',
  scope: 'org',
  params: IdParams,
  body: ManagementSystemPatch,
  response: ManagementSystemView,
  errors: [404, 409],
});

export const msTransitionRoute = defineRoute({
  id: 'ms.transition',
  owner: 'WP-12',
  method: 'POST',
  path: '/api/v1/ms/:ms/transitions',
  summary: 'Start or finish an edition transition of the system (feature edition_transition)',
  auth: 'session',
  permission: 'ms.transition',
  machine: 'management_system.status',
  scope: 'ms',
  msSource: 'path',
  params: MsParams,
  body: MsTransitionRequest,
  response: CommandResult,
  errors: [404, 409, 422],
});

const cert = { owner: 'M2-05' as const, auth: 'session' as const, scope: 'ms' as const, msSource: 'path' as const };

export const msCyclesListRoute = defineRoute({
  ...cert, id: 'ms.cycles.list', method: 'GET', path: '/api/v1/ms/:ms/certification-cycles',
  summary: 'Certification cycles of the system, newest first, with status, dates and certificate',
  permission: 'ms.read', params: MsParams, response: z.array(CertificationCycleItem), errors: [404],
});
export const msCyclesCreateRoute = defineRoute({
  ...cert, id: 'ms.cycles.create', method: 'POST', path: '/api/v1/ms/:ms/certification-cycles',
  summary: 'Start a certification cycle and its cycle items, or activate the planned one (one open cycle per system; audited certification_cycle.created)',
  permission: 'audit_event.manage', params: MsParams, body: CertificationCycleCreate, response: CommandResult, status: 201, errors: [404, 409, 422], idempotent: true,
});
export const msCertificationRoute = defineRoute({
  ...cert, id: 'ms.certification', method: 'POST', path: '/api/v1/ms/:ms/certification',
  summary: 'Record the certificate and move the cycle and the system to certified; a recertification closes the previous certified cycle (audited ms.certified)',
  permission: 'ms.transition', params: MsParams, body: CertificationRecord, response: CommandResult, errors: [404, 409, 422],
});
export const msCyclesTransitionRoute = defineRoute({
  ...cert, id: 'ms.cycles.transition', method: 'POST', path: '/api/v1/ms/:ms/certification-cycles/:id/transitions',
  summary: 'Suspend, reinstate or withdraw a certificate, or close an active cycle, with a reason (J.8; audited certification_cycle.transitioned)',
  permission: 'ms.transition', params: MsRecordParams, body: CycleTransitionRequest, response: CommandResult, errors: [404, 409, 412, 422], ifMatch: true,
});

export const routes: RouteDef[] = [
  adminMsListRoute, adminMsCreateRoute, adminMsUpdateRoute, msTransitionRoute,
  msCyclesListRoute, msCyclesCreateRoute, msCertificationRoute, msCyclesTransitionRoute,
];
