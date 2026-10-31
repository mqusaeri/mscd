// Area `acknowledgements` (Milestone 3 D.1, D.7, built by M3-05; contract written by M3-01): read confirmation of
// policies. A document with `acknowledgement_required` opens a confirmation request when a new version is approved; a
// Management System Manager can also ask for confirmation of the current approved version. Each person in the
// audience opens the version (`me.acknowledgements.open`) and confirms it (`me.acknowledgements.confirm`, refused
// before opening with rule `ACK-OPEN-FIRST`, H.7). The manager sees the totals and, with `audit.pending.all`, the
// person list; Top Management and anyone with only `audit.pending.aggregate` see totals (product decision 2). Closing
// a request files the register as a new file of an evidence item. Audit terms: ISO/IEC 27001:2022 A.5.1 asks that
// policies are acknowledged by the people concerned; clause 7.3 of each standard asks for awareness.
import { z } from 'zod';
import { AcknowledgementRequestStatus, AcknowledgementRole, AcknowledgementScope, AcknowledgementStatus } from '../enums.js';
import { BinaryBody, CommandResult, Code, IdParams, Instant, IsoDate, MsId, MsParams, MsRecordParams, Uuid, defineRoute, named } from './common.js';
import type { RouteDef } from './common.js';
import { ObjectOpenResponse } from './files.js';

const Person = z.object({ handle: z.string(), displayName: z.string() });

export const AcknowledgementTotals = named(
  'AcknowledgementTotals',
  z.object({ audience: z.int().min(0), confirmed: z.int().min(0), pending: z.int().min(0), overdue: z.int().min(0), excused: z.int().min(0) }),
  'Totals of a confirmation request: the audience, confirmed, pending, overdue (pending past the due date) and excused people',
  { valid: [{ audience: 42, confirmed: 30, pending: 10, overdue: 4, excused: 2 }], invalid: [{ audience: 42, confirmed: -1, pending: 0, overdue: 0, excused: 0 }, { confirmed: 1 }] },
);
export type AcknowledgementTotals = z.infer<typeof AcknowledgementTotals>;

