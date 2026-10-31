// Area `retention` (Milestone 3 D.1, D.8, built by M3-06; contract written by M3-01): retention periods and the
// disposal review. Each management system has a retention period per record class (and per document type for
// document versions), 36 months by default (H.8). When a period ends the daily job `retention.review` opens a review;
// a manager keeps, extends or proposes disposal (rules `RET-HOLD`, `RET-NOT-DUE`, `RET-CURRENT`), and a second person
// with `retention.approve` approves the disposal (`SOD-SELF-APPROVE`), which runs at once. A legal hold keeps an item
// whatever its period says. The disposal register is the evidence for ISO/IEC 27001:2022 A.5.33 and clause 7.5.3.
import { z } from 'zod';
import { DisposalFileAction, RetentionDecision, RetentionRecordClass, RetentionReviewStatus } from '../enums.js';
import {
  BinaryBody, CommandResult, IsoDate, Instant, MsId, MsParams, MsRecordParams, Uuid, defineRoute, named, pageOf, pageQueryShape,
} from './common.js';
import type { RouteDef } from './common.js';

const Person = z.object({ handle: z.string(), displayName: z.string() }).nullable();
/** A `doc_type` lookup code of the pack (policy, standard, procedure, plan, register, record, form). */
const DocType = z.string().regex(/^[a-z][a-z0-9_]{0,19}$/);
const RetainMonths = z.int().min(1).max(1200);

const EXAMPLE_RULE = { recordClass: 'document_version', docType: 'policy', retainMonths: 36, source: 'default', basis: null } as const;

export const RetentionRuleItem = named(
  'RetentionRuleItem',
  z.object({
    recordClass: RetentionRecordClass,
    docType: DocType.nullable(),
    retainMonths: RetainMonths,
    /** `default` (36 months, H.8) or `set` by a manager of this system. */
    source: z.enum(['default', 'set']),
    basis: z.string().nullable(),
  }),
  'The retention period in force for a record class (and document type) of this system, marked default or set (Milestone 3 D.8)',
  {
    valid: [EXAMPLE_RULE, { recordClass: 'finding', docType: null, retainMonths: 60, source: 'set', basis: 'Customer contract clause 12.3' }],
    invalid: [{ ...EXAMPLE_RULE, recordClass: 'risk' }, { ...EXAMPLE_RULE, retainMonths: 0 }, { ...EXAMPLE_RULE, source: 'pack' }],
  },
);
export type RetentionRuleItem = z.infer<typeof RetentionRuleItem>;

export const RetentionRuleParams = named(
  'RetentionRuleParams',
  z.strictObject({ ms: MsId, recordClass: RetentionRecordClass }),
  'Path parameters {ms} and {recordClass}',
  { valid: [{ ms: 'isms', recordClass: 'evidence_file' }], invalid: [{ ms: 'isms', recordClass: 'risk' }, { ms: 'isms' }] },
);
export type RetentionRuleParams = z.infer<typeof RetentionRuleParams>;

export const RetentionRulePut = named(
  'RetentionRulePut',
  z.strictObject({ docType: DocType.optional(), retainMonths: RetainMonths.nullable(), basis: z.string().trim().min(1).max(500) }),
  'PUT /ms/{ms}/retention/rules/{recordClass} body: the period in months (null resets it to the default) and why; docType is required for document_version and refused otherwise',
  {
    valid: [{ retainMonths: 84, basis: 'Indonesian tax law: 10 years for financial records' }, { docType: 'record', retainMonths: null, basis: 'Back to the default' }],
    invalid: [{ retainMonths: 0, basis: 'x' }, { retainMonths: 36 }, { retainMonths: 36, basis: '' }],
  },
);
export type RetentionRulePut = z.infer<typeof RetentionRulePut>;

export const RetentionReviewListQuery = named(
  'RetentionReviewListQuery',
  z.strictObject({ ...pageQueryShape, status: RetentionReviewStatus.optional(), recordClass: RetentionRecordClass.optional() }),
  'GET /ms/{ms}/retention/reviews query: status and record class filters, paging',
  { valid: [{}, { status: 'open', recordClass: 'evidence_file', page: '2' }], invalid: [{ status: 'closed' }, { sort: 'date' }] },
);
export type RetentionReviewListQuery = z.infer<typeof RetentionReviewListQuery>;

