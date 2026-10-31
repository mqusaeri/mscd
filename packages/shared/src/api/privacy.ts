// Area `privacy` (Milestone 3 D.1, D.6, built by M3-04; contract written by M3-01): requests from one person about
// their own personal data. The customer organisation is the controller and answers the person; a Tenant Admin records
// the request after checking who is asking (`privacy_request.manage`), the Management System Managers check their own
// systems for mentions of the person (`privacy_request.assist`), and the person can ask from "My account", download
// their own data and correct their own name and job title. Each request is due `privacy.request_due_hours` after it
// was received (72 by default, H.4). Erasure keeps the organisation's records under a pseudonym that only this
// organisation shows (D.6.5). Refusals: 422 `shared_account` (another active membership shares the account), 409
// `last_tenant_admin`, 422 rule `ERASE-OPEN-ITEMS` (J.6). The `me.` routes and `exports.me.create` need an active session
// only and act on the caller's own data.
import { z } from 'zod';
import { PrivacyChannel, PrivacyCheckStatus, PrivacyRequestStatus, PrivacyRequestType, PrivacySubjectKind } from '../enums.js';
import {
  CommandResult, EntityTypeName, IdParams, Instant, MsId, MsParams, MsRecordParams, NoBody, Uuid, defineRoute, named, pageOf, pageQueryShape,
} from './common.js';
import type { RouteDef } from './common.js';

/** Business number of a request: `PR-<year>-<nnn>`. */
export const PrivacyRequestNo = named('PrivacyRequestNo', z.string().regex(/^PR-\d{4}-\d{3,6}$/), 'Business number of a personal data request, PR-<year>-<nnn>', {
  valid: ['PR-2026-001', 'PR-2026-1042'],
  invalid: ['PR-26-1', 'pr-2026-001', 'PR-2026-01'],
});
export type PrivacyRequestNo = z.infer<typeof PrivacyRequestNo>;

const Person = z.object({ handle: z.string(), displayName: z.string() }).nullable();
const PersonName = z.string().trim().min(1).max(200);

export const PrivacySubjectInput = named(
  'PrivacySubjectInput',
  z.union([
    z.strictObject({ userId: Uuid }),
    z.strictObject({ name: PersonName, email: z.email().max(320).optional() }),
  ]),
  'The person a request is about: a member of the organisation by account id, or a person without an account by name and email',
  {
    valid: [{ userId: '9d1e2f3a-4b5c-4d6e-8f7a-8b9c0d1e2f3a' }, { name: 'Andi Wijaya' }, { name: 'Andi Wijaya', email: 'andi.wijaya@supplier.example' }],
    invalid: [{}, { userId: 'bagus' }, { name: '' }, { userId: '9d1e2f3a-4b5c-4d6e-8f7a-8b9c0d1e2f3a', name: 'Bagus' }],
  },
);
export type PrivacySubjectInput = z.infer<typeof PrivacySubjectInput>;

export const PrivacyRequestCreate = named(
  'PrivacyRequestCreate',
  z.strictObject({
    type: PrivacyRequestType,
    subject: PrivacySubjectInput,
    receivedAt: Instant,
    channel: PrivacyChannel.exclude(['self_service']),
    note: z.string().trim().min(1).max(2000).optional(),
  }),
  'POST /admin/privacy-requests body: the type, the person, when and how the request arrived, and a note; requests from My account use me.privacy-requests.create',
  {
    valid: [
      { type: 'access', subject: { userId: '9d1e2f3a-4b5c-4d6e-8f7a-8b9c0d1e2f3a' }, receivedAt: '2026-10-30T09:00:00Z', channel: 'email' },
      { type: 'erasure', subject: { name: 'Andi Wijaya', email: 'andi.wijaya@supplier.example' }, receivedAt: '2026-10-30T09:00:00Z', channel: 'letter', note: 'Former supplier contact' },
    ],
    invalid: [
      { type: 'delete', subject: { name: 'A' }, receivedAt: '2026-10-30T09:00:00Z', channel: 'email' },
      { type: 'access', subject: { name: 'A' }, receivedAt: '2026-10-30T09:00:00Z', channel: 'self_service' },
      { type: 'access', subject: { name: 'A' }, receivedAt: '30 Oct 2026', channel: 'email' },
    ],
  },
);
export type PrivacyRequestCreate = z.infer<typeof PrivacyRequestCreate>;