const EXAMPLE_TOTALS = { audience: 42, confirmed: 30, pending: 10, overdue: 4, excused: 2 } as const;
const EXAMPLE_REQUEST = {
  id: '9e0f1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b', ms: 'isms', document: { id: '0f1a2b3c-4d5e-4f6a-9b7c-8d9e0f1a2b3c', code: 'POL-01', title: 'Information Security Policy' },
  version: { id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', label: '4.0' }, status: 'open', audienceScope: 'system_roles', audienceRoles: null,
  dueOn: '2026-11-14', createdAt: '2026-10-31T02:00:00Z', lastRemindedAt: null, closedAt: null, evidenceId: null, totals: EXAMPLE_TOTALS,
} as const;

const requestShape = {
  id: Uuid,
  /** The document's primary system; the request shows in every system the document is linked to. */
  ms: MsId,
  document: z.object({ id: Uuid, code: Code, title: z.string() }),
  version: z.object({ id: Uuid, label: z.string() }),
  status: AcknowledgementRequestStatus,
  audienceScope: AcknowledgementScope,
  audienceRoles: z.array(AcknowledgementRole).nullable(),
  dueOn: IsoDate,
  createdAt: Instant,
  lastRemindedAt: Instant.nullable(),
  closedAt: Instant.nullable(),
  /** The evidence item the register was filed to when the request closed. */
  evidenceId: Uuid.nullable(),
  totals: AcknowledgementTotals,
};

export const AcknowledgementRequestItem = named(
  'AcknowledgementRequestItem',
  z.object(requestShape),
  'A confirmation request with its document, version, audience, due date and totals (Milestone 3 D.7)',
  { valid: [EXAMPLE_REQUEST, { ...EXAMPLE_REQUEST, status: 'closed', audienceScope: 'roles', audienceRoles: ['domain_owner'], closedAt: '2026-11-20T02:00:00Z' }], invalid: [{ ...EXAMPLE_REQUEST, status: 'done' }, { ...EXAMPLE_REQUEST, audienceRoles: ['external_auditor'] }] },
);
export type AcknowledgementRequestItem = z.infer<typeof AcknowledgementRequestItem>;

const EXAMPLE_PERSON = {
  person: { handle: 'bagus', displayName: 'Bagus Prasetyo' }, status: 'confirmed', openedAt: '2026-11-01T03:00:00Z', confirmedAt: '2026-11-01T03:05:00Z',
  reminderCount: 0, excusedReason: null, overdue: false,
} as const;

export const AcknowledgementPerson = named(
  'AcknowledgementPerson',
  z.object({
    person: Person,
    status: AcknowledgementStatus,
    openedAt: Instant.nullable(),
    confirmedAt: Instant.nullable(),
    reminderCount: z.int().min(0),
    excusedReason: z.string().nullable(),
    overdue: z.boolean(),
  }),
  'One person of a confirmation request: status, when they opened and confirmed the version, reminders, excusal reason',
  { valid: [EXAMPLE_PERSON, { ...EXAMPLE_PERSON, status: 'pending', openedAt: null, confirmedAt: null, reminderCount: 1, overdue: true }], invalid: [{ ...EXAMPLE_PERSON, status: 'read' }] },
);
export type AcknowledgementPerson = z.infer<typeof AcknowledgementPerson>;

export const AcknowledgementRequestDetail = named(
  'AcknowledgementRequestDetail',
  z.object({ ...requestShape, people: z.array(AcknowledgementPerson).optional() }),
  'GET /ms/{ms}/acknowledgement-requests/{id}: totals for every caller; the person list only with audit.pending.all (product decisions 2 and 3)',
  { valid: [EXAMPLE_REQUEST, { ...EXAMPLE_REQUEST, people: [EXAMPLE_PERSON] }], invalid: [{ ...EXAMPLE_REQUEST, people: [{ person: 'bagus' }] }] },
);
export type AcknowledgementRequestDetail = z.infer<typeof AcknowledgementRequestDetail>;

export const AcknowledgementAudience = named(
  'AcknowledgementAudience',
  z.strictObject({ scope: AcknowledgementScope, roles: z.array(AcknowledgementRole).min(1).optional() })
    .refine((a) => (a.scope === 'roles') === (a.roles !== undefined), { message: 'Scope roles names the roles; the other scopes name none', path: ['roles'] }),
  'Who is asked to confirm: the holders of a business role in the document\'s systems (default), the chosen roles, or every member with a business role in the organisation; never guests or external auditors',
  { valid: [{ scope: 'system_roles' }, { scope: 'roles', roles: ['domain_owner', 'risk_owner'] }], invalid: [{ scope: 'roles' }, { scope: 'organisation', roles: ['ms_manager'] }, { scope: 'everyone' }] },
);
export type AcknowledgementAudience = z.infer<typeof AcknowledgementAudience>;

export const AcknowledgementRequestCreate = named(
  'AcknowledgementRequestCreate',
  z.strictObject({ documentId: Uuid, audience: AcknowledgementAudience.optional(), dueDays: z.int().min(1).max(90).optional() }),
  'POST /ms/{ms}/acknowledgement-requests body: ask for confirmation of the current approved version; audience and due days default to the document\'s settings',
  { valid: [{ documentId: '0f1a2b3c-4d5e-4f6a-9b7c-8d9e0f1a2b3c' }, { documentId: '0f1a2b3c-4d5e-4f6a-9b7c-8d9e0f1a2b3c', audience: { scope: 'organisation' }, dueDays: 21 }], invalid: [{}, { documentId: 'POL-01' }, { documentId: '0f1a2b3c-4d5e-4f6a-9b7c-8d9e0f1a2b3c', dueDays: 120 }] },
);
export type AcknowledgementRequestCreate = z.infer<typeof AcknowledgementRequestCreate>;

export const AcknowledgementRequestClose = named(
  'AcknowledgementRequestClose',
  z.strictObject({ evidenceId: Uuid.optional() }),
  'POST /ms/{ms}/acknowledgement-requests/{id}/close body: stop reminders and, with an evidence item, file the register CSV as a new file of it',
  { valid: [{}, { evidenceId: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e' }], invalid: [{ evidenceId: 'EV-0101' }] },
);
export type AcknowledgementRequestClose = z.infer<typeof AcknowledgementRequestClose>;

const EXAMPLE_MINE = {
  id: '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f', requestId: '9e0f1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b', ms: 'isms',
  document: { code: 'POL-01', title: 'Information Security Policy' }, versionLabel: '4.0', status: 'pending', dueOn: '2026-11-14', openedAt: null,
  confirmedAt: null, overdue: false,
} as const;

export const MyAcknowledgementItem = named(
  'MyAcknowledgementItem',
  z.object({
    id: Uuid,
    requestId: Uuid,
    ms: MsId,
    document: z.object({ code: Code, title: z.string() }),
    versionLabel: z.string(),
    status: AcknowledgementStatus,
    dueOn: IsoDate,
    openedAt: Instant.nullable(),
    confirmedAt: Instant.nullable(),
    overdue: z.boolean(),
  }),
  'One of the caller\'s open or recent confirmations in the current organisation (Milestone 3 D.7)',
  { valid: [EXAMPLE_MINE, { ...EXAMPLE_MINE, status: 'confirmed', openedAt: '2026-11-01T03:00:00Z', confirmedAt: '2026-11-01T03:05:00Z' }], invalid: [{ ...EXAMPLE_MINE, status: 'read' }] },
);
export type MyAcknowledgementItem = z.infer<typeof MyAcknowledgementItem>;

const manage = { owner: 'M3-05' as const, auth: 'session' as const, permission: 'acknowledgement.manage' as const, scope: 'ms' as const, msSource: 'path' as const };
const self = { owner: 'M3-05' as const, auth: 'session' as const };

export const acknowledgementRequestsListRoute = defineRoute({
  owner: 'M3-05', auth: 'session', id: 'acknowledgement-requests.list', method: 'GET', path: '/api/v1/ms/:ms/acknowledgement-requests',
  summary: 'Confirmation requests of documents linked to this system, with document, version, due date and totals',
  anyOf: [{ permission: 'acknowledgement.manage', scope: 'ms' }, { permission: 'audit.pending.aggregate', scope: 'ms' }], msSource: 'path',
  params: MsParams, response: z.array(AcknowledgementRequestItem), errors: [404],
});
export const acknowledgementRequestsCreateRoute = defineRoute({
  ...manage, id: 'acknowledgement-requests.create', method: 'POST', path: '/api/v1/ms/:ms/acknowledgement-requests',
  summary: 'Ask for confirmation of the current approved version of a document; closes the open request of an earlier version (409 when the version has an open request; audited acknowledgement_request.created)',
  params: MsParams, body: AcknowledgementRequestCreate, response: CommandResult, status: 201, errors: [404, 409, 422], idempotent: true,
});
export const acknowledgementRequestsGetRoute = defineRoute({
  owner: 'M3-05', auth: 'session', id: 'acknowledgement-requests.get', method: 'GET', path: '/api/v1/ms/:ms/acknowledgement-requests/:id',
  summary: 'One confirmation request: totals for every caller, the person list only with audit.pending.all',
  anyOf: [{ permission: 'audit.pending.all', scope: 'ms' }, { permission: 'audit.pending.aggregate', scope: 'ms' }], msSource: 'path',
  params: MsRecordParams, response: AcknowledgementRequestDetail, errors: [404],
});
export const acknowledgementRequestsRemindRoute = defineRoute({
  ...manage, id: 'acknowledgement-requests.remind', method: 'POST', path: '/api/v1/ms/:ms/acknowledgement-requests/:id/remind',
  summary: 'Remind the pending people now, at most once a day (409 when reminded today or closed; audited acknowledgement_request.reminded)',
  params: MsRecordParams, response: CommandResult, errors: [404, 409],
});
export const acknowledgementRequestsCloseRoute = defineRoute({
  ...manage, id: 'acknowledgement-requests.close', method: 'POST', path: '/api/v1/ms/:ms/acknowledgement-requests/:id/close',
  summary: 'Stop reminders and file the register as a new file of the evidence item (audited acknowledgement_request.closed)',
  params: MsRecordParams, body: AcknowledgementRequestClose, response: CommandResult, errors: [404, 409, 422],
});
export const acknowledgementRequestsExportRoute = defineRoute({
  owner: 'M3-05', auth: 'session', id: 'acknowledgement-requests.export', method: 'GET', path: '/api/v1/ms/:ms/acknowledgement-requests/:id/export',
  summary: 'The confirmation register as CSV, formula-neutralised (F.15)',
  permission: 'audit.pending.all', scope: 'ms', msSource: 'path',
  params: MsRecordParams, response: BinaryBody, responseType: 'text/csv', file: true, errors: [404],
});
export const meAcknowledgementsRoute = defineRoute({
  ...self, id: 'me.acknowledgements', method: 'GET', path: '/api/v1/me/acknowledgements',
  summary: 'The caller\'s open and recent confirmations in the current organisation',
  response: z.array(MyAcknowledgementItem), errors: [404],
});
export const meAcknowledgementsOpenRoute = defineRoute({
  ...self, id: 'me.acknowledgements.open', method: 'POST', path: '/api/v1/me/acknowledgements/:id/open',
  summary: 'A short-lived address of the version\'s file for a person in the audience; records opened_at (audited acknowledgement.opened and file.opened)',
  params: IdParams, response: ObjectOpenResponse, errors: [404, 409],
});
export const meAcknowledgementsConfirmRoute = defineRoute({
  ...self, id: 'me.acknowledgements.confirm', method: 'POST', path: '/api/v1/me/acknowledgements/:id/confirm',
  summary: 'Confirm the version: "I have read and understood this document" (422 ACK-OPEN-FIRST before opening; audited acknowledgement.confirmed)',
  params: IdParams, response: CommandResult, errors: [404, 409, 422],
});

export const routes: RouteDef[] = [
  acknowledgementRequestsListRoute, acknowledgementRequestsCreateRoute, acknowledgementRequestsGetRoute, acknowledgementRequestsRemindRoute,
  acknowledgementRequestsCloseRoute, acknowledgementRequestsExportRoute, meAcknowledgementsRoute, meAcknowledgementsOpenRoute, meAcknowledgementsConfirmRoute,
];