const EXAMPLE_REVIEW = {
  id: '4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a', recordClass: 'evidence_file', itemId: '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b', itemCode: 'EV-0313',
  itemTitle: 'Backup job log & restore test (Q1 2023)', retentionEndsOn: '2026-09-30', status: 'awaiting_approval', decision: 'dispose',
  decidedBy: { handle: 'rina', displayName: 'Rina Kusuma' }, decidedAt: '2026-10-31T02:00:00Z', reason: 'Replaced by later logs; period over',
  keepUntil: null, approvedBy: null, approvedAt: null, rejectedNote: null, disposedAt: null, fileAction: null, fileRemovedAt: null, onHold: false,
} as const;

const reviewShape = {
  id: Uuid,
  recordClass: RetentionRecordClass,
  itemId: Uuid,
  itemCode: z.string().nullable(),
  itemTitle: z.string().nullable(),
  retentionEndsOn: IsoDate,
  status: RetentionReviewStatus,
  decision: RetentionDecision.nullable(),
  decidedBy: Person,
  decidedAt: Instant.nullable(),
  reason: z.string().nullable(),
  keepUntil: IsoDate.nullable(),
  approvedBy: Person,
  approvedAt: Instant.nullable(),
  rejectedNote: z.string().nullable(),
  disposedAt: Instant.nullable(),
  fileAction: DisposalFileAction.nullable(),
  /** When the owner recorded that the file was deleted in the customer's repository. */
  fileRemovedAt: Instant.nullable(),
};

export const RetentionReviewItem = named(
  'RetentionReviewItem',
  z.object({ ...reviewShape, onHold: z.boolean() }),
  'A disposal review: the item, its retention end, the decision, the approval and the file action (Milestone 3 D.8)',
  {
    valid: [EXAMPLE_REVIEW, { ...EXAMPLE_REVIEW, status: 'open', decision: null, decidedBy: null, decidedAt: null, reason: null }],
    invalid: [{ ...EXAMPLE_REVIEW, status: 'deleted' }, { ...EXAMPLE_REVIEW, decision: 'archive' }],
  },
);
export type RetentionReviewItem = z.infer<typeof RetentionReviewItem>;

export const RetentionDecide = named(
  'RetentionDecide',
  z.strictObject({
    ids: z.array(Uuid).min(1).max(200),
    decision: RetentionDecision,
    reason: z.string().trim().min(1).max(1000),
    keepUntil: IsoDate.optional(),
    extendMonths: RetainMonths.optional(),
  })
    .refine((d) => (d.decision === 'keep') === (d.keepUntil !== undefined), { message: 'Keep needs keepUntil; the other decisions take none', path: ['keepUntil'] })
    .refine((d) => (d.decision === 'extend') === (d.extendMonths !== undefined), { message: 'Extend needs extendMonths; the other decisions take none', path: ['extendMonths'] }),
  'POST /ms/{ms}/retention/reviews/decide body: keep until a date, extend by months, or propose disposal of the selected reviews, with the reason',
  {
    valid: [
      { ids: ['4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a'], decision: 'dispose', reason: 'Replaced by later logs; period over' },
      { ids: ['4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a'], decision: 'keep', reason: 'Needed for the 2027 recertification', keepUntil: '2027-12-31' },
      { ids: ['4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a'], decision: 'extend', reason: 'Open customer dispute', extendMonths: 12 },
    ],
    invalid: [
      { ids: [], decision: 'dispose', reason: 'x' },
      { ids: ['4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a'], decision: 'keep', reason: 'x' },
      { ids: ['4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a'], decision: 'dispose', reason: 'x', extendMonths: 3 },
    ],
  },
);
export type RetentionDecide = z.infer<typeof RetentionDecide>;

export const RetentionNote = named('RetentionNote', z.strictObject({ note: z.string().trim().min(1).max(500) }), 'POST /ms/{ms}/retention/reviews/{id}/reject body: why the disposal goes back to review', {
  valid: [{ note: 'The auditor asked to keep it until the next audit' }],
  invalid: [{}, { note: '' }],
});
export type RetentionNote = z.infer<typeof RetentionNote>;

export const RetentionRegisterQuery = named(
  'RetentionRegisterQuery',
  z.strictObject({ ...pageQueryShape, format: z.literal('csv').optional() }),
  'GET /ms/{ms}/retention/register query: paging, or format=csv for the whole register as CSV',
  { valid: [{}, { page: '2' }, { format: 'csv' }], invalid: [{ format: 'xlsx' }] },
);
export type RetentionRegisterQuery = z.infer<typeof RetentionRegisterQuery>;