export const PrivacyRequestListQuery = named(
  'PrivacyRequestListQuery',
  z.strictObject({ ...pageQueryShape, status: PrivacyRequestStatus.optional(), type: PrivacyRequestType.optional(), q: z.string().trim().min(1).max(100).optional() }),
  'GET /admin/privacy-requests query: status and type filters, search by number or name, paging',
  { valid: [{}, { status: 'in_progress', type: 'erasure', q: 'PR-2026', page: '2' }], invalid: [{ status: 'open' }, { sort: 'due' }] },
);
export type PrivacyRequestListQuery = z.infer<typeof PrivacyRequestListQuery>;

const EXAMPLE_SUBJECT = { kind: 'member', userId: '9d1e2f3a-4b5c-4d6e-8f7a-8b9c0d1e2f3a', handle: 'bagus', name: 'Bagus Prasetyo', email: 'bagus.prasetyo@nusantaradigital.co.id' } as const;
const EXAMPLE_REQUEST = {
  id: '6b7c8d9e-0f1a-4b2c-8d3e-4f5a6b7c8d9e', requestNo: 'PR-2026-004', type: 'access', status: 'in_progress', subject: EXAMPLE_SUBJECT, channel: 'email',
  receivedAt: '2026-10-30T09:00:00Z', dueAt: '2026-11-02T09:00:00Z', closedAt: null, handledBy: { handle: 'tenant.admin', displayName: 'Tenant Admin' },
  overdue: false, etag: 'W/"1793350800000"',
} as const;

export const PrivacySubjectView = named(
  'PrivacySubjectView',
  z.object({ kind: PrivacySubjectKind, userId: Uuid.nullable(), handle: z.string().nullable(), name: z.string(), email: z.string().nullable() }),
  'The person of a request as entered (the request keeps the name as proof that it was answered, D.6.5)',
  { valid: [EXAMPLE_SUBJECT, { kind: 'other', userId: null, handle: null, name: 'Andi Wijaya', email: null }], invalid: [{ ...EXAMPLE_SUBJECT, kind: 'guest' }] },
);
export type PrivacySubjectView = z.infer<typeof PrivacySubjectView>;

const requestShape = {
  id: Uuid,
  requestNo: PrivacyRequestNo,
  type: PrivacyRequestType,
  status: PrivacyRequestStatus,
  subject: PrivacySubjectView,
  channel: PrivacyChannel,
  receivedAt: Instant,
  dueAt: Instant,
  closedAt: Instant.nullable(),
  handledBy: Person,
  /** Open and past `dueAt`. */
  overdue: z.boolean(),
  /** Weak ETag of the request, for `If-Match` of the PATCH. */
  etag: z.string(),
};

export const PrivacyRequestItem = named(
  'PrivacyRequestItem',
  z.object(requestShape),
  'A personal data request in the list: number, type, status, person, channel, received and due times (Milestone 3 D.6)',
  { valid: [EXAMPLE_REQUEST, { ...EXAMPLE_REQUEST, status: 'received', handledBy: null }], invalid: [{ ...EXAMPLE_REQUEST, type: 'delete' }, { ...EXAMPLE_REQUEST, dueAt: null }] },
);
export type PrivacyRequestItem = z.infer<typeof PrivacyRequestItem>;

const EXAMPLE_CHECK = {
  id: '7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f', ms: 'isms', status: 'done', doneBy: { handle: 'rina', displayName: 'Rina Kusuma' },
  doneAt: '2026-10-31T04:00:00Z', note: 'Two risk descriptions edited; open items handed over',
} as const;

export const PrivacyCheckView = named(
  'PrivacyCheckView',
  z.object({ id: Uuid, ms: MsId, status: PrivacyCheckStatus, doneBy: Person, doneAt: Instant.nullable(), note: z.string().nullable() }),
  'One system check of a request: the system, its status, who checked it and the note (Milestone 3 D.6.4)',
  { valid: [EXAMPLE_CHECK, { ...EXAMPLE_CHECK, status: 'open', doneBy: null, doneAt: null, note: null }], invalid: [{ ...EXAMPLE_CHECK, status: 'closed' }] },
);
export type PrivacyCheckView = z.infer<typeof PrivacyCheckView>;

