// Area `ops` (owner from wave 11: WP-34): operations endpoints of the platform operator (D.2 `OpsHealth`, D.3
// "Operations"). Milestone 2 (D.1, D.2) adds the organisation lifecycle of the platform operator: list and create
// (M2-06), the second-factor reset of an account with several memberships (M2-06), and detail, status changes and
// status history (M2-S09, SaaS track). Every organisation route answers 409 `conflict` with messageKey
// `single_tenancy` when tenancy.mode is single (J.6).
import { z } from 'zod';
import { DomainStatus, EntitlementSource, OpsRunnableJob, OrganizationStatus } from '../enums.js';
import {
  BinaryBody, Instant, IsoDate, NoBody, OrgSlug, Uuid, commandResultWith, defineRoute, named, pageOf, pageQueryShape,
} from './common.js';
import type { RouteDef } from './common.js';
import { LicenceState } from './license.js';

export const QueueStats = named(
  'QueueStats',
  z.object({ name: z.string(), waiting: z.int().min(0), active: z.int().min(0), failed: z.int().min(0), oldestAgeSeconds: z.number().min(0) }),
  'Job queue statistics (E.1 JobQueue.stats)',
  { valid: [{ name: 'freshness.recompute', waiting: 2, active: 1, failed: 0, oldestAgeSeconds: 4.2 }], invalid: [{ name: 'x', waiting: -1, active: 0, failed: 0, oldestAgeSeconds: 0 }] },
);
export type QueueStats = z.infer<typeof QueueStats>;

export const OpsHealth = named(
  'OpsHealth',
  z.object({
    components: z.array(z.object({ name: z.string(), status: z.enum(['ok', 'degraded', 'down']), detail: z.string() })),
    migrations: z.array(z.object({ schema: z.string(), latest: z.string().nullable(), expected: z.string().nullable() })),
    queues: z.array(QueueStats),
    licences: z.array(z.object({ org: OrgSlug, state: LicenceState, validUntil: IsoDate })),
  }),
  'Installation health for the platform operator (D.2)',
  {
    valid: [{ components: [{ name: 'database', status: 'ok', detail: 'SELECT 1 in 2 ms' }], migrations: [{ schema: 'platform', latest: '0004_operations', expected: '0004_operations' }], queues: [], licences: [{ org: 'ndt', state: 'valid', validUntil: '2027-03-31' }] }],
    invalid: [{ components: [{ name: 'database', status: 'green', detail: '' }], migrations: [], queues: [], licences: [] }],
  },
);
export type OpsHealth = z.infer<typeof OpsHealth>;

export const JobRunParams = named('JobRunParams', z.strictObject({ name: OpsRunnableJob }), 'Path parameter {name}: a job of the operator allow-list', {
  valid: [{ name: 'drift.evaluate' }],
  invalid: [{ name: 'pack.install' }, { name: 'rm -rf' }],
});
export type JobRunParams = z.infer<typeof JobRunParams>;

export const JobRunRequest = named('JobRunRequest', z.strictObject({ org: OrgSlug.optional() }), 'POST /ops/jobs/{name}/run body: only the organisation, never a free payload', {
  valid: [{}, { org: 'ndt' }],
  invalid: [{ payload: {} }, { org: 'NDT' }],
});
export type JobRunRequest = z.infer<typeof JobRunRequest>;

export const JobRunResponse = named('JobRunResponse', z.object({ jobId: z.string().min(1) }), 'Id of the queued job', {
  valid: [{ jobId: 'ob-42' }],
  invalid: [{}],
});
export type JobRunResponse = z.infer<typeof JobRunResponse>;

// ---------------------------------------------------------------------------------------------------------------
// Organisations (Milestone 2 D.1, D.2, K.6)
// ---------------------------------------------------------------------------------------------------------------

/** Name of a plan preset of the profile key `license.plans` (Milestone 2 D.3). */
export const PlanPresetName = named('PlanPresetName', z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/), 'Name of a plan preset of license.plans', {
  valid: ['trial', 'standard'],
  invalid: ['Trial', '', 'a b'],
});
export type PlanPresetName = z.infer<typeof PlanPresetName>;

export const OrgParams = named('OrgParams', z.strictObject({ org: OrgSlug }), 'Path parameter {org}: the organisation slug', {
  valid: [{ org: 'ndt' }],
  invalid: [{ org: 'NDT' }, {}],
});
export type OrgParams = z.infer<typeof OrgParams>;

