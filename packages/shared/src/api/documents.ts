// Area `documents` (owner from wave 9: WP-35): document register commands (D.2, D.3, C.13 `document.status`,
// A.4 5.7 and 5.8). Document versions are file commands (`files.ts`); Milestone 2 (D.1) adds the version history,
// and Milestone 2 (D.2) external documents (origin, source, reference, date received), built by M2-07. Milestone 3
// (D.2, D.7) adds the read confirmation settings of a document (built by M3-05).
import { z } from 'zod';
import { AcknowledgementRole, AcknowledgementScope, Classification, DocumentOrigin, DocumentVersionStatus } from '../enums.js';
import {
  Code, CommandResult, Handle, Instant, IsoDate, MsId, MsParams, MsRecordParams, PersonId, Uuid, defineRoute, named,
} from './common.js';
import type { RouteDef } from './common.js';

const Title = z.string().trim().min(1).max(255);
const DocType = z.string().regex(/^[a-z][a-z0-9_]{0,19}$/);
/** Who issued an external document (a standard body, a regulator, a customer or a supplier). */
const ExternalSource = z.string().trim().min(1).max(200);
/** The issuer's own reference of an external document (its number, edition or version). */
const ExternalRef = z.string().trim().min(1).max(120);

/**
 * Read confirmation of a document (Milestone 3 D.7): whether approving a new version asks people to confirm it, who
 * (the holders of a role in the document's systems, the chosen roles, or every member with a role in the organisation)
 * and in how many days (14 by default, H.7).
 */
export const DocumentAcknowledgement = named(
  'DocumentAcknowledgement',
  z.strictObject({
    required: z.boolean(),
    scope: AcknowledgementScope,
    roles: z.array(AcknowledgementRole).min(1).nullable(),
    dueDays: z.int().min(1).max(90),
  }).refine((a) => (a.scope === 'roles') === (a.roles !== null), { message: 'Scope roles names the roles; the other scopes name none', path: ['roles'] }),
  'Read confirmation settings of a document: required, audience scope, roles for scope roles, and the days to confirm (Milestone 3 D.7)',
  {
    valid: [{ required: true, scope: 'system_roles', roles: null, dueDays: 14 }, { required: true, scope: 'roles', roles: ['domain_owner', 'risk_owner'], dueDays: 21 }, { required: false, scope: 'system_roles', roles: null, dueDays: 14 }],
    invalid: [{ required: true, scope: 'roles', roles: null, dueDays: 14 }, { required: true, scope: 'system_roles', roles: null, dueDays: 0 }, { required: true, scope: 'organisation', roles: ['external_auditor'], dueDays: 14 }],
  },
);
export type DocumentAcknowledgement = z.infer<typeof DocumentAcknowledgement>;

export const DocumentTransitionRequest = named(
  'DocumentTransitionRequest',
  z.strictObject({ to: z.enum(['in_review', 'approved', 'draft']), note: z.string().trim().min(1).max(1000).optional() })
    .refine((r) => r.to !== 'draft' || r.note !== undefined, { message: 'Returning a document to draft needs a note', path: ['note'] }),
  'POST /ms/{ms}/documents/{id}/transitions body (C.13): start a review, approve (BR-16), or return to draft with a note',
  { valid: [{ to: 'in_review' }, { to: 'approved' }, { to: 'draft', note: 'Section 4 needs the new roles' }], invalid: [{ to: 'draft' }, { to: 'expired' }] },
);
export type DocumentTransitionRequest = z.infer<typeof DocumentTransitionRequest>;

