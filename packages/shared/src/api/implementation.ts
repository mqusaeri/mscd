// Area `implementation` (owner from wave 8: WP-20; the operating criteria route: WP-36): applicability entries,
// activities and phases (D.2, D.3 "Commands from the UI", C.13). Milestone 2 (D.1) adds the targets of the active
// edition, freshness thresholds per frequency and the required documented information with its links, built by M2-07.
import { z } from 'zod';
import { ApplicabilityTarget, ClauseGroup, DocStatus, DocumentedInfoKind, FreshnessStatus, ImplementationStatus } from '../enums.js';
import {
  Code, CommandResult, FreqId, IsoDate, MsId, MsParams, MsRecordParams, PersonId, QueryBoolean, Uuid, defineRoute, named,
} from './common.js';
import type { RouteDef } from './common.js';
import { PhaseParams } from './readmodel.js';

const Justification = z.string().trim().min(1).max(4000);
const Note = z.string().trim().min(1).max(1000);

export const ApplicabilityTransitionRequest = named(
  'ApplicabilityTransitionRequest',
  z.strictObject({ to: ImplementationStatus, exclusionJustification: Justification.optional(), reason: Note.optional() })
    .refine((r) => r.to !== 'not_applicable' || r.exclusionJustification !== undefined, { message: 'not_applicable needs exclusionJustification', path: ['exclusionJustification'] }),
  'POST /ms/{ms}/applicability/{id}/transitions body (C.13): the target status, the exclusion justification for not_applicable, an optional reason',
  {
    valid: [{ to: 'complete' }, { to: 'implemented' }, { to: 'not_applicable', exclusionJustification: 'No development activities in scope' }, { to: 'partially_implemented', reason: 'Evidence does not cover Q3' }],
    invalid: [{ to: 'not_applicable' }, { to: 'blocked' }, { to: 'complete', note: 'x' }],
  },
);
export type ApplicabilityTransitionRequest = z.infer<typeof ApplicabilityTransitionRequest>;

export const ApplicabilityPatch = named(
  'ApplicabilityPatch',
  z.strictObject({
    isApplicable: z.boolean().optional(),
    inclusionJustification: Justification.nullable().optional(),
    exclusionJustification: Justification.nullable().optional(),
    holdsGate: z.boolean().optional(),
    gateReason: Note.nullable().optional(),
    statusNote: Note.nullable().optional(),
    frequencyCode: FreqId.optional(),
    ownerHandle: PersonId.optional(),
    riskCodes: z.array(Code).optional(),
    documentCodes: z.array(Code).optional(),
  }).refine((p) => Object.values(p).some((v) => v !== undefined), { message: 'Give at least one field' }),
  'PATCH /ms/{ms}/applicability/{id} body; ownerHandle none leaves the entry unassigned (BR-45); warning BR-03',
  {
    valid: [{ holdsGate: true, gateReason: 'No risk-based justification' }, { ownerHandle: 'bagus', riskCodes: ['R-014', 'R-031'], documentCodes: ['PRC-11'] }, { inclusionJustification: null }],
    invalid: [{}, { ownerHandle: 'Bagus' }, { riskCodes: 'R-014' }],
  },
);
export type ApplicabilityPatch = z.infer<typeof ApplicabilityPatch>;

export const ApplicabilityCreateRequest = named(
  'ApplicabilityCreateRequest',
  z.strictObject({
    targetType: ApplicabilityTarget,
    code: Code,
    isApplicable: z.boolean(),
    inclusionJustification: Justification.optional(),
    exclusionJustification: Justification.optional(),
    ownerHandle: PersonId,
    frequencyCode: FreqId,
  }).refine((r) => r.isApplicable || r.exclusionJustification !== undefined, { message: 'Entries that are not applicable need exclusionJustification', path: ['exclusionJustification'] }),
  'POST /ms/{ms}/applicability body: a catalogue item or requirement code of the active edition',
  {
    valid: [{ targetType: 'catalogue_item', code: 'A.5.7', isApplicable: true, inclusionJustification: 'Required by R-022', ownerHandle: 'rina', frequencyCode: 'quarterly' }],
    invalid: [{ targetType: 'catalogue_item', code: 'A.5.7', isApplicable: false, ownerHandle: 'rina', frequencyCode: 'quarterly' }, { targetType: 'control', code: 'A.5.7', isApplicable: true, ownerHandle: 'rina', frequencyCode: 'quarterly' }],
  },
);
export type ApplicabilityCreateRequest = z.infer<typeof ApplicabilityCreateRequest>;