export const OpsOrganizationListQuery = named(
  'OpsOrganizationListQuery',
  z.strictObject({ ...pageQueryShape, status: OrganizationStatus.optional(), q: z.string().trim().min(1).max(100).optional() }),
  'GET /ops/organizations query: status filter and search by slug or name',
  { valid: [{}, { status: 'suspended', q: 'nusantara' }], invalid: [{ status: 'deleted' }, { sort: 'slug' }] },
);
export type OpsOrganizationListQuery = z.infer<typeof OpsOrganizationListQuery>;

const EXAMPLE_OPS_ORG = {
  id: '00000000-0000-4000-8000-00000000a001', slug: 'ndt', name: 'PT Nusantara Digital Teknologi', status: 'active',
  licence: { state: 'valid', validUntil: '2027-03-31' }, memberCount: 86, systemCount: 4, plan: 'standard', validUntil: '2027-03-31',
  verifiedDomains: ['nusantaradigital.co.id'], createdAt: '2026-02-01T03:00:00Z',
} as const;

export const OpsOrganizationItem = named(
  'OpsOrganizationItem',
  z.object({
    id: Uuid,
    slug: OrgSlug,
    name: z.string(),
    status: OrganizationStatus,
    licence: z.object({ state: LicenceState, validUntil: IsoDate }).nullable(),
    memberCount: z.int().min(0),
    systemCount: z.int().min(0),
    plan: z.string().nullable(),
    validUntil: IsoDate.nullable(),
    verifiedDomains: z.array(z.string()),
    createdAt: Instant,
  }),
  'Organisation row of the operator console: status, licence state, plan and validity of the entitlement, members, systems, verified domains (Milestone 2 D.1, D.2)',
  {
    valid: [EXAMPLE_OPS_ORG, { ...EXAMPLE_OPS_ORG, status: 'suspended', licence: null, plan: null, validUntil: null, verifiedDomains: [] }],
    invalid: [{ ...EXAMPLE_OPS_ORG, status: 'deleted' }, { ...EXAMPLE_OPS_ORG, memberCount: -1 }],
  },
);
export type OpsOrganizationItem = z.infer<typeof OpsOrganizationItem>;

export const OpsOrganizationCreate = named(
  'OpsOrganizationCreate',
  z.strictObject({
    slug: OrgSlug,
    name: z.string().trim().min(1).max(200),
    timeZone: z.string().trim().min(1).max(64),
    siteCount: z.int().min(0).max(10_000),
    firstAdmin: z.strictObject({ email: z.email().max(254), displayName: z.string().trim().min(1).max(150) }),
    preset: PlanPresetName.optional(),
  }),
  'POST /ops/organizations body: the organisation (slug permanent) and its first administrator, who is invited; preset names a plan of license.plans (Milestone 2 D.2)',
  {
    valid: [
      { slug: 'bank_sentosa', name: 'PT Bank Sentosa', timeZone: 'Asia/Jakarta', siteCount: 3, firstAdmin: { email: 'it.admin@banksentosa.co.id', displayName: 'Andi Wijaya' } },
      { slug: 'klinik_sehat', name: 'Klinik Sehat', timeZone: 'Asia/Makassar', siteCount: 1, firstAdmin: { email: 'admin@kliniksehat.id', displayName: 'Sari Dewi' }, preset: 'trial' },
    ],
    invalid: [
      { slug: 'Bank', name: 'x', timeZone: 'Asia/Jakarta', siteCount: 1, firstAdmin: { email: 'a@b.co', displayName: 'A' } },
      { slug: 'bank_sentosa', name: 'x', timeZone: 'Asia/Jakarta', siteCount: 1 },
      { slug: 'bank_sentosa', name: 'x', timeZone: 'Asia/Jakarta', siteCount: 1, firstAdmin: { email: 'not-mail', displayName: 'A' } },
    ],
  },
);
export type OpsOrganizationCreate = z.infer<typeof OpsOrganizationCreate>;

