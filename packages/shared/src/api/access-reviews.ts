// Area `access-reviews` (Milestone 3 D.1, D.9, built by M3-07; contract written by M3-01): the periodic access review.
// One review per organisation opens on a schedule (every 3 months by default, 14 days to complete, H.9) or at once,
// with one part for the organisation (memberships, admin roles, linked company sign-in; decided by the Tenant Admins)
// and one part per management system (business roles and guest auditor grants; decided by the system's Management
// System Managers and Programme Owners). The review takes a snapshot of every right in force. Nobody decides on their
// own access (`REVIEW-OWN-ACCESS`). Revocations are applied through the existing services by people who hold those
// rights. A completed review is filed as evidence; for ISO/IEC 27001:2022 control A.5.18 (access rights) the sign-off
// proposes the evidence item of that control. A single Tenant Admin completes with the warning `REVIEW-SINGLE-ADMIN`.
import { z } from 'zod';
import { AccessReviewDecision, AccessReviewItemKind, AccessReviewPartStatus, AccessReviewStatus } from '../enums.js';
import { BinaryBody, CommandResult, IdParams, Instant, IsoDate, MsId, MsParams, MsRecordParams, Uuid, defineRoute, named } from './common.js';
import type { RouteDef } from './common.js';

const Person = z.object({ handle: z.string(), displayName: z.string() });
const NullablePerson = Person.nullable();
/** How often a review opens: every 1, 3, 6 or 12 months (H.9: 3 by default). */
const FrequencyMonths = z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)]);

const EXAMPLE_SETTINGS = { frequencyMonths: 3, nextDueOn: '2027-01-15', daysToComplete: 14, etag: 'W/"1793350800000"' } as const;

export const AccessReviewSettings = named(
  'AccessReviewSettings',
  z.object({
    frequencyMonths: FrequencyMonths,
    nextDueOn: IsoDate.nullable(),
    daysToComplete: z.int().min(1).max(60),
    /** Weak ETag of the settings row, also sent as the `ETag` header; the PUT takes it as `If-Match`. */
    etag: z.string(),
  }),
  'GET /admin/access-reviews/settings: how often a review opens, the next due date and the days to complete (Milestone 3 D.9)',
  { valid: [EXAMPLE_SETTINGS, { ...EXAMPLE_SETTINGS, frequencyMonths: 12, nextDueOn: null }], invalid: [{ ...EXAMPLE_SETTINGS, frequencyMonths: 2 }, { ...EXAMPLE_SETTINGS, daysToComplete: 0 }] },
);
export type AccessReviewSettings = z.infer<typeof AccessReviewSettings>;

export const AccessReviewSettingsPut = named(
  'AccessReviewSettingsPut',
  z.strictObject({
    frequencyMonths: FrequencyMonths,
    nextDueOn: IsoDate,
    daysToComplete: z.int().min(1).max(60),
  }),
  'PUT /admin/access-reviews/settings body (If-Match): frequency 1, 3, 6 or 12 months, the next due date and the days to complete',
  { valid: [{ frequencyMonths: 3, nextDueOn: '2027-01-15', daysToComplete: 14 }], invalid: [{ frequencyMonths: 4, nextDueOn: '2027-01-15', daysToComplete: 14 }, { frequencyMonths: 3, daysToComplete: 14 }, { frequencyMonths: 3, nextDueOn: '2027-01-15', daysToComplete: 90 }] },
);
export type AccessReviewSettingsPut = z.infer<typeof AccessReviewSettingsPut>;

export const AccessReviewProgress = named(
  'AccessReviewProgress',
  z.object({ items: z.int().min(0), decided: z.int().min(0), revocations: z.int().min(0), applied: z.int().min(0), parts: z.int().min(0), signedOff: z.int().min(0) }),
  'Progress of an access review: items decided, revocations applied or explained, parts signed off',
  { valid: [{ items: 210, decided: 180, revocations: 6, applied: 4, parts: 5, signedOff: 3 }], invalid: [{ items: -1, decided: 0, revocations: 0, applied: 0, parts: 0, signedOff: 0 }] },
);
export type AccessReviewProgress = z.infer<typeof AccessReviewProgress>;

