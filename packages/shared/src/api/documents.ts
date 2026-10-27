// Area `documents` (owner from wave 9: WP-35): document register commands (D.2, D.3, C.13 `document.status`,
// A.4 5.7 and 5.8). Document versions are file commands (`files.ts`); Milestone 2 (D.1) adds the version history,
// built by M2-07.
import { z } from 'zod';
import { Classification, DocumentVersionStatus } from '../enums.js';
import {
  Code, CommandResult, Handle, Instant, IsoDate, MsId, MsParams, MsRecordParams, PersonId, Uuid, defineRoute, named,
} from './common.js';
import type { RouteDef } from './common.js';

const Title = z.string().trim().min(1).max(255);
const DocType = z.string().regex(/^[a-z][a-z0-9_]{0,19}$/);

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
  }),
  'POST /ms/{ms}/documents body; docType is a doc_type lookup code of the active edition',
  {
    valid: [{ docCode: 'PRC-15', title: 'Secure Development Procedure', docType: 'procedure', ownerHandle: 'yusuf', approverHandle: 'hendra', nextReviewAt: '2027-10-01', classification: 'internal', orgWide: false, linkedMs: ['isms'] }],
    invalid: [{ docCode: 'PRC-15', title: 'x', docType: 'Procedure', ownerHandle: 'yusuf', classification: 'internal', orgWide: false, linkedMs: ['isms'] }, { docCode: 'PRC-15', title: 'x', docType: 'procedure', ownerHandle: 'yusuf', classification: 'internal', orgWide: false, linkedMs: [] }],
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
    confirm: z.boolean().optional(),
  }).refine((p) => Object.entries(p).some(([k, v]) => k !== 'confirm' && v !== undefined), { message: 'Give at least one field' }),
  'PATCH /ms/{ms}/documents/{id} body; confirm after 409 confirmation-required for shared documents (BR-22)',
  { valid: [{ nextReviewAt: '2027-09-24' }, { title: 'Access Control Procedure v4', confirm: true }], invalid: [{}, { confirm: true }, { status: 'approved' }] },
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