export const OpsOrganizationCreateResult = named(
  'OpsOrganizationCreateResult',
  commandResultWith(z.object({
    id: Uuid,
    slug: OrgSlug,
    invitationSent: z.boolean(),
    /** Only when mail.required is false and mail is off: the one-time invitation link (never on SaaS). */
    invitationUrl: z.url().optional(),
    /** The entitlement written from `preset` (Milestone 2 D.2, M2-S09); absent without a preset. */
    plan: z.object({ name: z.string().nullable(), validFrom: IsoDate, validUntil: IsoDate.nullable() }).optional(),
  })),
  'Result of POST /ops/organizations: the new organisation, whether the invitation was emailed, and the message that the slug is permanent (Milestone 2 D.2)',
  {
    valid: [
      { ok: true, changed: [], message: ['Organisation created. The slug bank_sentosa cannot be changed.', 'Organisasi dibuat. Slug bank_sentosa tidak dapat diubah.'], data: { id: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e', slug: 'bank_sentosa', invitationSent: true } },
      { ok: true, changed: [], data: { id: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e', slug: 'klinik_sehat', invitationSent: true, plan: { name: 'trial', validFrom: '2026-10-28', validUntil: '2026-11-26' } } },
    ],
    invalid: [{ ok: true, changed: [], data: { slug: 'bank_sentosa' } }],
  },
);
export type OpsOrganizationCreateResult = z.infer<typeof OpsOrganizationCreateResult>;

export const OpsResetMfaRequest = named(
  'OpsResetMfaRequest',
  z.strictObject({ email: z.email().max(254), reason: z.string().trim().min(10).max(500) }),
  'POST /ops/users/reset-mfa body: the account and the reason, recorded with auth.mfa_reset (Milestone 2 D.1)',
  { valid: [{ email: 'rina.kusuma@nusantaradigital.co.id', reason: 'Lost phone, identity checked by video call' }], invalid: [{ email: 'rina', reason: 'Lost phone, identity checked' }, { email: 'a@b.co', reason: 'short' }] },
);
export type OpsResetMfaRequest = z.infer<typeof OpsResetMfaRequest>;

const EXAMPLE_OPS_DETAIL = {
  id: '00000000-0000-4000-8000-00000000a001', slug: 'ndt', name: 'PT Nusantara Digital Teknologi', status: 'active', region: 'id',
  createdAt: '2026-02-01T03:00:00Z', memberCount: 86, systemCount: 4,
  entitlement: { plan: 'standard', source: 'preset', maxUsers: 50, maxManagementSystems: 3, validUntil: '2027-03-31' },
  domains: [{ domain: 'nusantaradigital.co.id', status: 'verified' }], lastSignInAt: '2026-10-27T01:12:00Z',
} as const;

export const OpsOrganizationDetail = named(
  'OpsOrganizationDetail',
  z.object({
    id: Uuid,
    slug: OrgSlug,
    name: z.string(),
    status: OrganizationStatus,
    region: z.string().nullable(),
    createdAt: Instant,
    memberCount: z.int().min(0),
    systemCount: z.int().min(0),
    entitlement: z.object({
      plan: z.string().nullable(), source: EntitlementSource, maxUsers: z.int().min(0), maxManagementSystems: z.int().min(0), validUntil: IsoDate.nullable(),
    }).nullable(),
    domains: z.array(z.object({ domain: z.string(), status: DomainStatus })),
    lastSignInAt: Instant.nullable(),
  }),
  'GET /ops/organizations/{org}: status, region, created date, member count, system count, entitlement summary, domains and last sign-in (Milestone 2 D.1)',
  {
    valid: [EXAMPLE_OPS_DETAIL, { ...EXAMPLE_OPS_DETAIL, status: 'offboarding', region: null, entitlement: null, domains: [], lastSignInAt: null }],
    invalid: [{ ...EXAMPLE_OPS_DETAIL, status: 'paused' }, { ...EXAMPLE_OPS_DETAIL, domains: [{ domain: 'x.id', status: 'ok' }] }],
  },
);
export type OpsOrganizationDetail = z.infer<typeof OpsOrganizationDetail>;

export const OrganizationStatusChange = named(
  'OrganizationStatusChange',
  z.strictObject({ status: OrganizationStatus, reason: z.string().trim().min(3).max(500), confirmSlug: OrgSlug.optional() }),
  'POST /ops/organizations/{org}/status body: the target status of J.8 with a reason; offboarding and archived also need confirmSlug equal to the slug (Milestone 2 D.1, J.8)',
  {
    valid: [{ status: 'suspended', reason: 'Invoice overdue by 60 days' }, { status: 'offboarding', reason: 'Contract ended on 30 Sep 2026', confirmSlug: 'ndt' }],
    invalid: [{ status: 'deleted', reason: 'x'.repeat(10) }, { status: 'suspended' }, { status: 'suspended', reason: 'ok', extra: true }],
  },
);
export type OrganizationStatusChange = z.infer<typeof OrganizationStatusChange>;

const EXAMPLE_STATUS_RESULT = {
  ok: true,
  changed: [],
  message: ['Organisation ndt moved from active to suspended. 12 sessions were ended. 2 of 2 Tenant Admins were emailed.', 'Organisasi ndt dipindahkan dari active ke suspended. 12 sesi diakhiri. 2 dari 2 Tenant Admin dikirimi email.'],
  data: { slug: 'ndt', from: 'active', to: 'suspended', sessionsRevoked: 12, tenantAdmins: 2, tenantAdminsEmailed: 2 },
} as const;

export const OrganizationStatusChangeResult = named(
  'OrganizationStatusChangeResult',
  commandResultWith(z.object({
    slug: OrgSlug,
    from: OrganizationStatus,
    to: OrganizationStatus,
    /** Sessions whose current organisation was this one, ended by `suspended` and `archived` (0 for other moves). */
    sessionsRevoked: z.int().min(0),
    /** Active Tenant Admins of the organisation, who get the `organization_status_changed` notice. */
    tenantAdmins: z.int().min(0),
    /** Tenant Admins whose email went out (fewer than `tenantAdmins` when mail failed). */
    tenantAdminsEmailed: z.int().min(0),
  })),
  'Result of POST /ops/organizations/{org}/status: the move, the sessions it ended and the Tenant Admins told by email (Milestone 2 J.8, K.6)',
  {
    valid: [EXAMPLE_STATUS_RESULT, { ...EXAMPLE_STATUS_RESULT, data: { slug: 'ndt', from: 'suspended', to: 'active', sessionsRevoked: 0, tenantAdmins: 1, tenantAdminsEmailed: 0 } }],
    invalid: [{ ...EXAMPLE_STATUS_RESULT, data: { ...EXAMPLE_STATUS_RESULT.data, to: 'paused' } }, { ok: true, changed: [], data: { slug: 'ndt' } }],
  },
);
export type OrganizationStatusChangeResult = z.infer<typeof OrganizationStatusChangeResult>;

export const OrganizationStatusEventItem = named(
  'OrganizationStatusEventItem',
  z.object({
    id: Uuid,
    from: OrganizationStatus,
    to: OrganizationStatus,
    reason: z.string(),
    actor: z.object({ handle: z.string(), displayName: z.string() }).nullable(),
    at: Instant,
  }),
  'One status change of an organisation (platform.organization_status_event, Milestone 2 D.3)',
  {
    valid: [{ id: '7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a', from: 'active', to: 'suspended', reason: 'Invoice overdue by 60 days', actor: { handle: 'ops.owner', displayName: 'Platform owner' }, at: '2026-10-20T03:00:00Z' }],
    invalid: [{ id: '7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a', from: 'active', to: 'paused', reason: 'x', actor: null, at: '2026-10-20T03:00:00Z' }],
  },
);
export type OrganizationStatusEventItem = z.infer<typeof OrganizationStatusEventItem>;

export const OrganizationEventsQuery = named('OrganizationEventsQuery', z.strictObject(pageQueryShape), 'GET /ops/organizations/{org}/events query (paging)', {
  valid: [{}, { page: '2' }],
  invalid: [{ status: 'active' }],
});
export type OrganizationEventsQuery = z.infer<typeof OrganizationEventsQuery>;

const op = { owner: 'WP-34' as const, auth: 'session' as const, scope: 'platform' as const };

export const opsHealthRoute = defineRoute({ ...op, id: 'ops.health', method: 'GET', path: '/api/v1/ops/health', summary: 'Components, migrations, queues and licence states', permission: 'ops.read', response: OpsHealth, errors: [] });
export const opsQueuesRoute = defineRoute({ ...op, id: 'ops.queues', method: 'GET', path: '/api/v1/ops/queues', summary: 'Queue statistics', permission: 'ops.read', response: z.array(QueueStats), errors: [] });
export const opsJobRunRoute = defineRoute({
  ...op, id: 'ops.jobs.run', method: 'POST', path: '/api/v1/ops/jobs/:name/run', summary: 'Run an allow-listed job now (audited ops.job_run)',
  permission: 'ops.jobs.run', params: JobRunParams, body: JobRunRequest, response: JobRunResponse, status: 202, errors: [404, 409, 422],
});
export const opsDiagnosticsRoute = defineRoute({
  ...op, id: 'ops.diagnostics', method: 'POST', path: '/api/v1/ops/diagnostics',
  summary: 'Diagnostics archive (.tar.gz): profile without secrets, versions, migration state, queue stats, redacted log lines, metrics (audited)',
  permission: 'ops.read', response: BinaryBody, responseType: 'application/gzip', file: true, errors: [],
});

const opM2 = { auth: 'session' as const, scope: 'platform' as const };

export const opsOrganizationsListRoute = defineRoute({
  ...opM2, owner: 'M2-06', id: 'ops.organizations.list', method: 'GET', path: '/api/v1/ops/organizations',
  summary: 'Organisations with status, licence state, plan, member count, systems and verified domains (409 single_tenancy in single tenancy)',
  permission: 'ops.read', query: OpsOrganizationListQuery, response: pageOf(OpsOrganizationItem), errors: [409],
});
export const opsOrganizationsCreateRoute = defineRoute({
  ...opM2, owner: 'M2-06', id: 'ops.organizations.create', method: 'POST', path: '/api/v1/ops/organizations',
  summary: 'Create an organisation with local sign-in allowed and invite its first administrator (409 single_tenancy, 409 mail_required, 409 org_exists; 503 when the storage gateway or the database owner role is unavailable; audited ops.organization_created)',
  permission: 'ops.tenants.manage', body: OpsOrganizationCreate, response: OpsOrganizationCreateResult, status: 201, errors: [409, 422, 503], idempotent: true,
});
export const opsUsersResetMfaRoute = defineRoute({
  ...opM2, owner: 'M2-06', id: 'ops.users.reset-mfa', method: 'POST', path: '/api/v1/ops/users/reset-mfa',
  summary: 'Reset the second factor of an account found by email (404 when it has no factor), ending its sessions and emailing the account (audited auth.mfa_reset with the reason)',
  permission: 'ops.users.manage', body: OpsResetMfaRequest, response: NoBody, status: 204, errors: [404, 422],
});
export const opsOrganizationsGetRoute = defineRoute({
  ...opM2, owner: 'M2-S09', id: 'ops.organizations.get', method: 'GET', path: '/api/v1/ops/organizations/:org',
  summary: 'One organisation: status, region, created date, members, systems, entitlement summary, domains, last sign-in',
  permission: 'ops.read', params: OrgParams, response: OpsOrganizationDetail, errors: [404, 409],
});
export const opsOrganizationsStatusRoute = defineRoute({
  ...opM2, owner: 'M2-S09', id: 'ops.organizations.status', method: 'POST', path: '/api/v1/ops/organizations/:org/status',
  summary:
    'Move the organisation along the status machine of J.8 with a reason (409 transition-not-allowed invalid_status_transition, 422 confirmation_mismatch); suspended and archived end the sessions of the organisation; the Tenant Admins are told by email (audited ops.organization_status_changed)',
  permission: 'ops.tenants.manage', params: OrgParams, body: OrganizationStatusChange, response: OrganizationStatusChangeResult, errors: [404, 409, 422],
});
export const opsOrganizationsEventsRoute = defineRoute({
  ...opM2, owner: 'M2-S09', id: 'ops.organizations.events', method: 'GET', path: '/api/v1/ops/organizations/:org/events',
  summary: 'Status history of the organisation, newest first',
  permission: 'ops.read', params: OrgParams, query: OrganizationEventsQuery, response: pageOf(OrganizationStatusEventItem), errors: [404, 409],
});

export const routes: RouteDef[] = [
  opsHealthRoute, opsQueuesRoute, opsJobRunRoute, opsDiagnosticsRoute,
  opsOrganizationsListRoute, opsOrganizationsCreateRoute, opsUsersResetMfaRoute,
  opsOrganizationsGetRoute, opsOrganizationsStatusRoute, opsOrganizationsEventsRoute,
];