export const OperatingCriteriaRequest = named(
  'OperatingCriteriaRequest',
  z.strictObject({ frequencyCode: FreqId, description: z.string().trim().max(2000).optional() }),
  'PUT /ms/{ms}/applicability/{id}/operating-criteria body: frequency from ref.evidence_frequency_rule',
  { valid: [{ frequencyCode: 'monthly' }, { frequencyCode: 'event', description: 'After every change' }], invalid: [{}, { frequencyCode: 'Monthly' }] },
);
export type OperatingCriteriaRequest = z.infer<typeof OperatingCriteriaRequest>;

export const ActivityTransitionRequest = named(
  'ActivityTransitionRequest',
  z.strictObject({
    to: z.enum(['in_progress', 'complete', 'verified', 'blocked']),
    blockerGateItemRef: z.string().trim().min(1).max(60).optional(),
    blockerReason: Note.optional(),
    outputDocumentCode: Code.optional(),
    rejectReason: Note.optional(),
  }).refine((r) => r.to !== 'blocked' || (r.blockerGateItemRef !== undefined && r.blockerReason !== undefined), { message: 'blocked needs blockerGateItemRef and blockerReason', path: ['blockerGateItemRef'] }),
  'POST /ms/{ms}/activities/{id}/transitions body (C.13); rejectReason when a verifier returns a completed activity to in_progress',
  {
    valid: [{ to: 'complete', outputDocumentCode: 'SOA-01' }, { to: 'blocked', blockerGateItemRef: 'A.8.12', blockerReason: 'Blocked by checkpoint item A.8.12' }, { to: 'in_progress', rejectReason: 'Output not approved' }],
    invalid: [{ to: 'blocked' }, { to: 'locked' }, { to: 'not_started' }],
  },
);
export type ActivityTransitionRequest = z.infer<typeof ActivityTransitionRequest>;

export const applicabilityTransitionRoute = defineRoute({
  id: 'applicability.transition',
  owner: 'WP-20',
  method: 'POST',
  path: '/api/v1/ms/:ms/applicability/:id/transitions',
  summary: 'Change the implementation status of an entry (C.13: complete, verify, reject, not applicable)',
  auth: 'session',
  machine: 'applicability_entry.implementation_status',
  scope: 'ms',
  msSource: 'path',
  params: MsRecordParams,
  body: ApplicabilityTransitionRequest,
  response: CommandResult,
  errors: [404, 409, 412, 422],
  ifMatch: true,
});

export const applicabilityUpdateRoute = defineRoute({
  id: 'applicability.update',
  owner: 'WP-20',
  method: 'PATCH',
  path: '/api/v1/ms/:ms/applicability/:id',
  summary: 'Change justifications, checkpoint flag, note, frequency, owner, linked risks and documents of an entry',
  auth: 'session',
  permission: 'applicability.manage',
  scope: 'ms',
  msSource: 'path',
  params: MsRecordParams,
  body: ApplicabilityPatch,
  response: CommandResult,
  errors: [404, 412, 422],
  ifMatch: true,
});

export const applicabilityCreateRoute = defineRoute({
  id: 'applicability.create',
  owner: 'WP-20',
  method: 'POST',
  path: '/api/v1/ms/:ms/applicability',
  summary: 'Add an applicability entry for a catalogue item or requirement of the active edition',
  auth: 'session',
  permission: 'applicability.manage',
  scope: 'ms',
  msSource: 'path',
  params: MsParams,
  body: ApplicabilityCreateRequest,
  response: CommandResult,
  status: 201,
  errors: [404, 409, 422],
  idempotent: true,
});