const EXAMPLE_PROGRESS = { items: 210, decided: 180, revocations: 6, applied: 4, parts: 5, signedOff: 3 } as const;
const EXAMPLE_REVIEW = {
  id: '8b9c0d1e-2f3a-4b4c-9d5e-6f7a8b9c0d1e', reviewNo: 'AR-2026-Q4', status: 'open', openedOn: '2026-10-15', dueOn: '2026-10-29', openedBy: null,
  completedAt: null, completedBy: null, cancelReason: null, progress: EXAMPLE_PROGRESS,
} as const;

const reviewShape = {
  id: Uuid,
  reviewNo: z.string().min(1).max(20),
  status: AccessReviewStatus,
  openedOn: IsoDate,
  dueOn: IsoDate,
  /** Null when the schedule opened it. */
  openedBy: NullablePerson,
  completedAt: Instant.nullable(),
  completedBy: NullablePerson,
  cancelReason: z.string().nullable(),
  progress: AccessReviewProgress,
};

export const AccessReviewSummary = named(
  'AccessReviewSummary',
  z.object(reviewShape),
  'An access review with its status, dates and progress (Milestone 3 D.9)',
  { valid: [EXAMPLE_REVIEW, { ...EXAMPLE_REVIEW, status: 'completed', completedAt: '2026-10-28T03:00:00Z', completedBy: { handle: 'tenant.admin', displayName: 'Tenant Admin' } }], invalid: [{ ...EXAMPLE_REVIEW, status: 'closed' }] },
);
export type AccessReviewSummary = z.infer<typeof AccessReviewSummary>;

const EXAMPLE_ITEM = {
  id: '9c0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f', kind: 'business_role', subject: { handle: 'bagus', displayName: 'Bagus Prasetyo' }, ms: 'isms',
  role: 'domain_owner', grantedBy: { handle: 'tenant.admin', displayName: 'Tenant Admin' }, grantedAt: '2025-03-01T02:00:00Z', validUntil: null,
  lastSignInAt: '2026-10-14T02:00:00Z', decision: 'keep', decisionNote: null, decidedBy: { handle: 'rina', displayName: 'Rina Kusuma' },
  decidedAt: '2026-10-20T02:00:00Z', appliedAt: null, appliedBy: null, appliedAction: null, notAppliedReason: null, ownAccess: false,
} as const;

export const AccessReviewItemView = named(
  'AccessReviewItemView',
  z.object({
    id: Uuid,
    kind: AccessReviewItemKind,
    subject: Person,
    /** The system of a business role or guest auditor grant; null for organisation items. */
    ms: MsId.nullable(),
    /** The business role, admin role, provider slug or membership status the item reviews. */
    role: z.string().min(1).max(30).nullable(),
    grantedBy: NullablePerson,
    grantedAt: Instant.nullable(),
    validUntil: IsoDate.nullable(),
    lastSignInAt: Instant.nullable(),
    decision: AccessReviewDecision.nullable(),
    decisionNote: z.string().nullable(),
    decidedBy: NullablePerson,
    decidedAt: Instant.nullable(),
    appliedAt: Instant.nullable(),
    appliedBy: NullablePerson,
    appliedAction: z.string().nullable(),
    notAppliedReason: z.string().nullable(),
    /** The caller's own access, which the caller cannot decide (REVIEW-OWN-ACCESS). */
    ownAccess: z.boolean(),
  }),
  'One right of the snapshot of an access review: whose, which, granted by and when, last sign-in, the decision and how it was applied (Milestone 3 D.9)',
  { valid: [EXAMPLE_ITEM, { ...EXAMPLE_ITEM, kind: 'membership', ms: null, role: 'active', decision: null, decidedBy: null, decidedAt: null }], invalid: [{ ...EXAMPLE_ITEM, kind: 'api_key' }, { ...EXAMPLE_ITEM, decision: 'remove' }] },
);
export type AccessReviewItemView = z.infer<typeof AccessReviewItemView>;

const EXAMPLE_PART = {
  id: '0d1e2f3a-4b5c-4d6e-9f7a-8b9c0d1e2f3a', reviewId: '8b9c0d1e-2f3a-4b4c-9d5e-6f7a8b9c0d1e', reviewNo: 'AR-2026-Q4', reviewStatus: 'open', ms: 'isms',
  status: 'open', dueOn: '2026-10-29', items: 48, decided: 40, signedOffBy: null, signedOffAt: null, evidenceId: null,
} as const;

const partShape = {
  id: Uuid,
  reviewId: Uuid,
  reviewNo: z.string(),
  reviewStatus: AccessReviewStatus,
  /** Null for the organisation part. */
  ms: MsId.nullable(),
  status: AccessReviewPartStatus,
  dueOn: IsoDate,
  items: z.int().min(0),
  decided: z.int().min(0),
  signedOffBy: NullablePerson,
  signedOffAt: Instant.nullable(),
  evidenceId: Uuid.nullable(),
};