export const PrivacyRequestAction = named(
  'PrivacyRequestAction',
  z.object({ action: z.string().min(1).max(60), at: Instant, actor: Person }),
  'One step taken on a request, from its audit entries (privacy_request.created, .updated, .rectified, .restricted, .erased, .closed)',
  { valid: [{ action: 'privacy_request.created', at: '2026-10-30T09:05:00Z', actor: { handle: 'tenant.admin', displayName: 'Tenant Admin' } }], invalid: [{ action: '', at: '2026-10-30T09:05:00Z', actor: null }] },
);
export type PrivacyRequestAction = z.infer<typeof PrivacyRequestAction>;

export const PrivacyRequestDetail = named(
  'PrivacyRequestDetail',
  z.object({
    ...requestShape,
    note: z.string().nullable(),
    identityCheckNote: z.string().nullable(),
    identityCheckedBy: Person,
    outcome: z.string().nullable(),
    /** Counts of what was done (for example rows edited, roles revoked, audit entries redacted). */
    result: z.record(z.string(), z.int().min(0)).nullable(),
    checks: z.array(PrivacyCheckView),
    actions: z.array(PrivacyRequestAction),
    /** The background task of the person export of an access request, once queued. */
    exportTaskId: Uuid.nullable(),
  }),
  'GET /admin/privacy-requests/{id}: one request with its system checks, the steps taken and the result (Milestone 3 D.6)',
  {
    valid: [{ ...EXAMPLE_REQUEST, note: null, identityCheckNote: 'Identity checked by video call', identityCheckedBy: { handle: 'tenant.admin', displayName: 'Tenant Admin' }, outcome: null, result: null, checks: [EXAMPLE_CHECK], actions: [], exportTaskId: null }],
    invalid: [EXAMPLE_REQUEST],
  },
);
export type PrivacyRequestDetail = z.infer<typeof PrivacyRequestDetail>;

export const PrivacyRequestPatch = named(
  'PrivacyRequestPatch',
  z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('start'), identityCheckNote: z.string().trim().min(1).max(500) }),
    z.strictObject({ action: z.literal('refuse'), reason: z.string().trim().min(1).max(1000) }),
    z.strictObject({ action: z.literal('withdraw'), reason: z.string().trim().min(1).max(1000) }),
    z.strictObject({ action: z.literal('note'), note: z.string().trim().min(1).max(2000) }),
  ]),
  'PATCH /admin/privacy-requests/{id} body (If-Match): start work after the identity check, refuse or record a withdrawal with the reason, or add a note',
  {
    valid: [{ action: 'start', identityCheckNote: 'Identity checked by video call' }, { action: 'refuse', reason: 'The data is kept under a legal duty' }, { action: 'note', note: 'Called back on 31 Oct' }],
    invalid: [{ action: 'start' }, { action: 'close', outcome: 'x' }, { action: 'refuse', reason: '' }],
  },
);
export type PrivacyRequestPatch = z.infer<typeof PrivacyRequestPatch>;

const DisplayName = z.string().trim().min(1).max(150);
const JobTitle = z.string().trim().max(150).nullable();

export const PrivacyRectify = named(
  'PrivacyRectify',
  z.strictObject({ displayName: DisplayName.optional(), jobTitle: JobTitle.optional() })
    .refine((p) => p.displayName !== undefined || p.jobTitle !== undefined, { message: 'Give at least one field' }),
  'POST /admin/privacy-requests/{id}/rectify body: the corrected display name or job title (422 shared_account when the account has another active membership)',
  { valid: [{ displayName: 'Bagus Prasetyo' }, { jobTitle: null }], invalid: [{}, { email: 'x@y.z' }, { displayName: '' }] },
);
export type PrivacyRectify = z.infer<typeof PrivacyRectify>;

export const PrivacyErase = named('PrivacyErase', z.strictObject({ confirm: z.literal(true) }), 'POST /admin/privacy-requests/{id}/erase body: the erasure cannot be undone, so it is confirmed (D.6.5)', {
  valid: [{ confirm: true }],
  invalid: [{}, { confirm: false }],
});
export type PrivacyErase = z.infer<typeof PrivacyErase>;

export const PrivacyClose = named('PrivacyClose', z.strictObject({ outcome: z.string().trim().min(1).max(2000) }), 'POST /admin/privacy-requests/{id}/close body: the answer given to the person', {
  valid: [{ outcome: 'Copy of the data sent by email on 31 Oct 2026' }],
  invalid: [{}, { outcome: '' }],
});
export type PrivacyClose = z.infer<typeof PrivacyClose>;

