// Area `org-export` (Milestone 3 D.1, D.4, built by M3-02; contract written by M3-01): the full export of an
// organisation. A Tenant Admin requests it; when the organisation has another active Tenant Admin, that person approves
// it first, and the requester can never approve (rule `SOD-SELF-APPROVE`, H.2). The worker job `org-export.build`
// writes `.tar.gz` parts of at most `lifecycle.export_part_bytes` with every table as CSV and JSON Lines, the audit
// trail with its hashes and signed anchors, and the stored files, plus a `manifest.json` with the size and SHA-256 of
// every entry and part. Any active Tenant Admin downloads a ready export; each download is audited and announced to
// every Tenant Admin and primary Management System Manager. An export expires `lifecycle.export_link_days` after it is
// ready (the final export of the offboarding period stays until the organisation closes). The platform operator can
// queue an export and see its status, and never downloads one (operators never read tenant data, M2 K.8). Routes whose
// id starts with `exports.` stay usable while an organisation is `offboarding`. The operator routes answer 409
// `conflict` with messageKey `single_tenancy` in single tenancy. Refusals: 409 `export_too_large`,
// `export_in_progress` (J.6).
import { z } from 'zod';
import { ExportRequestSource, OrganizationExportStatus } from '../enums.js';
import { BinaryBody, IdParams, Instant, Uuid, commandResultWith, defineRoute, named } from './common.js';
import type { RouteDef } from './common.js';
import { OpsReasonBody, OrgParams } from './ops.js';

/** A person named on an export: the handle and display name, null for the system or an operator the customer does not know. */
const ExportPerson = z.object({ handle: z.string(), displayName: z.string() }).nullable();
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

const EXAMPLE_PART = { part: 1, name: 'mscd-export-ndt-2026-10-31-part-1.tar.gz', sizeBytes: 734003200, sha256: 'ab'.repeat(32) } as const;

export const OrganizationExportPart = named(
  'OrganizationExportPart',
  z.object({ part: z.int().min(1), name: z.string().min(1), sizeBytes: z.int().min(0), sha256: Sha256 }),
  'One part of an organisation export: its number, file name, size and SHA-256 (Milestone 3 D.4)',
  { valid: [EXAMPLE_PART], invalid: [{ ...EXAMPLE_PART, part: 0 }, { ...EXAMPLE_PART, sha256: 'abc' }] },
);
export type OrganizationExportPart = z.infer<typeof OrganizationExportPart>;

const EXAMPLE_EXPORT = {
  id: '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d', status: 'ready', requestedVia: 'tenant_admin',
  requestedBy: { handle: 'tenant.admin', displayName: 'Tenant Admin' }, requestedAt: '2026-10-31T02:00:00Z',
  decidedBy: { handle: 'dewi', displayName: 'Dewi Lestari' }, decidedAt: '2026-10-31T02:20:00Z', decisionNote: null, isFinal: false,
  partCount: 2, fileCount: 412, sizeBytes: 1203765248, expiresAt: '2026-11-07T03:10:00Z', completedAt: '2026-10-31T03:10:00Z', downloadCount: 1, error: null,
} as const;
const EXAMPLE_REQUESTED = {
  ...EXAMPLE_EXPORT, status: 'requested', decidedBy: null, decidedAt: null, partCount: null, fileCount: null, sizeBytes: null, expiresAt: null,
  completedAt: null, downloadCount: 0,
} as const;

const exportShape = {
  id: Uuid,
  status: OrganizationExportStatus,
  requestedVia: ExportRequestSource,
  requestedBy: ExportPerson,
  requestedAt: Instant,
  decidedBy: ExportPerson,
  decidedAt: Instant.nullable(),
  decisionNote: z.string().nullable(),
  /** The final export queued by the move to offboarding; it stays until the organisation closes. */
  isFinal: z.boolean(),
  partCount: z.int().min(0).nullable(),
  fileCount: z.int().min(0).nullable(),
  sizeBytes: z.int().min(0).nullable(),
  expiresAt: Instant.nullable(),
  completedAt: Instant.nullable(),
  downloadCount: z.int().min(0),
  error: z.string().nullable(),
};

export const OrganizationExportItem = named(
  'OrganizationExportItem',
  z.object(exportShape),
  'An organisation export as the Tenant Admins see it: status, who asked and approved, when, parts, files, size, expiry and downloads (Milestone 3 D.4)',
  {
    valid: [EXAMPLE_EXPORT, EXAMPLE_REQUESTED, { ...EXAMPLE_REQUESTED, status: 'queued', requestedVia: 'offboarding', requestedBy: null, isFinal: true }],
    invalid: [{ ...EXAMPLE_EXPORT, status: 'done' }, { ...EXAMPLE_EXPORT, requestedVia: 'customer' }, { ...EXAMPLE_EXPORT, downloadCount: -1 }],
  },
);
export type OrganizationExportItem = z.infer<typeof OrganizationExportItem>;