export const AccessReviewPartSummary = named(
  'AccessReviewPartSummary',
  z.object(partShape),
  'One part of an access review: the organisation or a system, its status, items decided and sign-off (Milestone 3 D.9)',
  { valid: [EXAMPLE_PART, { ...EXAMPLE_PART, ms: null, status: 'signed_off', signedOffBy: { handle: 'tenant.admin', displayName: 'Tenant Admin' }, signedOffAt: '2026-10-25T02:00:00Z' }], invalid: [{ ...EXAMPLE_PART, status: 'closed' }] },
);
export type AccessReviewPartSummary = z.infer<typeof AccessReviewPartSummary>;

export const AccessReviewPartDetail = named(
  'AccessReviewPartDetail',
  z.object({ ...partShape, rows: z.array(AccessReviewItemView), suggestedEvidence: z.object({ id: Uuid, code: z.string() }).nullable() }),
  'GET /ms/{ms}/access-reviews/{id}: the items of this system\'s part and, for ISO/IEC 27001, the evidence item of control A.5.18 proposed for the sign-off',
  { valid: [{ ...EXAMPLE_PART, rows: [EXAMPLE_ITEM], suggestedEvidence: { id: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e', code: 'EV-0518' } }, { ...EXAMPLE_PART, rows: [], suggestedEvidence: null }], invalid: [EXAMPLE_PART] },
);
export type AccessReviewPartDetail = z.infer<typeof AccessReviewPartDetail>;

export const AccessReviewDetail = named(
  'AccessReviewDetail',
  z.object({
    ...reviewShape,
    organisationPart: AccessReviewPartDetail,
    parts: z.array(AccessReviewPartSummary),
    /** Decided revocations and changes not yet applied or explained, across every part. */
    pendingApplications: z.array(AccessReviewItemView),
  }),
  'GET /admin/access-reviews/{id}: the organisation part with its items, the status of every system part, and the decided revocations still to apply',
  {
    valid: [{ ...EXAMPLE_REVIEW, organisationPart: { ...EXAMPLE_PART, ms: null, rows: [], suggestedEvidence: null }, parts: [EXAMPLE_PART], pendingApplications: [] }],
    invalid: [EXAMPLE_REVIEW],
  },
);
export type AccessReviewDetail = z.infer<typeof AccessReviewDetail>;

export const AccessReviewItemParams = named(
  'AccessReviewItemParams',
  z.strictObject({ id: Uuid, itemId: Uuid }),
  'Path parameters {id} (the access review) and {itemId} (one item of it)',
  { valid: [{ id: '8b9c0d1e-2f3a-4b4c-9d5e-6f7a8b9c0d1e', itemId: '9c0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f' }], invalid: [{ id: '8b9c0d1e-2f3a-4b4c-9d5e-6f7a8b9c0d1e' }, { id: 'x', itemId: 'y' }] },
);
export type AccessReviewItemParams = z.infer<typeof AccessReviewItemParams>;

export const MsAccessReviewItemParams = named(
  'MsAccessReviewItemParams',
  z.strictObject({ ms: MsId, id: Uuid, itemId: Uuid }),
  'Path parameters {ms}, {id} (the access review) and {itemId} (one item of this system\'s part)',
  { valid: [{ ms: 'isms', id: '8b9c0d1e-2f3a-4b4c-9d5e-6f7a8b9c0d1e', itemId: '9c0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f' }], invalid: [{ ms: 'isms', id: '8b9c0d1e-2f3a-4b4c-9d5e-6f7a8b9c0d1e' }] },
);
export type MsAccessReviewItemParams = z.infer<typeof MsAccessReviewItemParams>;

export const AccessReviewDecide = named(
  'AccessReviewDecide',
  z.strictObject({ decision: AccessReviewDecision, note: z.string().trim().min(1).max(500).optional() })
    .refine((d) => d.decision !== 'change' || d.note !== undefined, { message: 'A change says what changes', path: ['note'] }),
  'Decision on one item: keep, change (with a note, for example a shorter end date) or revoke; refused on one\'s own access with REVIEW-OWN-ACCESS',
  { valid: [{ decision: 'keep' }, { decision: 'revoke', note: 'Left the project in September' }, { decision: 'change', note: 'End the auditor grant on 30 Nov' }], invalid: [{ decision: 'change' }, { decision: 'remove' }, {}] },
);
export type AccessReviewDecide = z.infer<typeof AccessReviewDecide>;

export const AccessReviewApply = named(
  'AccessReviewApply',
  z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('apply') }),
    z.strictObject({ action: z.literal('mark_applied'), note: z.string().trim().min(1).max(500).optional() }),
    z.strictObject({ action: z.literal('not_applied'), reason: z.string().trim().min(1).max(500) }),
  ]),
  'Apply a decided revocation through the existing services, record that a change was applied on its own screen, or record why it is not applied',
  { valid: [{ action: 'apply' }, { action: 'mark_applied', note: 'End date set to 30 Nov on Auditor access' }, { action: 'not_applied', reason: 'Still needed for the open audit' }], invalid: [{ action: 'not_applied' }, { action: 'revoke' }, {}] },
);
export type AccessReviewApply = z.infer<typeof AccessReviewApply>;