export const applicabilityOperatingCriteriaRoute = defineRoute({
  id: 'applicability.operating-criteria',
  owner: 'WP-36',
  method: 'PUT',
  path: '/api/v1/ms/:ms/applicability/:id/operating-criteria',
  summary: 'Set the operating frequency of an entry (enqueues freshness.recompute)',
  auth: 'session',
  permission: 'applicability.manage',
  scope: 'ms',
  msSource: 'path',
  params: MsRecordParams,
  body: OperatingCriteriaRequest,
  response: CommandResult,
  errors: [404, 422],
});

export const activityTransitionRoute = defineRoute({
  id: 'activity.transition',
  owner: 'WP-20',
  method: 'POST',
  path: '/api/v1/ms/:ms/activities/:id/transitions',
  summary: 'Change the status of an implementation activity (C.13: start, complete, verify, block)',
  auth: 'session',
  machine: 'implementation_activity_progress.status',
  scope: 'ms',
  msSource: 'path',
  params: MsRecordParams,
  body: ActivityTransitionRequest,
  response: CommandResult,
  errors: [404, 409, 412, 422],
  ifMatch: true,
});

export const phaseVerifyRoute = defineRoute({
  id: 'phase.verify',
  owner: 'WP-20',
  method: 'POST',
  path: '/api/v1/ms/:ms/phases/:n/verify',
  summary: 'Verify a phase once all its activities are verified (BR-12)',
  auth: 'session',
  permission: 'phase.verify',
  scope: 'ms',
  msSource: 'path',
  params: PhaseParams,
  response: CommandResult,
  errors: [404, 422],
});

// ---------------------------------------------------------------------------------------------------------------
// Targets, freshness thresholds and documented information (Milestone 2 D.1, M2-07)
// ---------------------------------------------------------------------------------------------------------------

export const ApplicabilityTargetsQuery = named(
  'ApplicabilityTargetsQuery',
  z.strictObject({ kind: ApplicabilityTarget.optional(), q: z.string().trim().min(1).max(100).optional(), retired: QueryBoolean.optional() }),
  'GET /ms/{ms}/applicability/targets query: target kind, search in code and title, and whether retired rows are listed (default no)',
  { valid: [{}, { kind: 'catalogue_item', q: 'backup' }, { retired: 'true' }], invalid: [{ kind: 'control' }, { page: 'x', q: '' }] },
);
export type ApplicabilityTargetsQuery = z.infer<typeof ApplicabilityTargetsQuery>;

const EXAMPLE_TARGET = {
  kind: 'catalogue_item', code: 'A.8.13', title: 'Information backup', clauseGroup: '8', hasEntry: true, retired: false, assessable: true,
  documentedInfo: false,
} as const;

export const ApplicabilityTargetItem = named(
  'ApplicabilityTargetItem',
  z.object({
    kind: ApplicabilityTarget,
    code: Code,
    title: z.string(),
    clauseGroup: ClauseGroup.nullable(),
    hasEntry: z.boolean(),
    retired: z.boolean(),
    /** false for clause rows, which are always applicable (applicability_assessable, D2-09). */
    assessable: z.boolean(),
    documentedInfo: z.boolean(),
  }),
  'A catalogue item or requirement of the active edition: code, title, clause group, whether the system has an entry, retired, assessable, documented information needed (Milestone 2 D.1)',
  { valid: [EXAMPLE_TARGET, { ...EXAMPLE_TARGET, kind: 'requirement', code: '5.1', title: 'Leadership and commitment', clauseGroup: '5', hasEntry: false, assessable: false, documentedInfo: true }], invalid: [{ ...EXAMPLE_TARGET, kind: 'control' }, { ...EXAMPLE_TARGET, clauseGroup: '11' }] },
);
export type ApplicabilityTargetItem = z.infer<typeof ApplicabilityTargetItem>;

export const FreshnessThresholdItem = named(
  'FreshnessThresholdItem',
  z.object({
    frequencyCode: FreqId,
    graceDays: z.number().min(0),
    agingFactor: z.number().min(1),
    expiredFactor: z.number().min(1),
    source: z.enum(['default', 'set']),
  }),
  'Freshness limits in force for one evidence frequency of a system, marked default or set for the system (Milestone 2 D.1)',
  { valid: [{ frequencyCode: 'monthly', graceDays: 1, agingFactor: 1.25, expiredFactor: 2, source: 'default' }, { frequencyCode: 'annual', graceDays: 14, agingFactor: 1.1, expiredFactor: 1.5, source: 'set' }], invalid: [{ frequencyCode: 'monthly', graceDays: -1, agingFactor: 1.25, expiredFactor: 2, source: 'default' }, { frequencyCode: 'monthly', graceDays: 1, agingFactor: 0.5, expiredFactor: 2, source: 'set' }] },
);
export type FreshnessThresholdItem = z.infer<typeof FreshnessThresholdItem>;