const EXAMPLE_CHECK_ITEM = {
  id: '7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f', requestNo: 'PR-2026-004', type: 'erasure', subject: { name: 'Andi Wijaya', handle: null },
  dueAt: '2026-11-02T09:00:00Z', status: 'open', doneAt: null,
} as const;

export const PrivacyCheckItem = named(
  'PrivacyCheckItem',
  z.object({
    id: Uuid,
    requestNo: PrivacyRequestNo,
    type: PrivacyRequestType,
    subject: z.object({ name: z.string(), handle: z.string().nullable() }),
    dueAt: Instant,
    status: PrivacyCheckStatus,
    doneAt: Instant.nullable(),
  }),
  'A personal data check of this system: the request type, the person, the due time and the status (Milestone 3 D.6.4)',
  { valid: [EXAMPLE_CHECK_ITEM, { ...EXAMPLE_CHECK_ITEM, status: 'done', doneAt: '2026-10-31T04:00:00Z' }], invalid: [{ ...EXAMPLE_CHECK_ITEM, status: 'closed' }] },
);
export type PrivacyCheckItem = z.infer<typeof PrivacyCheckItem>;

const EXAMPLE_MENTION = { recordKind: 'risk', recordId: '8d9e0f1a-2b3c-4d4e-9f5a-6b7c8d9e0f1a', code: 'R-031', field: 'description', excerpt: '... reported by Andi Wijaya of the supplier ...' } as const;

export const PrivacyMention = named(
  'PrivacyMention',
  z.object({ recordKind: EntityTypeName, recordId: Uuid, code: z.string().nullable(), field: z.string().min(1).max(63), excerpt: z.string().max(300) }),
  'A record of this system whose text names the person: record kind, code, field and a short excerpt (Milestone 3 D.6.4)',
  { valid: [EXAMPLE_MENTION, { ...EXAMPLE_MENTION, code: null }], invalid: [{ ...EXAMPLE_MENTION, recordKind: 'Risk' }] },
);
export type PrivacyMention = z.infer<typeof PrivacyMention>;

export const PrivacyMentions = named(
  'PrivacyMentions',
  z.object({ items: z.array(PrivacyMention).max(500), truncated: z.boolean() }),
  'GET /ms/{ms}/privacy-checks/{id}/mentions: at most 500 mentions; truncated says there were more',
  { valid: [{ items: [EXAMPLE_MENTION], truncated: false }, { items: [], truncated: false }], invalid: [{ items: [] }] },
);
export type PrivacyMentions = z.infer<typeof PrivacyMentions>;

export const PrivacyCheckDone = named('PrivacyCheckDone', z.strictObject({ note: z.string().trim().min(1).max(500) }), 'POST /ms/{ms}/privacy-checks/{id}/done body: what was checked and edited in this system', {
  valid: [{ note: 'Two risk descriptions edited; open items handed over' }],
  invalid: [{}, { note: '' }],
});
export type PrivacyCheckDone = z.infer<typeof PrivacyCheckDone>;

const EXAMPLE_MY_REQUEST = {
  id: '6b7c8d9e-0f1a-4b2c-8d3e-4f5a6b7c8d9e', requestNo: 'PR-2026-004', type: 'rectification', status: 'received', receivedAt: '2026-10-30T09:00:00Z',
  dueAt: '2026-11-02T09:00:00Z', closedAt: null,
} as const;

export const MyPrivacyRequestItem = named(
  'MyPrivacyRequestItem',
  z.object({ id: Uuid, requestNo: PrivacyRequestNo, type: PrivacyRequestType, status: PrivacyRequestStatus, receivedAt: Instant, dueAt: Instant, closedAt: Instant.nullable() }),
  'One of the caller\'s own requests in the current organisation, with status and due time (Milestone 3 D.6.6)',
  { valid: [EXAMPLE_MY_REQUEST, { ...EXAMPLE_MY_REQUEST, status: 'completed', closedAt: '2026-10-31T02:00:00Z' }], invalid: [{ ...EXAMPLE_MY_REQUEST, status: 'open' }] },
);
export type MyPrivacyRequestItem = z.infer<typeof MyPrivacyRequestItem>;