export const AccessReviewCancel = named('AccessReviewCancel', z.strictObject({ reason: z.string().trim().min(1).max(500) }), 'POST /admin/access-reviews/{id}/cancel body', {
  valid: [{ reason: 'Opened by mistake; the quarterly review opens next week' }],
  invalid: [{}, { reason: '' }],
});
export type AccessReviewCancel = z.infer<typeof AccessReviewCancel>;

export const AccessReviewSignOff = named(
  'AccessReviewSignOff',
  z.strictObject({ evidenceId: Uuid.optional() }),
  'POST /ms/{ms}/access-reviews/{id}/sign-off body: the evidence item that receives this system\'s rows when the review completes',
  { valid: [{}, { evidenceId: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e' }], invalid: [{ evidenceId: 'EV-0518' }] },
);
export type AccessReviewSignOff = z.infer<typeof AccessReviewSignOff>;

const manage = { owner: 'M3-07' as const, auth: 'session' as const, permission: 'access_review.manage' as const, scope: 'org' as const };
const decide = { owner: 'M3-07' as const, auth: 'session' as const, permission: 'access_review.decide' as const, scope: 'ms' as const, msSource: 'path' as const };

export const accessReviewsSettingsGetRoute = defineRoute({
  ...manage, id: 'access-reviews.settings.get', method: 'GET', path: '/api/v1/admin/access-reviews/settings',
  summary: 'Frequency, next due date and days to complete of the periodic access review, with its ETag',
  response: AccessReviewSettings, errors: [],
});
export const accessReviewsSettingsPutRoute = defineRoute({
  ...manage, id: 'access-reviews.settings.put', method: 'PUT', path: '/api/v1/admin/access-reviews/settings',
  summary: 'Change the frequency, next due date and days to complete (If-Match; audited access_review.settings_changed)',
  body: AccessReviewSettingsPut, response: AccessReviewSettings, errors: [412, 422], ifMatch: true,
});
export const accessReviewsListRoute = defineRoute({
  ...manage, id: 'access-reviews.list', method: 'GET', path: '/api/v1/admin/access-reviews',
  summary: 'Access reviews with status, dates and progress, newest first',
  response: z.array(AccessReviewSummary), errors: [],
});
export const accessReviewsCreateRoute = defineRoute({
  ...manage, id: 'access-reviews.create', method: 'POST', path: '/api/v1/admin/access-reviews',
  summary: 'Open an access review now with a snapshot of every right in force (409 when one is open; audited access_review.opened)',
  response: CommandResult, status: 201, errors: [409], idempotent: true,
});
export const accessReviewsGetRoute = defineRoute({
  ...manage, id: 'access-reviews.get', method: 'GET', path: '/api/v1/admin/access-reviews/:id',
  summary: 'The organisation part with its items, the status of every system part, and the decided revocations still to apply',
  params: IdParams, response: AccessReviewDetail, errors: [404],
});
export const accessReviewsDecideRoute = defineRoute({
  ...manage, id: 'access-reviews.decide', method: 'POST', path: '/api/v1/admin/access-reviews/:id/items/:itemId/decision',
  summary: 'Decide on an organisation item; refused on one\'s own access with REVIEW-OWN-ACCESS (audited access_review.item_decided)',
  params: AccessReviewItemParams, body: AccessReviewDecide, response: CommandResult, errors: [404, 409, 422],
});
export const accessReviewsApplyRoute = defineRoute({
  owner: 'M3-07', auth: 'session', permission: 'user.manage', scope: 'org', id: 'access-reviews.apply', method: 'POST', path: '/api/v1/admin/access-reviews/:id/items/:itemId/apply',
  summary: 'Apply a decided revocation or change through the existing role, membership and identity services, or record why it is not applied (audited access_review.item_applied)',
  params: AccessReviewItemParams, body: AccessReviewApply, response: CommandResult, errors: [404, 409, 422],
});
export const accessReviewsCompleteRoute = defineRoute({
  ...manage, id: 'access-reviews.complete', method: 'POST', path: '/api/v1/admin/access-reviews/:id/complete',
  summary: 'Complete when every part is signed off and every revocation applied or explained; stores the report and files each system\'s rows as evidence (warning REVIEW-SINGLE-ADMIN; audited access_review.completed)',
  params: IdParams, response: CommandResult, errors: [404, 409, 422],
});
export const accessReviewsCancelRoute = defineRoute({
  ...manage, id: 'access-reviews.cancel', method: 'POST', path: '/api/v1/admin/access-reviews/:id/cancel',
  summary: 'Cancel an open access review with a reason (audited access_review.cancelled)',
  params: IdParams, body: AccessReviewCancel, response: CommandResult, errors: [404, 409],
});
export const accessReviewsReportRoute = defineRoute({
  ...manage, id: 'access-reviews.report', method: 'GET', path: '/api/v1/admin/access-reviews/:id/report',
  summary: 'The access review as CSV, formula-neutralised (F.15)',
  params: IdParams, response: BinaryBody, responseType: 'text/csv', file: true, errors: [404],
});
export const accessReviewsMsListRoute = defineRoute({
  ...decide, id: 'access-reviews.ms.list', method: 'GET', path: '/api/v1/ms/:ms/access-reviews',
  summary: 'The parts of this system in every access review, open first',
  params: MsParams, response: z.array(AccessReviewPartSummary), errors: [404],
});
export const accessReviewsMsGetRoute = defineRoute({
  ...decide, id: 'access-reviews.ms.get', method: 'GET', path: '/api/v1/ms/:ms/access-reviews/:id',
  summary: 'The items of this system\'s part of an access review',
  params: MsRecordParams, response: AccessReviewPartDetail, errors: [404],
});
export const accessReviewsMsDecideRoute = defineRoute({
  ...decide, id: 'access-reviews.ms.decide', method: 'POST', path: '/api/v1/ms/:ms/access-reviews/:id/items/:itemId/decision',
  summary: 'Decide on an item of this system; refused on one\'s own access with REVIEW-OWN-ACCESS (audited access_review.item_decided)',
  params: MsAccessReviewItemParams, body: AccessReviewDecide, response: CommandResult, errors: [404, 409, 422],
});
export const accessReviewsMsApplyRoute = defineRoute({
  owner: 'M3-07', auth: 'session', permission: 'auditor_access.grant', scope: 'ms', msSource: 'path', id: 'access-reviews.ms.apply', method: 'POST',
  path: '/api/v1/ms/:ms/access-reviews/:id/items/:itemId/apply',
  summary: 'Revoke a guest auditor grant decided revoke, record a change as applied, or record why it is not applied (audited auditor_access.revoked and access_review.item_applied)',
  params: MsAccessReviewItemParams, body: AccessReviewApply, response: CommandResult, errors: [404, 409, 422],
});
export const accessReviewsMsSignOffRoute = defineRoute({
  ...decide, id: 'access-reviews.ms.sign-off', method: 'POST', path: '/api/v1/ms/:ms/access-reviews/:id/sign-off',
  summary: 'Sign off this system\'s part when every item is decided, naming the evidence item for its rows (audited access_review.signed_off)',
  params: MsRecordParams, body: AccessReviewSignOff, response: CommandResult, errors: [404, 409, 422],
});

export const routes: RouteDef[] = [
  accessReviewsSettingsGetRoute, accessReviewsSettingsPutRoute, accessReviewsListRoute, accessReviewsCreateRoute, accessReviewsGetRoute,
  accessReviewsDecideRoute, accessReviewsApplyRoute, accessReviewsCompleteRoute, accessReviewsCancelRoute, accessReviewsReportRoute,
  accessReviewsMsListRoute, accessReviewsMsGetRoute, accessReviewsMsDecideRoute, accessReviewsMsApplyRoute, accessReviewsMsSignOffRoute,
];