export const OrganizationExportDetail = named(
  'OrganizationExportDetail',
  z.object({ ...exportShape, parts: z.array(OrganizationExportPart), manifestSha256: Sha256.nullable() }),
  'GET /admin/organization/exports/{id}: one export with its parts and the SHA-256 of its manifest (Milestone 3 D.4)',
  {
    valid: [{ ...EXAMPLE_EXPORT, parts: [EXAMPLE_PART, { ...EXAMPLE_PART, part: 2, name: 'mscd-export-ndt-2026-10-31-part-2.tar.gz', sizeBytes: 469762048 }], manifestSha256: 'cd'.repeat(32) }, { ...EXAMPLE_REQUESTED, parts: [], manifestSha256: null }],
    invalid: [EXAMPLE_EXPORT, { ...EXAMPLE_EXPORT, parts: [{ part: 1 }], manifestSha256: null }],
  },
);
export type OrganizationExportDetail = z.infer<typeof OrganizationExportDetail>;

export const OrganizationExportCreate = named(
  'OrganizationExportCreate',
  z.strictObject({ note: z.string().trim().min(1).max(500).optional() }),
  'POST /admin/organization/exports body: an optional note for the approving Tenant Admin (Milestone 3 D.4)',
  { valid: [{}, { note: 'Copy for the annual records archive' }], invalid: [{ note: '' }, { parts: 2 }] },
);
export type OrganizationExportCreate = z.infer<typeof OrganizationExportCreate>;

export const OrganizationExportCreated = named(
  'OrganizationExportCreated',
  commandResultWith(z.object({ id: Uuid, status: z.enum(['requested', 'queued']), approvalNeeded: z.boolean() })),
  'Answer of an export request: requested (waits for another Tenant Admin) or queued; a queued export of a single Tenant Admin carries a message that nobody else approved it (H.2)',
  {
    valid: [
      { ok: true, changed: [], data: { id: '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d', status: 'requested', approvalNeeded: true } },
      { ok: true, changed: [], message: ['The export was queued. Nobody else approved it, because the organisation has one Tenant Admin.', 'Ekspor diantrekan. Tidak ada orang lain yang menyetujuinya, karena organisasi hanya memiliki satu Tenant Admin.'], data: { id: '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d', status: 'queued', approvalNeeded: false } },
    ],
    invalid: [{ ok: true, changed: [], data: { id: '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d', status: 'ready', approvalNeeded: false } }, { ok: true, changed: [] }],
  },
);
export type OrganizationExportCreated = z.infer<typeof OrganizationExportCreated>;

export const OrganizationExportDecision = named(
  'OrganizationExportDecision',
  z.strictObject({ approve: z.boolean(), note: z.string().trim().min(1).max(500).optional() })
    .refine((d) => d.approve || d.note !== undefined, { message: 'A rejection needs a note', path: ['note'] }),
  'POST /admin/organization/exports/{id}/decision body: another Tenant Admin approves, or rejects with a note; the requester is refused with SOD-SELF-APPROVE (Milestone 3 D.4)',
  { valid: [{ approve: true }, { approve: false, note: 'Not agreed with the board' }], invalid: [{ approve: false }, { note: 'x' }, { approve: 'yes' }] },
);
export type OrganizationExportDecision = z.infer<typeof OrganizationExportDecision>;

export const OrganizationExportDecided = named(
  'OrganizationExportDecided',
  commandResultWith(z.object({ id: Uuid, status: z.enum(['queued', 'rejected']) })),
  'Result of an export decision: queued for the build, or rejected (Milestone 3 J.8)',
  {
    valid: [{ ok: true, changed: [], data: { id: '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d', status: 'queued' } }],
    invalid: [{ ok: true, changed: [], data: { id: '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d', status: 'requested' } }],
  },
);
export type OrganizationExportDecided = z.infer<typeof OrganizationExportDecided>;

export const OrganizationExportPartParams = named(
  'OrganizationExportPartParams',
  z.strictObject({ id: Uuid, part: z.string().regex(/^[1-9][0-9]{0,3}$/) }),
  'Path parameters {id} (the export) and {part} (the part number, from 1)',
  { valid: [{ id: '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d', part: '1' }], invalid: [{ id: '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d', part: '0' }, { id: 'x', part: '1' }] },
);
export type OrganizationExportPartParams = z.infer<typeof OrganizationExportPartParams>;

const EXAMPLE_OPS_EXPORT = {
  id: '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d', status: 'ready', requestedVia: 'operator', requestedAt: '2026-10-31T02:00:00Z', completedAt: '2026-10-31T03:10:00Z',
  expiresAt: '2026-11-07T03:10:00Z', isFinal: false, partCount: 2, sizeBytes: 1203765248, downloadCount: 0,
} as const;