export const MyPrivacyRequestCreate = named(
  'MyPrivacyRequestCreate',
  z.strictObject({ type: z.enum(['rectification', 'restriction', 'erasure']), note: z.string().trim().min(1).max(2000).optional() }),
  'POST /me/privacy-requests body: ask the organisation for a correction, a restriction or an erasure; a copy of one\'s own data is downloaded with exports.me.create',
  { valid: [{ type: 'erasure' }, { type: 'rectification', note: 'My surname is spelled Prasetyo' }], invalid: [{ type: 'access' }, {}] },
);
export type MyPrivacyRequestCreate = z.infer<typeof MyPrivacyRequestCreate>;

export const MyProfilePatch = named(
  'MyProfilePatch',
  z.strictObject({ displayName: DisplayName.optional(), jobTitle: JobTitle.optional() })
    .refine((p) => p.displayName !== undefined || p.jobTitle !== undefined, { message: 'Give at least one field' }),
  'PATCH /me/profile body: correct one\'s own display name or job title (H.6; audited user.updated)',
  { valid: [{ displayName: 'Bagus Prasetyo' }, { jobTitle: 'IT Infrastructure Lead' }, { jobTitle: null }], invalid: [{}, { email: 'x@y.z' }, { displayName: '' }] },
);
export type MyProfilePatch = z.infer<typeof MyProfilePatch>;

const admin = { owner: 'M3-04' as const, auth: 'session' as const, permission: 'privacy_request.manage' as const, scope: 'org' as const };
const assist = { owner: 'M3-04' as const, auth: 'session' as const, permission: 'privacy_request.assist' as const, scope: 'ms' as const, msSource: 'path' as const };
const self = { owner: 'M3-04' as const, auth: 'session' as const };