export const DocumentCreateRequest = named(
  'DocumentCreateRequest',
  z.strictObject({
    docCode: Code,
    title: Title,
    docType: DocType,
    ownerHandle: PersonId,
    approverHandle: Handle.optional(),
    nextReviewAt: IsoDate.optional(),
    classification: Classification,
    orgWide: z.boolean(),
    linkedMs: z.array(MsId).min(1),
    origin: DocumentOrigin.optional(),
    externalSource: ExternalSource.optional(),
    externalRef: ExternalRef.optional(),
    receivedAt: IsoDate.optional(),
    acknowledgement: DocumentAcknowledgement.optional(),
  })
    .refine((r) => r.origin === 'external' || (r.externalSource === undefined && r.externalRef === undefined && r.receivedAt === undefined), {
      message: 'externalSource, externalRef and receivedAt describe an external document (origin external)',
      path: ['origin'],
    })
    .refine((r) => r.origin !== 'external' || r.externalSource !== undefined, { message: 'An external document names its source', path: ['externalSource'] }),
  'POST /ms/{ms}/documents body; docType is a doc_type lookup code of the active edition; origin internal (default) or external, an external document names its source and may give its reference and the date it was received (Milestone 2 D.2); acknowledgement sets the read confirmation (Milestone 3 D.7)',
  {
    valid: [
      { docCode: 'PRC-15', title: 'Secure Development Procedure', docType: 'procedure', ownerHandle: 'yusuf', approverHandle: 'hendra', nextReviewAt: '2027-10-01', classification: 'internal', orgWide: false, linkedMs: ['isms'] },
      { docCode: 'POL-02', title: 'Acceptable Use Policy', docType: 'policy', ownerHandle: 'rina', classification: 'internal', orgWide: true, linkedMs: ['isms'], acknowledgement: { required: true, scope: 'organisation', roles: null, dueDays: 14 } },
      { docCode: 'EXT-07', title: 'Personal Data Protection Law', docType: 'policy', ownerHandle: 'rina', classification: 'public', orgWide: true, linkedMs: ['isms'], origin: 'external', externalSource: 'Republic of Indonesia', externalRef: 'UU 27/2022', receivedAt: '2022-10-17' },
    ],
    invalid: [
      { docCode: 'PRC-15', title: 'x', docType: 'Procedure', ownerHandle: 'yusuf', classification: 'internal', orgWide: false, linkedMs: ['isms'] },
      { docCode: 'PRC-15', title: 'x', docType: 'procedure', ownerHandle: 'yusuf', classification: 'internal', orgWide: false, linkedMs: [] },
      { docCode: 'EXT-07', title: 'x', docType: 'policy', ownerHandle: 'rina', classification: 'public', orgWide: true, linkedMs: ['isms'], origin: 'external' },
      { docCode: 'PRC-15', title: 'x', docType: 'procedure', ownerHandle: 'yusuf', classification: 'internal', orgWide: false, linkedMs: ['isms'], externalRef: 'v2' },
    ],
  },
);
export type DocumentCreateRequest = z.infer<typeof DocumentCreateRequest>;

export const DocumentPatch = named(
  'DocumentPatch',
  z.strictObject({
    title: Title.optional(),
    ownerHandle: PersonId.optional(),
    approverHandle: Handle.nullable().optional(),
    nextReviewAt: IsoDate.nullable().optional(),
    classification: Classification.optional(),
    origin: DocumentOrigin.optional(),
    externalSource: ExternalSource.nullable().optional(),
    externalRef: ExternalRef.nullable().optional(),
    receivedAt: IsoDate.nullable().optional(),
    acknowledgement: DocumentAcknowledgement.optional(),
    confirm: z.boolean().optional(),
  }).refine((p) => Object.entries(p).some(([k, v]) => k !== 'confirm' && v !== undefined), { message: 'Give at least one field' }),
  'PATCH /ms/{ms}/documents/{id} body; confirm after 409 confirmation-required for shared documents (BR-22); origin and the external fields as on create (Milestone 2 D.2); acknowledgement as on create (Milestone 3 D.7)',
  {
    valid: [
      { nextReviewAt: '2027-09-24' }, { title: 'Access Control Procedure v4', confirm: true }, { origin: 'external', externalSource: 'Bank Indonesia', externalRef: 'PBI 23/2021' }, { externalRef: null },
      { acknowledgement: { required: true, scope: 'system_roles', roles: null, dueDays: 14 } },
    ],
    invalid: [{}, { confirm: true }, { status: 'approved' }, { origin: 'supplier' }],
  },
);
export type DocumentPatch = z.infer<typeof DocumentPatch>;