export const OpsOrganizationExportItem = named(
  'OpsOrganizationExportItem',
  z.object({
    id: Uuid,
    status: OrganizationExportStatus,
    requestedVia: ExportRequestSource,
    requestedAt: Instant,
    completedAt: Instant.nullable(),
    expiresAt: Instant.nullable(),
    isFinal: z.boolean(),
    partCount: z.int().min(0).nullable(),
    sizeBytes: z.int().min(0).nullable(),
    downloadCount: z.int().min(0),
  }),
  'An export of an organisation as the platform operator sees it: status, dates and sizes, no content and no download (Milestone 3 D.4)',
  {
    valid: [EXAMPLE_OPS_EXPORT, { ...EXAMPLE_OPS_EXPORT, status: 'building', completedAt: null, expiresAt: null, partCount: null, sizeBytes: null }],
    invalid: [{ ...EXAMPLE_OPS_EXPORT, status: 'paused' }, { ...EXAMPLE_OPS_EXPORT, isFinal: 'no' }],
  },
);
export type OpsOrganizationExportItem = z.infer<typeof OpsOrganizationExportItem>;

export const OpsOrganizationExportQueued = named(
  'OpsOrganizationExportQueued',
  commandResultWith(z.object({ id: Uuid, status: z.literal('queued') })),
  'Result of POST /ops/organizations/{org}/exports: the export queued for the Tenant Admins (audited ops.export_requested)',
  {
    valid: [{ ok: true, changed: [], data: { id: '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d', status: 'queued' } }],
    invalid: [{ ok: true, changed: [], data: { id: '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d', status: 'ready' } }],
  },
);
export type OpsOrganizationExportQueued = z.infer<typeof OpsOrganizationExportQueued>;

const admin = { owner: 'M3-02' as const, auth: 'session' as const, permission: 'org.export.manage' as const, scope: 'org' as const };
const ops = { owner: 'M3-02' as const, auth: 'session' as const, scope: 'platform' as const };

export const orgExportListRoute = defineRoute({
  ...admin, id: 'exports.organization.list', method: 'GET', path: '/api/v1/admin/organization/exports',
  summary: 'Exports of the organisation with status, requester, approver, dates, parts, sizes and expiry, newest first',
  response: z.array(OrganizationExportItem), errors: [],
});
export const orgExportCreateRoute = defineRoute({
  ...admin, id: 'exports.organization.create', method: 'POST', path: '/api/v1/admin/organization/exports',
  summary: 'Request an export: requested when another active Tenant Admin exists, else queued with a message (409 export_too_large, export_in_progress; audited organization_export.requested)',
  body: OrganizationExportCreate, response: OrganizationExportCreated, status: 202, errors: [409], idempotent: true,
});
export const orgExportGetRoute = defineRoute({
  ...admin, id: 'exports.organization.get', method: 'GET', path: '/api/v1/admin/organization/exports/:id',
  summary: 'One export with its parts and the SHA-256 of its manifest',
  params: IdParams, response: OrganizationExportDetail, errors: [404],
});
export const orgExportDecideRoute = defineRoute({
  ...admin, id: 'exports.organization.decide', method: 'POST', path: '/api/v1/admin/organization/exports/:id/decision',
  summary: 'Another Tenant Admin approves or rejects a requested export; the requester is refused with SOD-SELF-APPROVE (409 when not requested; audited organization_export.decided)',
  params: IdParams, body: OrganizationExportDecision, response: OrganizationExportDecided, errors: [404, 409, 422],
});
export const orgExportManifestRoute = defineRoute({
  ...admin, id: 'exports.organization.manifest', method: 'GET', path: '/api/v1/admin/organization/exports/:id/manifest',
  summary: 'The manifest of a ready export as a JSON attachment (409 when not ready; audited organization_export.downloaded)',
  params: IdParams, response: BinaryBody, responseType: 'application/json', file: true, errors: [404, 409],
});
export const orgExportDownloadRoute = defineRoute({
  ...admin, id: 'exports.organization.download', method: 'GET', path: '/api/v1/admin/organization/exports/:id/parts/:part',
  summary: 'One part of a ready export as an attachment with Content-Length and its SHA-256 in X-MSCD-SHA256 (409 when not ready; audited organization_export.downloaded)',
  params: OrganizationExportPartParams, response: BinaryBody, responseType: 'application/gzip', file: true, errors: [404, 409],
});
export const opsExportsListRoute = defineRoute({
  ...ops, id: 'ops.exports.list', method: 'GET', path: '/api/v1/ops/organizations/:org/exports',
  summary: 'Status, dates and sizes of the exports of an organisation, without content or download (409 single_tenancy)',
  permission: 'ops.read', params: OrgParams, response: z.array(OpsOrganizationExportItem), errors: [404, 409],
});
export const opsExportsCreateRoute = defineRoute({
  ...ops, id: 'ops.exports.create', method: 'POST', path: '/api/v1/ops/organizations/:org/exports',
  summary: 'Queue an export for the Tenant Admins to download (409 single_tenancy, export_too_large, export_in_progress; audited ops.export_requested)',
  permission: 'ops.tenants.manage', params: OrgParams, body: OpsReasonBody, response: OpsOrganizationExportQueued, status: 202, errors: [404, 409], idempotent: true,
});

export const routes: RouteDef[] = [
  orgExportListRoute, orgExportCreateRoute, orgExportGetRoute, orgExportDecideRoute, orgExportManifestRoute, orgExportDownloadRoute,
  opsExportsListRoute, opsExportsCreateRoute,
];