export const FreshnessThresholdParams = named('FreshnessThresholdParams', z.strictObject({ ms: MsId, frequencyCode: FreqId }), 'Path parameters {ms} and {frequencyCode}', {
  valid: [{ ms: 'isms', frequencyCode: 'monthly' }],
  invalid: [{ ms: 'isms', frequencyCode: 'Monthly' }, { ms: 'isms' }],
});
export type FreshnessThresholdParams = z.infer<typeof FreshnessThresholdParams>;

export const FreshnessThresholdSet = named(
  'FreshnessThresholdSet',
  z.union([
    z.strictObject({ graceDays: z.number().min(0).max(365), agingFactor: z.number().min(1).max(100), expiredFactor: z.number().min(1).max(100) })
      .refine((t) => t.expiredFactor >= t.agingFactor, { message: 'expiredFactor must be at least agingFactor', path: ['expiredFactor'] }),
    z.strictObject({ graceDays: z.null(), agingFactor: z.null(), expiredFactor: z.null() }),
  ]),
  'PUT /ms/{ms}/freshness-thresholds/{frequencyCode} body: grace days, aging factor (at least 1) and expired factor (at least the aging factor), or all null to return to the defaults (Milestone 2 D.1)',
  { valid: [{ graceDays: 7, agingFactor: 1.2, expiredFactor: 1.8 }, { graceDays: null, agingFactor: null, expiredFactor: null }], invalid: [{ graceDays: 7, agingFactor: 2, expiredFactor: 1.5 }, { graceDays: 7 }, { graceDays: null, agingFactor: 1.2, expiredFactor: null }] },
);
export type FreshnessThresholdSet = z.infer<typeof FreshnessThresholdSet>;

/** States of a row of the documented information list (Milestone 2 M2-07). */
export const DOCUMENTED_INFO_STATES = ['missing', 'draft', 'in_review', 'approved', 'review_overdue', 'fresh', 'out_of_date'] as const;
export const DocumentedInfoState = z.enum(DOCUMENTED_INFO_STATES).meta({ id: 'DocumentedInfoState', description: 'State of required documented information (Milestone 2 M2-07)' });
export type DocumentedInfoState = z.infer<typeof DocumentedInfoState>;

const EXAMPLE_DOCUMENTED_INFO = {
  code: 'DI-5.2', requirementCode: '5.2', kind: 'maintain', title: 'Information security policy', templateCode: 'POL-01', state: 'approved',
  document: { id: '2e3f4a5b-6c7d-4e8f-9a0b-1c2d3e4f5a6b', code: 'ISP-001', title: 'Information Security Policy', status: 'approved', nextReviewAt: '2027-03-01', owner: 'rina', linked: true },
  evidence: [],
} as const;

export const DocumentedInfoItem = named(
  'DocumentedInfoItem',
  z.object({
    code: Code,
    requirementCode: Code,
    kind: DocumentedInfoKind,
    title: z.string(),
    templateCode: Code.nullable(),
    state: DocumentedInfoState,
    document: z.object({
      id: Uuid, code: Code, title: z.string(), status: DocStatus, nextReviewAt: IsoDate.nullable(), owner: PersonId,
      /** True when the document was mapped to the pack code with documented-info.link. */
      linked: z.boolean(),
    }).nullable(),
    evidence: z.array(z.object({ code: Code, title: z.string(), fresh: FreshnessStatus })),
  }),
  'Required documented information of the edition with the document (maintain) or the evidence (retain) that covers it and its state (Milestone 2 D.1)',
  {
    valid: [EXAMPLE_DOCUMENTED_INFO, { ...EXAMPLE_DOCUMENTED_INFO, code: 'DI-9.2', requirementCode: '9.2', kind: 'retain', title: 'Internal audit results', templateCode: null, state: 'fresh', document: null, evidence: [{ code: 'EV-0920', title: 'Internal audit report 2026', fresh: 'fresh' }] }],
    invalid: [{ ...EXAMPLE_DOCUMENTED_INFO, state: 'done' }, { ...EXAMPLE_DOCUMENTED_INFO, kind: 'keep' }],
  },
);
export type DocumentedInfoItem = z.infer<typeof DocumentedInfoItem>;