export const documentsTransitionRoute = defineRoute({
  id: 'documents.transition',
  owner: 'WP-35',
  method: 'POST',
  path: '/api/v1/ms/:ms/documents/:id/transitions',
  summary: 'Start a review, approve (not by the uploader, BR-16) or return a document to draft',
  auth: 'session',
  machine: 'document.status',
  scope: 'ms',
  msSource: 'path',
  params: MsRecordParams,
  body: DocumentTransitionRequest,
  response: CommandResult,
  errors: [404, 409, 412, 422],
  ifMatch: true,
});

export const documentsCreateRoute = defineRoute({
  id: 'documents.create',
  owner: 'WP-35',
  method: 'POST',
  path: '/api/v1/ms/:ms/documents',
  summary: 'Register a controlled document',
  auth: 'session',
  permission: 'document.manage',
  scope: 'ms',
  msSource: 'path',
  params: MsParams,
  body: DocumentCreateRequest,
  response: CommandResult,
  status: 201,
  errors: [404, 409, 422],
  idempotent: true,
});

export const documentsUpdateRoute = defineRoute({
  id: 'documents.update',
  owner: 'WP-35',
  method: 'PATCH',
  path: '/api/v1/ms/:ms/documents/:id',
  summary: 'Change title, owner, approver, review date or classification (BR-22 confirmation for shared documents)',
  auth: 'session',
  permission: 'document.manage',
  scope: 'ms',
  msSource: 'path',
  params: MsRecordParams,
  body: DocumentPatch,
  response: CommandResult,
  errors: [404, 409, 412, 422],
  ifMatch: true,
});

const EXAMPLE_VERSION = {
  id: '3f4a5b6c-7d8e-4f9a-8b0c-1d2e3f4a5b6c', label: '3.2', status: 'approved', storageObjectId: '4a5b6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d',
  submittedBy: 'bagus', submittedAt: '2025-09-20T03:00:00Z', approvedBy: 'hendra', approvedAt: '2025-09-24', rejectionNote: null,
  changeSummary: 'Access review frequency changed to quarterly',
} as const;

export const DocumentVersionItem = named(
  'DocumentVersionItem',
  z.object({
    id: Uuid,
    label: z.string(),
    status: DocumentVersionStatus,
    storageObjectId: Uuid,
    submittedBy: PersonId.nullable(),
    submittedAt: Instant.nullable(),
    approvedBy: PersonId.nullable(),
    approvedAt: IsoDate.nullable(),
    rejectionNote: z.string().nullable(),
    changeSummary: z.string().max(500).nullable(),
  }),
  'One version of a document: label, status, stored file, submitter, approver, dates, rejection note and change summary (Milestone 2 D.1)',
  { valid: [EXAMPLE_VERSION, { ...EXAMPLE_VERSION, status: 'rejected', approvedBy: null, approvedAt: null, rejectionNote: 'Section 4 missing', changeSummary: null }], invalid: [{ ...EXAMPLE_VERSION, status: 'published' }, { ...EXAMPLE_VERSION, changeSummary: 'x'.repeat(501) }] },
);
export type DocumentVersionItem = z.infer<typeof DocumentVersionItem>;

export const documentsVersionsListRoute = defineRoute({
  id: 'documents.versions.list',
  owner: 'M2-07',
  method: 'GET',
  path: '/api/v1/ms/:ms/documents/:id/versions',
  summary: 'Versions of a document, newest first (document scope policy: a restricted document only for those who may see it)',
  auth: 'session',
  permission: 'ms.read',
  scope: 'ms',
  msSource: 'path',
  params: MsRecordParams,
  response: z.array(DocumentVersionItem),
  errors: [404],
});

export const routes: RouteDef[] = [documentsTransitionRoute, documentsCreateRoute, documentsUpdateRoute, documentsVersionsListRoute];