export const privacyRequestsListRoute = defineRoute({
  ...admin, id: 'privacy-requests.list', method: 'GET', path: '/api/v1/admin/privacy-requests',
  summary: 'Personal data requests with type, person, status, received and due times, paged and filtered',
  query: PrivacyRequestListQuery, response: pageOf(PrivacyRequestItem), errors: [],
});
export const privacyRequestsCreateRoute = defineRoute({
  ...admin, id: 'privacy-requests.create', method: 'POST', path: '/api/v1/admin/privacy-requests',
  summary: 'Record a request about one person; access and erasure open one check per system (audited privacy_request.created)',
  body: PrivacyRequestCreate, response: CommandResult, status: 201, errors: [404, 422], idempotent: true,
});
export const privacyRequestsGetRoute = defineRoute({
  ...admin, id: 'privacy-requests.get', method: 'GET', path: '/api/v1/admin/privacy-requests/:id',
  summary: 'One request with its system checks, the steps taken and the result',
  params: IdParams, response: PrivacyRequestDetail, errors: [404],
});
export const privacyRequestsUpdateRoute = defineRoute({
  ...admin, id: 'privacy-requests.update', method: 'PATCH', path: '/api/v1/admin/privacy-requests/:id',
  summary: 'Start work after the identity check, refuse or record a withdrawal with the reason, or add a note (409 transition-not-allowed; audited privacy_request.updated)',
  params: IdParams, body: PrivacyRequestPatch, response: CommandResult, errors: [404, 409, 412, 422], ifMatch: true,
});
export const privacyRequestsRectifyRoute = defineRoute({
  ...admin, id: 'privacy-requests.rectify', method: 'POST', path: '/api/v1/admin/privacy-requests/:id/rectify',
  summary: 'Correct the display name or job title of the person (422 shared_account; audited privacy_request.rectified)',
  params: IdParams, body: PrivacyRectify, response: CommandResult, errors: [404, 409, 422],
});
export const privacyRequestsRestrictRoute = defineRoute({
  ...admin, id: 'privacy-requests.restrict', method: 'POST', path: '/api/v1/admin/privacy-requests/:id/restrict',
  summary: 'Disable the membership of the person, also for an objection (409 last_tenant_admin; audited privacy_request.restricted)',
  params: IdParams, response: CommandResult, errors: [404, 409, 422],
});
export const privacyRequestsEraseRoute = defineRoute({
  ...admin, id: 'privacy-requests.erase', method: 'POST', path: '/api/v1/admin/privacy-requests/:id/erase',
  summary: 'Erase the person in this organisation under a pseudonym after every system check (422 ERASE-OPEN-ITEMS, 409 last_tenant_admin; audited privacy_request.erased)',
  params: IdParams, body: PrivacyErase, response: CommandResult, errors: [404, 409, 422],
});
export const privacyRequestsCloseRoute = defineRoute({
  ...admin, id: 'privacy-requests.close', method: 'POST', path: '/api/v1/admin/privacy-requests/:id/close',
  summary: 'Complete the request with the answer given (409 transition-not-allowed; audited privacy_request.closed)',
  params: IdParams, body: PrivacyClose, response: CommandResult, errors: [404, 409, 422],
});
export const personExportCreateRoute = defineRoute({
  ...admin, id: 'exports.person.create', method: 'POST', path: '/api/v1/admin/privacy-requests/:id/export',
  summary: 'Queue the export of the person of an access request (export_file kind personal_data); 202 with taskId, downloaded with exports.download',
  params: IdParams, response: CommandResult, status: 202, errors: [404, 409, 429], idempotent: true,
  rateLimits: [{ key: 'user', max: 10, windowSeconds: 3600 }],
});
export const privacyChecksListRoute = defineRoute({
  ...assist, id: 'privacy-checks.list', method: 'GET', path: '/api/v1/ms/:ms/privacy-checks',
  summary: 'The personal data checks of this system: request type, person, due time and status, open first',
  params: MsParams, response: z.array(PrivacyCheckItem), errors: [404],
});
export const privacyChecksMentionsRoute = defineRoute({
  ...assist, id: 'privacy-checks.mentions', method: 'GET', path: '/api/v1/ms/:ms/privacy-checks/:id/mentions',
  summary: 'Records of this system whose text names the person (case-insensitive name, email and handle), at most 500',
  params: MsRecordParams, response: PrivacyMentions, errors: [404],
});
export const privacyChecksDoneRoute = defineRoute({
  ...assist, id: 'privacy-checks.done', method: 'POST', path: '/api/v1/ms/:ms/privacy-checks/:id/done',
  summary: 'Mark this system checked and edited, with a note (audited privacy_check.done)',
  params: MsRecordParams, body: PrivacyCheckDone, response: CommandResult, errors: [404, 409],
});
export const mePrivacyRequestsListRoute = defineRoute({
  ...self, id: 'me.privacy-requests.list', method: 'GET', path: '/api/v1/me/privacy-requests',
  summary: 'The caller\'s own requests in the current organisation, with status and due time',
  response: z.array(MyPrivacyRequestItem), errors: [404],
});
export const mePrivacyRequestsCreateRoute = defineRoute({
  ...self, id: 'me.privacy-requests.create', method: 'POST', path: '/api/v1/me/privacy-requests',
  summary: 'Ask the organisation for a correction, restriction or erasure of one\'s own data (audited privacy_request.created; Tenant Admins get privacy_request_received)',
  body: MyPrivacyRequestCreate, response: CommandResult, status: 201, errors: [404, 409, 429], idempotent: true,
  rateLimits: [{ key: 'user', max: 5, windowSeconds: 3600 }],
});
export const meDataExportRoute = defineRoute({
  ...self, id: 'exports.me.create', method: 'POST', path: '/api/v1/me/data-export',
  summary: 'Queue the export of one\'s own data in the current organisation (kind personal_data); 202 with taskId, downloaded with exports.download',
  response: CommandResult, status: 202, errors: [404, 429], idempotent: true,
  rateLimits: [{ key: 'user', max: 10, windowSeconds: 3600 }],
});
export const meProfileRoute = defineRoute({
  ...self, id: 'me.profile', method: 'PATCH', path: '/api/v1/me/profile',
  summary: 'Correct one\'s own display name and job title (audited user.updated)',
  body: MyProfilePatch, response: NoBody, status: 204, errors: [422],
});

export const routes: RouteDef[] = [
  privacyRequestsListRoute, privacyRequestsCreateRoute, privacyRequestsGetRoute, privacyRequestsUpdateRoute, privacyRequestsRectifyRoute,
  privacyRequestsRestrictRoute, privacyRequestsEraseRoute, privacyRequestsCloseRoute, personExportCreateRoute,
  privacyChecksListRoute, privacyChecksMentionsRoute, privacyChecksDoneRoute,
  mePrivacyRequestsListRoute, mePrivacyRequestsCreateRoute, meDataExportRoute, meProfileRoute,
];