export const DocumentedInfoParams = named('DocumentedInfoParams', z.strictObject({ ms: MsId, code: Code }), 'Path parameters {ms} and {code}: a pack document code (template code or activity output document code)', {
  valid: [{ ms: 'isms', code: 'POL-01' }],
  invalid: [{ ms: 'isms', code: '' }, { ms: 'isms' }],
});
export type DocumentedInfoParams = z.infer<typeof DocumentedInfoParams>;

export const DocumentedInfoLink = named(
  'DocumentedInfoLink',
  z.strictObject({ documentId: Uuid.nullable() }),
  'PUT /ms/{ms}/documented-information/{code}/link body: the registered document that stands for the pack code, or null to remove the link (Milestone 2 D.1)',
  { valid: [{ documentId: '2e3f4a5b-6c7d-4e8f-9a0b-1c2d3e4f5a6b' }, { documentId: null }], invalid: [{}, { documentId: 'ISP-001' }] },
);
export type DocumentedInfoLink = z.infer<typeof DocumentedInfoLink>;

const m2 = { owner: 'M2-07' as const, auth: 'session' as const, scope: 'ms' as const, msSource: 'path' as const };

export const applicabilityTargetsRoute = defineRoute({
  ...m2, id: 'applicability.targets', method: 'GET', path: '/api/v1/ms/:ms/applicability/targets',
  summary: 'Catalogue items and requirements of the active edition, with whether the system has an entry for each',
  permission: 'ms.read', params: MsParams, query: ApplicabilityTargetsQuery, response: z.array(ApplicabilityTargetItem), errors: [404],
});
export const freshnessThresholdsGetRoute = defineRoute({
  ...m2, id: 'freshness.thresholds.get', method: 'GET', path: '/api/v1/ms/:ms/freshness-thresholds',
  summary: 'Freshness limits in force per evidence frequency, marked default or set',
  permission: 'ms.read', params: MsParams, response: z.array(FreshnessThresholdItem), errors: [404],
});
export const freshnessThresholdsPutRoute = defineRoute({
  ...m2, id: 'freshness.thresholds.put', method: 'PUT', path: '/api/v1/ms/:ms/freshness-thresholds/:frequencyCode',
  summary: 'Set or reset the freshness limits of one frequency for the system (audited freshness_threshold.changed; queues freshness.recompute)',
  permission: 'applicability.manage', params: FreshnessThresholdParams, body: FreshnessThresholdSet, response: CommandResult, errors: [404, 422],
});
export const documentedInfoListRoute = defineRoute({
  ...m2, id: 'documented-info.list', method: 'GET', path: '/api/v1/ms/:ms/documented-information',
  summary: 'Required documented information of the edition with the linked document or evidence and its state',
  permission: 'ms.read', params: MsParams, response: z.array(DocumentedInfoItem), errors: [404],
});
export const documentedInfoLinkRoute = defineRoute({
  ...m2, id: 'documented-info.link', method: 'PUT', path: '/api/v1/ms/:ms/documented-information/:code/link',
  summary: 'Map a pack document code to a registered document of the system, or remove the mapping (audited document_code.linked)',
  permission: 'document.manage', params: DocumentedInfoParams, body: DocumentedInfoLink, response: CommandResult, errors: [404, 422],
});

export const routes: RouteDef[] = [
  applicabilityTransitionRoute, applicabilityUpdateRoute, applicabilityCreateRoute, applicabilityOperatingCriteriaRoute,
  activityTransitionRoute, phaseVerifyRoute,
  applicabilityTargetsRoute, freshnessThresholdsGetRoute, freshnessThresholdsPutRoute, documentedInfoListRoute, documentedInfoLinkRoute,
];