export const RetentionRegisterItem = named(
  'RetentionRegisterItem',
  z.object({ ...reviewShape, retainMonths: RetainMonths }),
  'A decided disposal review in the disposal register: item, class, period, decision, reason, decider, approver, dates and file action',
  {
    valid: [{ ...EXAMPLE_REVIEW, status: 'disposed', approvedBy: { handle: 'wulan', displayName: 'Wulan Hartono' }, approvedAt: '2026-10-31T05:00:00Z', disposedAt: '2026-10-31T05:00:00Z', fileAction: 'vault_content_deleted', retainMonths: 36 }],
    invalid: [EXAMPLE_REVIEW],
  },
);
export type RetentionRegisterItem = z.infer<typeof RetentionRegisterItem>;

const EXAMPLE_HOLD = {
  id: '6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c', recordClass: 'finding', itemId: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d', itemCode: 'F-2025-07',
  reason: 'Legal claim by a former supplier', setBy: { handle: 'rina', displayName: 'Rina Kusuma' }, setAt: '2026-10-01T02:00:00Z', releasedBy: null,
  releasedAt: null, releaseReason: null,
} as const;

export const RetentionHoldItem = named(
  'RetentionHoldItem',
  z.object({
    id: Uuid,
    recordClass: RetentionRecordClass,
    itemId: Uuid,
    itemCode: z.string().nullable(),
    reason: z.string(),
    setBy: Person,
    setAt: Instant,
    releasedBy: Person,
    releasedAt: Instant.nullable(),
    releaseReason: z.string().nullable(),
  }),
  'A legal hold: it keeps an item whatever its retention period says until released with a reason (Milestone 3 D.8)',
  { valid: [EXAMPLE_HOLD, { ...EXAMPLE_HOLD, releasedBy: { handle: 'rina', displayName: 'Rina Kusuma' }, releasedAt: '2026-10-30T02:00:00Z', releaseReason: 'Claim settled' }], invalid: [{ ...EXAMPLE_HOLD, recordClass: 'risk' }] },
);
export type RetentionHoldItem = z.infer<typeof RetentionHoldItem>;

export const RetentionHoldCreate = named(
  'RetentionHoldCreate',
  z.strictObject({ recordClass: RetentionRecordClass, itemId: Uuid, reason: z.string().trim().min(1).max(500) }),
  'POST /ms/{ms}/retention/holds body: keep an item whatever its period says; a hold takes an item with an open review out of the review list',
  { valid: [{ recordClass: 'finding', itemId: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d', reason: 'Legal claim by a former supplier' }], invalid: [{ recordClass: 'finding', itemId: 'F-2025-07', reason: 'x' }, { recordClass: 'finding', itemId: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d' }] },
);
export type RetentionHoldCreate = z.infer<typeof RetentionHoldCreate>;

export const RetentionHoldRelease = named('RetentionHoldRelease', z.strictObject({ reason: z.string().trim().min(1).max(500) }), 'POST /ms/{ms}/retention/holds/{id}/release body', {
  valid: [{ reason: 'Claim settled' }],
  invalid: [{}, { reason: '' }],
});
export type RetentionHoldRelease = z.infer<typeof RetentionHoldRelease>;

/** `retention.manage` or `retention.approve` in the system of the path (the reads of the screen). */
const manageOrApprove = [{ permission: 'retention.manage', scope: 'ms' }, { permission: 'retention.approve', scope: 'ms' }] as const;
const read = { owner: 'M3-06' as const, auth: 'session' as const, anyOf: manageOrApprove, msSource: 'path' as const };
const manage = { owner: 'M3-06' as const, auth: 'session' as const, permission: 'retention.manage' as const, scope: 'ms' as const, msSource: 'path' as const };
const approve = { owner: 'M3-06' as const, auth: 'session' as const, permission: 'retention.approve' as const, scope: 'ms' as const, msSource: 'path' as const };

export const retentionRulesListRoute = defineRoute({
  ...read, id: 'retention.rules.list', method: 'GET', path: '/api/v1/ms/:ms/retention/rules',
  summary: 'The retention period in force per record class (and document type), marked default or set',
  params: MsParams, response: z.array(RetentionRuleItem), errors: [404],
});
export const retentionRulesPutRoute = defineRoute({
  ...manage, id: 'retention.rules.put', method: 'PUT', path: '/api/v1/ms/:ms/retention/rules/:recordClass',
  summary: 'Set or reset the retention period of a record class with its basis (audited retention_rule.changed)',
  params: RetentionRuleParams, body: RetentionRulePut, response: CommandResult, errors: [404, 422],
});
export const retentionReviewsListRoute = defineRoute({
  ...read, id: 'retention.reviews.list', method: 'GET', path: '/api/v1/ms/:ms/retention/reviews',
  summary: 'Disposal reviews by status, paged',
  params: MsParams, query: RetentionReviewListQuery, response: pageOf(RetentionReviewItem), errors: [404],
});
export const retentionReviewsDecideRoute = defineRoute({
  ...manage, id: 'retention.reviews.decide', method: 'POST', path: '/api/v1/ms/:ms/retention/reviews/decide',
  summary: 'Keep, extend, or propose disposal of the selected reviews (422 RET-HOLD, RET-NOT-DUE, RET-CURRENT; audited retention_review.decided)',
  params: MsParams, body: RetentionDecide, response: CommandResult, errors: [404, 409, 422],
});
export const retentionReviewsApproveRoute = defineRoute({
  ...approve, id: 'retention.reviews.approve', method: 'POST', path: '/api/v1/ms/:ms/retention/reviews/:id/approve',
  summary: 'A second person approves a disposal, which then runs at once; the proposer is refused with SOD-SELF-APPROVE (audited retention_review.approved and record.disposed)',
  params: MsRecordParams, response: CommandResult, errors: [404, 409, 422],
});
export const retentionReviewsRejectRoute = defineRoute({
  ...approve, id: 'retention.reviews.reject', method: 'POST', path: '/api/v1/ms/:ms/retention/reviews/:id/reject',
  summary: 'Send a disposal back to review with a note (audited retention_review.rejected)',
  params: MsRecordParams, body: RetentionNote, response: CommandResult, errors: [404, 409],
});
export const retentionReviewsFileRemovedRoute = defineRoute({
  ...manage, id: 'retention.reviews.file-removed', method: 'POST', path: '/api/v1/ms/:ms/retention/reviews/:id/file-removed',
  summary: 'Record that the owner deleted the file in the customer\'s repository (audited retention_review.file_removed)',
  params: MsRecordParams, response: CommandResult, errors: [404, 409],
});
export const retentionRegisterRoute = defineRoute({
  ...read, id: 'retention.register', method: 'GET', path: '/api/v1/ms/:ms/retention/register',
  summary: 'The disposal register: decided reviews, paged, or with format=csv the whole register as a CSV attachment (formula-neutralised, F.15)',
  params: MsParams, query: RetentionRegisterQuery, response: z.union([pageOf(RetentionRegisterItem), BinaryBody]), errors: [404],
});
export const retentionHoldsListRoute = defineRoute({
  ...read, id: 'retention.holds.list', method: 'GET', path: '/api/v1/ms/:ms/retention/holds',
  summary: 'Legal holds in force and released',
  params: MsParams, response: z.array(RetentionHoldItem), errors: [404],
});
export const retentionHoldsCreateRoute = defineRoute({
  ...manage, id: 'retention.holds.create', method: 'POST', path: '/api/v1/ms/:ms/retention/holds',
  summary: 'Keep an item whatever its retention period says (409 when it is already held; audited retention_hold.created)',
  params: MsParams, body: RetentionHoldCreate, response: CommandResult, status: 201, errors: [404, 409], idempotent: true,
});
export const retentionHoldsReleaseRoute = defineRoute({
  ...manage, id: 'retention.holds.release', method: 'POST', path: '/api/v1/ms/:ms/retention/holds/:id/release',
  summary: 'Release a legal hold with a reason (audited retention_hold.released)',
  params: MsRecordParams, body: RetentionHoldRelease, response: CommandResult, errors: [404, 409],
});

export const routes: RouteDef[] = [
  retentionRulesListRoute, retentionRulesPutRoute, retentionReviewsListRoute, retentionReviewsDecideRoute, retentionReviewsApproveRoute,
  retentionReviewsRejectRoute, retentionReviewsFileRemovedRoute, retentionRegisterRoute, retentionHoldsListRoute, retentionHoldsCreateRoute,
  retentionHoldsReleaseRoute,
];
